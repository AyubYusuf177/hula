/**
 * Deterministic email signature completion (Section 16 / Fix 3).
 *
 * A generated professional email that ends with a closing ("Best regards", "Kind
 * regards", …) but no name reads as unfinished. This PURE helper appends the
 * authenticated user's REAL display name beneath such a closing — and only then.
 * It never invents a name, never adds a second signature, and never touches a body
 * that has no closing (so a casual or already-signed message is left exactly as
 * dictated). It is the single source of truth for signing, applied once at the
 * shared draft/send choke point so drafts and sends produce identical bodies.
 */

/**
 * Recognised sign-off closings. Matched case-insensitively against the last
 * non-empty line, tolerating a trailing comma/period/exclamation. Ordered longest
 * phrases first is unnecessary because each alternative is anchored to the whole
 * line.
 */
const CLOSING_RE =
  /^(?:best regards|kind regards|warm regards|warmest regards|kindest regards|best wishes|warm wishes|many thanks|thanks again|thanks so much|thank you|thanks|regards|sincerely|yours sincerely|yours faithfully|yours truly|cheers|all the best|best|warmly|respectfully|talk soon|speak soon)[\s,.!]*$/i;

/** PURE: split into lines and drop trailing blank lines, keeping the rest intact. */
function trimTrailingBlankLines(lines: string[]): string[] {
  const out = [...lines];
  while (out.length > 0 && out[out.length - 1]!.trim().length === 0) out.pop();
  return out;
}

/**
 * PURE: does the body already carry the user's name (so signing again would
 * duplicate it)? A conservative whole-name, case-insensitive substring check —
 * enough to catch a dictated "…, Ayub Yusuf" or an existing signature without
 * risking a false append.
 */
function alreadyContainsName(body: string, name: string): boolean {
  return body.toLowerCase().includes(name.toLowerCase());
}

/**
 * PURE: append the display name beneath a trailing closing, when appropriate.
 *
 * Returns the body UNCHANGED when any of these hold:
 *  - no display name is known (never invent one);
 *  - the body is empty/whitespace;
 *  - the body already contains the name (dictated or already signed);
 *  - the last non-empty line is NOT a recognised closing (nothing to complete);
 *  - the closing already has a following name line (a complete signature).
 *
 * Otherwise it returns the body with the name added under the closing, matching the
 * conventional "Best regards,\n\nAyub Yusuf" shape.
 */
export function ensureSignature(
  body: string,
  displayName: string | null | undefined,
): string {
  const name = (displayName ?? "").trim();
  if (!name) return body;
  if (body.trim().length === 0) return body;
  if (alreadyContainsName(body, name)) return body;

  const lines = trimTrailingBlankLines(body.split(/\r?\n/));
  if (lines.length === 0) return body;

  const lastLine = lines[lines.length - 1]!.trim();
  if (!CLOSING_RE.test(lastLine)) return body;

  // The closing is the final line and the name isn't present — complete it.
  const trimmedBody = lines.join("\n");
  return `${trimmedBody}\n\n${name}`;
}
