/**
 * The single instruction Hula gives when it needs a yes/no — ALL PURE.
 *
 * WHY THIS IS ONE CONSTANT RATHER THAN A PHRASE PER HANDLER. Previews previously
 * ended with 'Reply "yes" to go ahead or "cancel" to stop.' On a real device that
 * turned out to be actively harmful: Sendblue treats the standalone word "Cancel"
 * as a CARRIER OPT-OUT keyword. So Hula was instructing users to opt themselves out
 * of their own SMS delivery — and when one did, the carrier blocked Hula's reply
 * (`402 OPTED_OUT / SpamRule`), leaving the user staring at silence with no idea
 * whether their action had been cancelled.
 *
 * "No" is the fix: it is a natural cancellation word, it is NOT carrier-reserved,
 * and `classifyConfirmationReply` already treats it as a cancel. Typing "Cancel"
 * still cancels — that path is deliberately left intact, because a user who types
 * it means to stop and it is always safer to abandon a pending write than to leave
 * it armed. Hula simply stops ASKING for the word that breaks their delivery.
 *
 * Every confirmable action shares this string so the guidance can never drift back
 * apart, and so a future carrier-keyword conflict is a one-line fix.
 */
export const CONFIRM_INSTRUCTION = "Reply Yes to confirm or No to cancel.";
