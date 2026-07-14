/**
 * Gmail SUMMARY TEXT shaping (Section 17 real-device fix) — PURE, no I/O.
 *
 * The shipped failure: a grounded, complete model summary was rendered through the
 * SNIPPET formatter, which hard-sliced it at 90 characters and appended an ellipsis.
 * Real users saw "...inviting the recipient to conn…" and "...the sandbox (which is…".
 *
 * A raw Gmail snippet is a fragment already, so slicing one costs nothing. A summary
 * is PROSE we generated, and cutting prose mid-word turns a good answer into a broken
 * one. So summaries are bounded by DROPPING WHOLE SENTENCES, never by cutting
 * characters: what survives is always something a person could read aloud.
 *
 * Bounded is still non-negotiable (iMessage, and cost): the budget is enforced here,
 * and the summariser is additionally given a word budget so it rarely binds.
 */

/**
 * Abbreviations whose full stop is NOT a sentence boundary. Without this, "Olha, a CS
 * Manager at Loop Inc. explains..." would split into two half-sentences and the
 * second half would be dropped as junk.
 */
const ABBREVIATIONS = new Set([
  "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st", "vs", "etc", "inc", "ltd", "co",
  "corp", "dept", "est", "fig", "approx", "no", "e.g", "i.e", "a.m", "p.m", "u.s", "u.k",
]);

/** PURE: is the token before this full stop an abbreviation or an initial ("J.")? */
function endsOnAbbreviation(text: string): boolean {
  const bare = text.replace(/["'”’)\]]+$/, "");
  if (!bare.endsWith(".")) return false;
  const token = /([\p{L}.]+)\.$/u.exec(bare)?.[1]?.toLowerCase();
  if (!token) return false;
  // A single letter is an initial ("Olha J. Ivasiuk"), never a sentence end.
  if (token.length === 1) return true;
  return ABBREVIATIONS.has(token) || ABBREVIATIONS.has(token.replace(/\.$/, ""));
}

/**
 * PURE: is this a whole, finished sentence?
 *
 * Two rules, and deliberately only two:
 *  - It must end with real terminal punctuation. A cut sentence has none — "(which is"
 *    and "to conn" both fail here, and so does every dangling construction, without
 *    needing to know which words may end a sentence.
 *  - An ellipsis is rejected outright: it means "there was more".
 *
 * There is NO list of words that "cannot end a sentence". The first version had one,
 * and it rejected "Training will contact you." because it ended in "you" — a real
 * summary thrown away by a rule that looked clever and was simply wrong. Punctuation
 * already carries this information; the word does not.
 */
export function endsWithCompleteSentence(text: string): boolean {
  const t = (text ?? "").trim();
  if (!t) return false;
  if (/(?:…|\.\.\.)\s*["'”’)\]]*$/.test(t)) return false;
  return /[.!?]\s*["'”’)\]]*$/.test(t);
}

/**
 * PURE: split prose into sentences, keeping their punctuation.
 *
 * Splits only on terminal punctuation followed by whitespace, so decimals ("3.5") and
 * abbreviations stay intact.
 */
export function splitSentences(text: string): string[] {
  const t = (text ?? "").trim();
  if (!t) return [];

  const out: string[] = [];
  let start = 0;
  const boundary = /[.!?…]+["'”’)\]]*(?=\s)/g;
  let match: RegExpExecArray | null;
  while ((match = boundary.exec(t)) !== null) {
    const end = match.index + match[0].length;
    const candidate = t.slice(start, end).trim();
    if (!candidate || endsOnAbbreviation(candidate)) continue;
    out.push(candidate);
    start = end;
  }
  const tail = t.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}

/**
 * PURE: bound prose to `maxChars` by keeping only WHOLE sentences.
 *
 * Returns "" when nothing usable survives — an honest "couldn't summarise" beats a
 * mangled half-sentence. A first sentence that alone blows past the budget is kept
 * only while it stays under a hard ceiling, so output is bounded either way and the
 * character slice that caused the live bug never happens.
 */
export function clampToCompleteSentences(text: string, maxChars: number): string {
  // Unpunctuated text is DROPPED, never finished with an added full stop. "All good"
  // and "inviting the recipient to conn" are indistinguishable from here, and putting
  // a full stop on the second one would fabricate exactly the completeness this
  // module exists to guarantee. The summariser is told to punctuate instead.
  const usable = splitSentences(text).filter((s) => endsWithCompleteSentence(s));
  if (usable.length === 0) return "";

  const hardCeiling = Math.ceil(maxChars * 1.5);
  const kept: string[] = [];
  let length = 0;
  for (const sentence of usable) {
    const cost = kept.length === 0 ? sentence.length : sentence.length + 1;
    if (kept.length > 0 && length + cost > maxChars) break;
    if (kept.length === 0 && sentence.length > maxChars) {
      // One over-long sentence: keep it whole if it is merely long, else give up.
      return sentence.length <= hardCeiling ? sentence : "";
    }
    kept.push(sentence);
    length += cost;
  }
  return kept.join(" ");
}
