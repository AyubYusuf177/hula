/**
 * Operational-honesty boundary for generic brain output (Section 16).
 *
 * NON-NEGOTIABLE INVARIANT: no external action may be reported as completed unless
 * deterministic action code holds a validated provider receipt. The generic brain
 * (Anthropic) never holds a receipt and never performs an action, so any
 * completion claim it produces ("Reply sent to …", "I've added that to your
 * calendar") is a FABRICATION.
 *
 * The routing layer already keeps recognised action-like messages away from the
 * brain, and the system prompt forbids these claims — but a prompt is not a
 * boundary. This PURE guard is the deterministic backstop: it scans the brain's
 * final text and, if it detects a first-person / headline operational-success
 * claim, replaces the whole reply with an honest one. Deterministic handlers
 * (which DO carry receipts) never pass through here, so a genuine "Draft sent to
 * Rob." from the executor is unaffected.
 */

/** The honest reply substituted when the brain fabricates an action success. */
export const BLOCKED_BRAIN_REPLY =
  "I can’t confirm that actually happened, so I won’t say it’s done. Want me to take care of it properly?";

/**
 * Completion-claim patterns. Each targets a clear "I did an external action"
 * statement, kept tight so ordinary help ("I can draft that", "I'll send it once
 * you confirm", "check your Sent folder") is NOT matched.
 */
const FABRICATION_PATTERNS: readonly RegExp[] = [
  // "Reply/Email/Message/Draft (has been/was/is) sent [to …]" — the live failure.
  /\b(?:reply|e-?mail|message|draft|it|that)\s+(?:has been\s+|have been\s+|was\s+|is\s+|is now\s+)?sent\b/i,
  // "I('ve) (just) sent the/your/that/a reply/the draft/the email …"
  /\bi(?:'ve| have)?\s+(?:just\s+)?sent\s+(?:the|your|that|it|an?|a reply|the reply|the draft|the email|your email)\b/i,
  // "(I've) emailed/forwarded (the/your/that/it/them) …"
  /\bi(?:'ve| have)?\s+(?:just\s+)?(?:emailed|forwarded)\s+(?:the|your|that|it|them|him|her)\b/i,
  // First-person calendar/reminder completions (past tense only).
  /\bi(?:'ve| have)?\s+(?:just\s+)?(?:created|scheduled|booked|added|deleted|cancelled|canceled|moved|rescheduled|set up)\s+(?:the|your|a|an|that)\s+(?:event|meeting|appointment|reminder|calendar\s+event|call)\b/i,
  // Headline calendar/reminder completions.
  /\badded\s+(?:it|that|them)\s+to\s+your\s+calendar\b/i,
  /\b(?:your\s+)?reminder\s+(?:has been\s+|is\s+|was\s+|is now\s+)set\b/i,
  /\byour\s+(?:event|meeting|appointment|reminder)\s+(?:has been|is|was|is now)\s+(?:created|set|scheduled|added|booked|deleted|cancelled|canceled)\b/i,
];

/**
 * PURE: does this text contain a fabricated external-action success claim? True
 * means the brain claimed something was sent/created/deleted etc. with no receipt.
 */
export function containsFabricatedActionSuccess(text: string | undefined): boolean {
  const t = (text ?? "").trim();
  if (!t) return false;
  return FABRICATION_PATTERNS.some((re) => re.test(t));
}

/**
 * PURE: sanitise a brain reply. When it fabricates an action success, returns the
 * honest replacement and `blocked: true`; otherwise returns the reply unchanged.
 */
export function sanitizeBrainReply(text: string): { text: string; blocked: boolean } {
  if (containsFabricatedActionSuccess(text)) {
    return { text: BLOCKED_BRAIN_REPLY, blocked: true };
  }
  return { text, blocked: false };
}
