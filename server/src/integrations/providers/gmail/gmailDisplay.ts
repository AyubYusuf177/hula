import { clampToCompleteSentences } from "./gmailSummaryText";
import type { NormalizedGmailMessage } from "./types";

/**
 * Gmail DISPLAY formatting (Section 17 fix) — iMessage text only.
 *
 * Real-device testing showed the list output was unreadable: a wall of raw
 * metadata, and HTML entities rendered literally ("Don&#39;t"). Gmail's `snippet`
 * is HTML-ESCAPED, so it must be decoded before display — but the sender name,
 * subject, and snippet are all attacker-controlled, so decoding has to be narrow
 * and the result re-sanitised.
 *
 * Order matters and is deliberate: decode a small allowlist of entities FIRST, then
 * strip control characters and newlines. Doing it the other way round would let
 * `&#10;` survive decoding and forge a new line in the reply.
 *
 * Two KINDS of text pass through here, and they are bounded differently:
 *  - METADATA (sender, subject, Gmail's snippet) is a label. It is already a
 *    fragment, so a length cap ending in "…" is honest — but the cut lands on a word
 *    boundary, never inside a word.
 *  - PROSE we generated (a grounded summary, an action line) is a finished thought.
 *    It is bounded by dropping WHOLE SENTENCES (see `gmailSummaryText`). Slicing it
 *    at 90 characters is exactly the bug this fix removes.
 *
 * Output is PLAIN TEXT for iMessage. Nothing here renders HTML, so a decoded `<`
 * is inert punctuation, not markup.
 */

/** Max characters of a raw snippet line shown per email. */
const PREVIEW_MAX = 90;
/** Max characters of a displayed sender/subject. */
const SENDER_MAX = 60;
const SUBJECT_MAX = 80;
/** Sentence budget for a grounded summary line inside a numbered list. */
export const SUMMARY_LINE_MAX = 260;
/** Sentence budget for an "Action:" line. */
export const ACTION_LINE_MAX = 160;

/** The only NAMED entities we decode. Anything else is left as literal text. */
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  rsquo: "’",
  lsquo: "‘",
  ldquo: "“",
  rdquo: "”",
};

/**
 * PURE: decode a NARROW allowlist of HTML entities for display.
 *
 * Numeric entities are decoded only when they resolve to a safe printable
 * character — a numeric escape for a control character or newline (`&#10;`,
 * `&#0;`) is dropped rather than decoded, because the whole point of decoding here
 * is display, and a control character can only ever corrupt the output.
 *
 * Deliberately does NOT handle the full entity set: this is a display nicety, not
 * an HTML parser, and a narrow allowlist cannot be surprised.
 */
export function decodeSafeEntities(text: string): string {
  return (text ?? "")
    .replace(/&#(\d{1,7});/g, (_m, dec: string) => {
      const code = Number(dec);
      return isSafeCodePoint(code) ? String.fromCodePoint(code) : "";
    })
    .replace(/&#[xX]([0-9a-fA-F]{1,6});/g, (_m, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return isSafeCodePoint(code) ? String.fromCodePoint(code) : "";
    })
    .replace(/&([a-zA-Z]{2,8});/g, (m, name: string) => {
      const decoded = NAMED_ENTITIES[name.toLowerCase()];
      return decoded !== undefined ? decoded : m;
    });
}

/** PURE: is a code point safe to render as plain text? */
function isSafeCodePoint(code: number): boolean {
  if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return false;
  // C0 controls (incl. newline/tab) and DEL + C1 controls.
  if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return false;
  return true;
}

/**
 * PURE: make any provider-supplied string safe to show in an iMessage reply, with NO
 * length cap.
 *
 * Decodes entities, then strips control characters and collapses all whitespace to
 * single spaces — so a crafted subject cannot forge extra list lines or fake a
 * "1." entry that looks like one of our own results.
 *
 * Bounding is a SEPARATE decision from sanitising, because the right bound depends on
 * whether the text is a label or a sentence. Conflating the two is what truncated
 * real summaries mid-word.
 */
