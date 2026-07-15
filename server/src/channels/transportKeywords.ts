/**
 * Carrier/transport-reserved keyword handling — ALL PURE except the handler.
 *
 * THE REAL FAILURE THIS FIXES. On a real device the user replied "Cancel" to a
 * pending Calendar confirmation. Hula's backend did exactly the right thing and
 * cancelled the proposal — but Sendblue treats the standalone word "Cancel" as a
 * CARRIER OPT-OUT keyword, so it never delivered Hula's reply:
 *
 *     error_code: 402  error_message: OPTED_OUT  error_reason: SpamRule
 *
 * The user, seeing silence, sent "START" to restore delivery. START is a carrier
 * OPT-IN keyword — it is a transport-level instruction to the messaging network,
 * not a message to Hula. But it was routed like ordinary content, reached the
 * general brain, and the brain answered:
 *
 *     "Cancelled — no worries. Both tasks left as they were."
 *
 * That sentence was FABRICATED. No Todoist tasks existed, none had been created,
 * and none had been "left as they were". The brain had no way to know that: it was
 * handed a bare word with conversation history around it and did what a language
 * model does — produced a plausible continuation. This is precisely the class of
 * operational lie the rest of the system is built to prevent, and it happened
 * because a transport command was allowed to reach a component that invents prose.
 *
 * THE RULE. A transport-reserved keyword is addressed to the CARRIER, not to Hula.
 * It carries no task, calendar, or email intent, and there is nothing about the
 * user's data to infer from it. So it is intercepted at the very top of the
 * routing cascade, answered with a fixed, neutral, TRUTHFUL acknowledgement, and
 * never reaches the brain or any provider handler.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. It does not bypass, weaken, suppress, or
 * emulate Sendblue's opt-out/opt-in handling. Sendblue and the carrier remain
 * solely responsible for subscription state; by the time an inbound START reaches
 * this code the provider has ALREADY restored delivery. This only decides what — if
 * anything — Hula says back, and its answer claims nothing.
 */

/**
 * Carrier OPT-IN keywords: the user is restoring delivery.
 *
 * Deliberately NARROW. `YES` is also a widely-used carrier opt-in keyword, but it
 * is Hula's primary confirmation word — intercepting it here would break every
 * pending confirmation, which is a far worse outcome than the problem being
 * solved. START and UNSTOP have no meaning inside Hula, so they are unambiguous.
 */
const OPT_IN_KEYWORDS: ReadonlySet<string> = new Set(["start", "unstop"]);

/**
 * Carrier OPT-OUT keywords, listed for REFERENCE and for the copy rule below —
 * NOT intercepted here.
 *
 * These are documented because they explain why confirmation previews must never
 * instruct a user to reply "Cancel": a preview that says 'reply "cancel" to stop'
 * is actively telling the user to opt out of their own SMS delivery. The word
 * still works as a cancellation if typed (see `classifyConfirmationReply` — it is
 * strictly safer to cancel than to leave a write pending), but Hula must stop
 * ASKING for it. See `CONFIRM_INSTRUCTION` in `actions/confirmationCopy.ts`.
 */
export const CARRIER_OPT_OUT_KEYWORDS: readonly string[] = [
  "stop",
  "stopall",
  "unsubscribe",
  "cancel",
  "end",
  "quit",
];

/** What a transport keyword resolved to. */
export type TransportKeyword = "opt_in" | "none";

/**
 * PURE: classify a message as a transport-reserved keyword.
 *
 * Matches ONLY when the message is ENTIRELY that word (case-insensitive, ignoring
 * surrounding whitespace and punctuation). This tightness is the whole safety
 * property: "start the report task" and "unstop the pipeline" are ordinary
 * requests and must fall through untouched.
 */
export function classifyTransportKeyword(text: string | undefined): TransportKeyword {
  const normalized = (text ?? "")
    .toLowerCase()
    .trim()
    // Strip surrounding punctuation/whitespace only — never inner characters, so a
    // multi-word message can never collapse into a bare keyword.
    .replace(/^[^\w]+|[^\w]+$/g, "");
  if (!normalized) return "none";
  return OPT_IN_KEYWORDS.has(normalized) ? "opt_in" : "none";
}

/**
 * The ONLY thing Hula says to a carrier opt-in.
 *
 * Neutral and truthful by construction: it acknowledges the reconnection and
 * asserts nothing about tasks, events, emails, reminders, or anything else that
 * may or may not exist. There is no version of this string that can be wrong.
 */
export const OPT_IN_ACKNOWLEDGEMENT = "You’re reconnected to Hula.";

export interface HandlerResult {
  handled: boolean;
  reply?: string;
}

/**
 * Intercept transport-reserved keywords. Runs FIRST in the inbound cascade.
 *
 * Returns `{handled:false}` for everything else, so ordinary messages are entirely
 * unaffected. Performs no I/O, touches no provider, and reads no user state —
 * there is nothing to look up, because the answer never depends on the user's data.
 */
export async function handleTransportKeyword(
  _userId: string,
  text: string | undefined,
): Promise<HandlerResult> {
  if (classifyTransportKeyword(text) !== "opt_in") return { handled: false };
  return { handled: true, reply: OPT_IN_ACKNOWLEDGEMENT };
}
