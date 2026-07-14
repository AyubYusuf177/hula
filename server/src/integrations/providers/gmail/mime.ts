/**
 * Pure RFC-2822 MIME builder for Gmail sends/drafts (Section 16).
 *
 * The ONLY place a raw email message is assembled. It is PURE (no I/O, no token,
 * no network) and independently unit-tested. It produces a plain-text UTF-8
 * message and the base64url encoding Gmail's API requires, with hard protection
 * against header injection. It NEVER builds CC/BCC, attachments, or HTML — only
 * the safe, approved Section 16 surface.
 */

/** A safe error for MIME assembly (e.g. header injection, bad recipient). */
export class MimeError extends Error {
  reason: "header_injection" | "invalid_recipient" | "empty_body";
  constructor(reason: MimeError["reason"], message?: string) {
    super(message ?? reason);
    this.name = "MimeError";
    this.reason = reason;
  }
}

/**
 * PURE: strict-enough email address validation. Deliberately conservative — one
 * `@`, a non-empty local part, and a dotted domain with no whitespace or control
 * characters. It rejects display-name forms; callers pass a bare address here.
 */
export function isValidEmailAddress(value: string | null | undefined): boolean {
  const v = (value ?? "").trim();
  if (v.length === 0 || v.length > 320) return false;
  // No CR/LF/controls or angle brackets — a bare addr-spec only.
  // eslint-disable-next-line no-control-regex
  if (/[\r\n\t\x00-\x1f<>]/.test(v)) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

/**
 * PURE: reject any header VALUE that could inject a new header/line. RFC-2822
 * headers are CRLF-delimited, so a raw CR or LF in a value is an injection. This
 * is the last line of defence — extraction already trims, but a send must never
 * emit a value carrying a newline.
 */
export function assertNoHeaderInjection(value: string): void {
  if (/[\r\n]/.test(value)) {
    throw new MimeError("header_injection", "Header value contains a line break");
  }
}

/** PURE: is a string pure 7-bit ASCII (so it needs no MIME word encoding)? */
function isAscii(value: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /^[\x00-\x7f]*$/.test(value);
}

/**
 * PURE: encode a header value as an RFC-2047 "encoded-word" when it contains any
 * non-ASCII character, so Unicode subjects/names survive intact. ASCII values are
 * returned unchanged. The input must already be newline-free (see
 * `assertNoHeaderInjection`).
 */
export function encodeHeaderWord(value: string): string {
  if (isAscii(value)) return value;
  const b64 = Buffer.from(value, "utf8").toString("base64");
  return `=?UTF-8?B?${b64}?=`;
}

/** PURE: URL-safe base64 (Gmail's `raw` field), no padding — accepted by Gmail. */
export function toBase64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

/**
 * PURE: build a de-duplicated `Re:` subject. An existing `Re:` (any case, with or
 * without whitespace) is preserved rather than stacked, so replies never become
 * "Re: Re: Re:". A missing/blank original becomes a bare "Re:".
 */
export function buildReplySubject(originalSubject: string | null | undefined): string {
  const s = (originalSubject ?? "").trim();
  if (s.length === 0) return "Re:";
  if (/^re\s*:/i.test(s)) return s;
  return `Re: ${s}`;
}

/** The safe fields a message may carry. No CC/BCC/attachments/HTML — ever. */
export interface MimeMessageFields {
  /** A single bare recipient address (validated). */
  to: string;
  /** The subject line (may be empty for a reply that keeps the thread subject). */
  subject: string;
  /** The plain-text body (UTF-8). Required and non-empty. */
  body: string;
  /** Reply threading: the matched message's `Message-ID`. */
  inReplyTo?: string | null;
  /** Reply threading: the `References` chain to preserve/extend. */
  references?: string | null;
}

/**
 * PURE: assemble a complete RFC-2822 message as a string.
 *
 * Emits: To, Subject (RFC-2047 encoded when non-ASCII), MIME-Version, a
 * `text/plain; charset="UTF-8"` Content-Type, and `Content-Transfer-Encoding:
 * base64` with the body base64-encoded in fixed 76-char lines (so arbitrary
 * Unicode and long lines are always transported safely). For replies it adds
 * `In-Reply-To` and `References`. Throws `MimeError` on an invalid recipient,
 * a header-injection attempt, or an empty body — a send/draft must never proceed
 * with a malformed message.
 */
export function buildMimeMessage(fields: MimeMessageFields): string {
  const to = (fields.to ?? "").trim();
  if (!isValidEmailAddress(to)) {
    throw new MimeError("invalid_recipient", "Recipient is not a valid email address");
  }
  const subject = (fields.subject ?? "").trim();
  const body = fields.body ?? "";
  if (body.trim().length === 0) {
    throw new MimeError("empty_body", "Message body is empty");
  }

  // Every header value must be newline-free before it is emitted.
  assertNoHeaderInjection(to);
  assertNoHeaderInjection(subject);

  const headers: string[] = [];
  headers.push(`To: ${to}`);
  headers.push(`Subject: ${encodeHeaderWord(subject)}`);

  if (fields.inReplyTo) {
    const inReplyTo = fields.inReplyTo.trim();
    assertNoHeaderInjection(inReplyTo);
    headers.push(`In-Reply-To: ${inReplyTo}`);
  }
  if (fields.references) {
    const references = fields.references.trim();
    assertNoHeaderInjection(references);
    headers.push(`References: ${references}`);
  }

  headers.push("MIME-Version: 1.0");
  headers.push('Content-Type: text/plain; charset="UTF-8"');
  headers.push("Content-Transfer-Encoding: base64");

  // Base64-encode the UTF-8 body, wrapped at 76 chars per RFC-2045.
  const encoded = Buffer.from(body, "utf8").toString("base64");
  const wrapped = encoded.replace(/.{1,76}/g, "$&\r\n").trimEnd();

  return `${headers.join("\r\n")}\r\n\r\n${wrapped}`;
}

/**
 * PURE: build the exact Gmail API `raw` payload (`{ raw }`, plus `threadId` for a
 * reply) from message fields. This is the single object a draft/send request
 * sends, so the confirmed preview and the wire payload are built from one source.
 */
export function buildGmailRawPayload(
  fields: MimeMessageFields,
  threadId?: string | null,
): { raw: string; threadId?: string } {
  const raw = toBase64Url(buildMimeMessage(fields));
  return threadId ? { raw, threadId } : { raw };
}
