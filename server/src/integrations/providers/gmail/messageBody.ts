import { GmailError, getGmailConnection, gmailGetForConnection } from "./client";
import type { FetchLike } from "./oauth";

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
  body?: { data?: string; size?: number };
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
  return { text: extractPlainText(raw), snippet };
}
