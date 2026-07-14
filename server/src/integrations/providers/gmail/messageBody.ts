import { GmailError, getGmailConnection, gmailGetForConnection } from "./client";
import type { FetchLike } from "./oauth";
import type { GmailAttachmentMeta } from "./types";

/**
 * Single-message body retrieval (Section 16 / Fix 4) — READ-ONLY.
 *
 * The recent-inbox reads (`messages.ts`) are deliberately metadata-only. But when
 * the user EXPLICITLY asks Hula to read or summarise ONE named email ("what does
 * Rob's latest email say?"), we must fetch that one message's actual text so the
 * answer is grounded in the real body and never hallucinated. The body is used
 * transiently to build one reply and is NEVER persisted or logged. Nothing here
 * runs unless the user asked to read a specific message.
 */

/** The raw shape (subset) of a Gmail `messages.get` (format=full) payload. */
interface RawFullPart {
  mimeType?: string;
  filename?: string;
  body?: { data?: string; size?: number; attachmentId?: string };
  parts?: RawFullPart[];
}
interface RawFullMessage {
  id?: string;
  snippet?: string;
  payload?: RawFullPart;
}

/** The safe, transient result of reading one message body. */
export interface GmailMessageBody {
  /** The extracted plain-text body (best-effort), or "" when none could be read. */
  text: string;
  /** Gmail's own short snippet — a safe fallback when the body can't be extracted. */
  snippet: string;
  /**
   * Safe METADATA about the message's attachments (Section 17 / Phase 3.6) —
   * filename, MIME type, size. Never the content: nothing here downloads an
   * attachment, and the bytes are never fetched, stored, or shown to the model.
   */
  attachments: GmailAttachmentMeta[];
}

/** Cap on attachments we ever report for one message. */
const MAX_ATTACHMENTS = 10;
/** Cap on a displayed filename (they are attacker-controlled). */
const MAX_FILENAME = 100;

/**
 * PURE: sanitise an attachment filename for display.
 *
 * A filename is chosen by whoever sent the mail, so it is untrusted input in the
 * same way a body is: it can carry newlines to forge extra output lines, control
 * characters, or a fake instruction. Strip those and bound the length.
 */
export function sanitizeAttachmentName(name: string): string {
  const cleaned = (name ?? "")
    .normalize("NFC")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "(unnamed)";
  return cleaned.length <= MAX_FILENAME
    ? cleaned
    : `${cleaned.slice(0, MAX_FILENAME).trimEnd()}…`;
}

/**
 * PURE: collect attachment metadata from a raw full message.
 *
 * Gmail marks an attachment part by a non-empty `filename`; inline body parts
 * (text/plain, text/html) have none, so they are correctly excluded. Walks nested
 * multiparts, since real mail nests (multipart/mixed > multipart/alternative > …).
 */
export function extractAttachments(raw: RawFullMessage): GmailAttachmentMeta[] {
  const out: GmailAttachmentMeta[] = [];
  const walk = (part: RawFullPart | undefined): void => {
    if (!part || out.length >= MAX_ATTACHMENTS) return;
    const filename = (part.filename ?? "").trim();
    if (filename) {
      out.push({
        filename: sanitizeAttachmentName(filename),
        mimeType: sanitizeAttachmentName(part.mimeType ?? "application/octet-stream"),
        sizeBytes:
          typeof part.body?.size === "number" && part.body.size >= 0 ? part.body.size : null,
      });
      return;
    }
    for (const child of part.parts ?? []) walk(child);
  };
  walk(raw.payload);
  return out;
}

/** PURE: decode a Gmail base64url part payload to UTF-8 text. */
function decodePart(data: string | undefined): string {
  if (!data) return "";
  try {
    return Buffer.from(data, "base64url").toString("utf8");
  } catch {
    return "";
  }
}