export function sanitizeText(text: string | null | undefined): string {
  const decoded = decodeSafeEntities((text ?? "").normalize("NFC"));
  return decoded
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F-\u009F]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * PURE: bound a LABEL to `max` characters, cutting on a word boundary.
 *
 * Only for metadata (sender, subject, Gmail's snippet), where a trailing "…" is
 * honest because the text was never a complete thought. Never for a summary. An
 * unbroken run with no boundary in range (a URL, a hash) is cut where it must be.
 */
export function truncateAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const window = text.slice(0, max);
  // The cut already lands between words — no word is broken, so keep all of them.
  if (/\s/.test(text.charAt(max))) return `${window.trimEnd()}…`;
  const lastSpace = window.lastIndexOf(" ");
  // A hard cut only for an unbroken run with no usable boundary (a URL, a hash):
  // there is no word there to preserve, and honouring a boundary near the very start
  // would collapse the label to nothing.
  const cut = lastSpace >= Math.floor(max * 0.4) ? window.slice(0, lastSpace) : window;
  return `${cut.trimEnd()}…`;
}

/** PURE: sanitise and bound a LABEL. See `sanitizeText` and `truncateAtWord`. */
export function sanitizeDisplay(text: string | null | undefined, max: number): string {
  const cleaned = sanitizeText(text);
  if (!cleaned) return "";
  return truncateAtWord(cleaned, max);
}

/**
 * PURE: sanitise and bound PROSE (a grounded summary, an action line).
 *
 * Bounded by whole SENTENCES, so the result always ends as a finished thought.
 * Returns "" when nothing complete survives — the caller then says so honestly
 * rather than printing a fragment.
 */
export function sanitizeSummaryText(text: string | null | undefined, max: number): string {
  return clampToCompleteSentences(sanitizeText(text), max);
}

/** PURE: the sender's display name, else their address, else a stub. */
export function displaySender(msg: NormalizedGmailMessage): string {
  const name = sanitizeDisplay(msg.fromName, SENDER_MAX);
  if (name) return name;
  const addr = sanitizeDisplay(msg.fromAddress, SENDER_MAX);
  return addr || "Unknown sender";
}

/**
 * PURE: a clean subject — collapses repeated reply prefixes ("Re: Re: X" -> "Re: X")
 * for display only. Never touches thread metadata.
 */
export function displaySubject(msg: NormalizedGmailMessage): string {
  let s = sanitizeDisplay(msg.subject, SUBJECT_MAX);
  if (!s) return "(no subject)";
  let prev: string;
  do {
    prev = s;
    s = s.replace(/^(re|fwd|fw)\s*:\s*(?=\1\s*:)/i, "");
  } while (s !== prev);
  return s;
}

/** PURE: a short, decoded preview line. Never a full body. */
export function displayPreview(snippet: string | null | undefined): string {
  return sanitizeDisplay(snippet, PREVIEW_MAX);
}

/** PURE: local Y-M-D of an instant in a timezone. */
function localDateKey(date: Date, tz: string | undefined): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: tz ?? "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

/** A resolved instant, split so both timestamp styles are built from one source. */
interface WhenParts {
  /** "Today" / "Yesterday" / "Mon 7 Jul". */
  day: string;
  /** "11:37 AM". */
  clock: string;
  relative: boolean;
}

/** PURE: resolve an instant into display parts, or null when unknown/invalid. */
function whenParts(
  receivedAt: string | null | undefined,
  tz: string | undefined,
  now: Date,
): WhenParts | null {
  if (!receivedAt) return null;
  const when = new Date(receivedAt);
  if (Number.isNaN(when.getTime())) return null;

  let clock = "";
  try {
    clock = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "numeric",
      minute: "2-digit",
    }).format(when);
  } catch {
    return null;
  }

  const day = localDateKey(when, tz);
  if (day === localDateKey(now, tz)) return { day: "Today", clock, relative: true };
  if (day === localDateKey(new Date(now.getTime() - 86_400_000), tz)) {
    return { day: "Yesterday", clock, relative: true };
  }

  let datePart = day;
  try {
    datePart = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      weekday: "short",
      day: "numeric",
      month: "short",
    }).format(when);
  } catch {
    datePart = day;
  }
  return { day: datePart, clock, relative: false };
}