/** PURE: crudely strip HTML tags + collapse whitespace for a text/html fallback. */
function htmlToText(html: string): string {
  return html
    .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/** PURE: find the first part matching a mime type, walking nested multiparts. */
function findPart(part: RawFullPart | undefined, mime: string): RawFullPart | null {
  if (!part) return null;
  if ((part.mimeType ?? "").toLowerCase() === mime) return part;
  for (const child of part.parts ?? []) {
    const found = findPart(child, mime);
    if (found) return found;
  }
  return null;
}

/**
 * PURE: extract the best plain-text body from a raw full message. Prefers a real
 * `text/plain` part, then a stripped `text/html` part, then the top-level body.
 * Returns "" when nothing usable is present (the caller falls back to the snippet).
 */
export function extractPlainText(raw: RawFullMessage): string {
  const payload = raw.payload;
  const plain = findPart(payload, "text/plain");
  if (plain?.body?.data) {
    const text = decodePart(plain.body.data).trim();
    if (text) return text;
  }
  const html = findPart(payload, "text/html");
  if (html?.body?.data) {
    const text = htmlToText(decodePart(html.body.data));
    if (text) return text;
  }
  if (payload?.body?.data) {
    const mime = (payload.mimeType ?? "").toLowerCase();
    const decoded = decodePart(payload.body.data);
    const text = mime === "text/html" ? htmlToText(decoded) : decoded.trim();
    if (text) return text;
  }
  return "";
}

/**
 * The markers that begin a QUOTED REPLY CHAIN. Everything from the first one on is
 * older mail the user has already seen.
 */
const QUOTE_MARKERS: readonly RegExp[] = [
  // "On Mon, 14 Jul 2026 at 14:02, Olha <olha@example.com> wrote:"
  /^\s*on\b.{0,300}\bwrote:\s*$/i,
  /^\s*-{2,}\s*original message\s*-{2,}/i,
  /^\s*-{2,}\s*forwarded message\s*-{2,}/i,
  // Outlook's divider rule.
  /^\s*_{5,}\s*$/,
  /^\s*>{1,}\s?/,
];

/** PURE: is this the start of an Outlook-style quoted header block? */
function isQuotedHeaderBlock(lines: readonly string[], index: number): boolean {
  if (!/^\s*from:\s*\S/i.test(lines[index] ?? "")) return false;
  // A bare "From:" line is only a quote marker when the rest of the header follows;
  // otherwise it is ordinary prose ("From: me, thanks!").
  for (const next of lines.slice(index + 1, index + 4)) {
    if (/^\s*(sent|date|to|subject|cc):\s*\S/i.test(next)) return true;
  }
  return false;
}

/**
 * PURE: drop the quoted reply history from a body, keeping the newest message.
 *
 * Grounding a summary in a whole thread is how "Olha says the sandbox is ready" turns
 * into a summary of a three-week-old message underneath it. Real mail top-posts, so
 * the newest content sits ABOVE the first quote marker.
 *
 * Deliberately conservative: if stripping would leave nothing (a bottom-posted reply,
 * or a body that is entirely quoted), the ORIGINAL is returned. Losing the real
 * content is a worse failure than summarising a little extra.
 */
export function stripQuotedReply(text: string): string {
  const raw = (text ?? "").replace(/\r\n/g, "\n");
  if (!raw.trim()) return "";

  const lines = raw.split("\n");
  const startsQuote = (i: number): boolean => {
    const line = lines[i] ?? "";
    // "From:" is only a marker as part of a full quoted header block.
    if (/^\s*from:\s*\S/i.test(line)) return isQuotedHeaderBlock(lines, i);
    return QUOTE_MARKERS.some((re) => re.test(line));
  };

  let cut = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (startsQuote(i)) {
      cut = i;
      break;
    }
  }
  if (cut === -1) return raw.trim();

  const kept = lines.slice(0, cut).join("\n").trim();
  // Nothing above the quote -> this is not history, it IS the message.
  return kept ? kept : raw.trim();
}

/**
 * Fetch ONE message's body (format=full) for an explicit read/summarise request.
 * Read-only; throws a classified `GmailError` (e.g. `not_connected`) on failure so
 * the caller degrades honestly. Returns the extracted plain text plus Gmail's
 * snippet as a safe fallback. The body is transient — never stored or logged.
 */
export async function fetchGmailMessageBody(
  userId: string,
  messageId: string,
  fetchImpl?: FetchLike,
): Promise<GmailMessageBody> {
  const connection = await getGmailConnection(userId);
  if (!connection || connection.status !== "connected") {
    throw new GmailError("not_connected", "Gmail is not connected");
  }
  const raw = await gmailGetForConnection<RawFullMessage>(
    connection.id,
    `/users/me/messages/${encodeURIComponent(messageId)}`,
    { format: "full" },
    fetchImpl,
  );
  const snippet = typeof raw.snippet === "string" ? raw.snippet : "";
  return {
    text: extractPlainText(raw),
    snippet,
    attachments: extractAttachments(raw),
  };
}