/**
 * PURE: a human timestamp — "Today, 11:37 AM" / "Yesterday, 9:03 AM" /
 * "Mon 7 Jul, 9:03 AM". Returns "" when the time is unknown, so callers omit the
 * line rather than print a placeholder.
 */
export function displayWhen(
  receivedAt: string | null | undefined,
  tz: string | undefined,
  now: Date,
): string {
  const parts = whenParts(receivedAt, tz, now);
  return parts ? `${parts.day}, ${parts.clock}` : "";
}

/**
 * PURE: the sentence-shaped timestamp used when ONE email is the whole reply —
 * "Received today at 2:02 PM". Reads as prose, where the terse list form
 * ("Today, 2:02 PM") reads as a column. "" when the time is unknown.
 */
export function displayReceived(
  receivedAt: string | null | undefined,
  tz: string | undefined,
  now: Date,
): string {
  const parts = whenParts(receivedAt, tz, now);
  if (!parts) return "";
  const day = parts.relative ? parts.day.toLowerCase() : parts.day;
  return `Received ${day} at ${parts.clock}`;
}

/**
 * PURE: the status flags worth showing. Deliberately sparse — "Read" and "Not
 * starred" are noise, so only the states that tell the user something appear.
 */
export function displayFlags(
  msg: NormalizedGmailMessage,
  opts: { hasAttachments?: boolean } = {},
): string[] {
  const flags: string[] = [];
  if (msg.unread) flags.push("Unread");
  if (msg.labels.includes("STARRED")) flags.push("Starred");
  if (opts.hasAttachments) flags.push("Attachment");
  return flags;
}

/** One entry to render. */
export interface EmailListItem {
  message: NormalizedGmailMessage;
  /**
   * A grounded summary of this email — PROSE, bounded by whole sentences. When
   * absent, the entry falls back to Gmail's own snippet — never to invented text.
   */
  preview?: string;
  hasAttachments?: boolean;
  /** An optional "Action: …" line. Only ever set when the email supports one. */
  action?: string;
}

/**
 * PURE: format ONE numbered email entry.
 *
 *   1. Robert Ellis — Re: ICTS Job Offer
 *      Today, 11:37 AM · Unread
 *      Training will contact you with the next steps.
 *
 * No ids, no raw metadata, no duplicated information.
 */
export function formatEmailListItem(
  index: number,
  item: EmailListItem,
  tz: string | undefined,
  now: Date,
): string {
  const { message } = item;
  const lines = [`${index}. ${displaySender(message)} — ${displaySubject(message)}`];

  const when = displayWhen(message.receivedAt, tz, now);
  const flags = displayFlags(message, { hasAttachments: item.hasAttachments });
  const meta = [when, ...flags].filter(Boolean).join(" · ");
  if (meta) lines.push(`   ${meta}`);

  // A supplied preview is a summary WE wrote: bound it by sentences. Only Gmail's own
  // snippet — a fragment already — is length-capped.
  const preview = item.preview
    ? sanitizeSummaryText(item.preview, SUMMARY_LINE_MAX)
    : displayPreview(message.snippet);
  if (preview) lines.push(`   ${preview}`);

  // Kept on its own line so a suggested action is never mistaken for a fact from
  // the email itself.
  const action = sanitizeSummaryText(item.action, ACTION_LINE_MAX);
  if (action) lines.push(`   Action: ${action}`);

  return lines.join("\n");
}

/**
 * PURE: format a numbered list of emails, separated by a blank line so it reads as
 * distinct items rather than a wall of text.
 */
export function formatEmailList(
  items: readonly EmailListItem[],
  tz: string | undefined,
  now: Date,
): string {
  return items.map((item, i) => formatEmailListItem(i + 1, item, tz, now)).join("\n\n");
}
