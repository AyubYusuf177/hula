import { handleActionConfirmation, handlePendingProposalReprompt } from "../actions/confirmations";
import { handleActionIntent } from "../actions/detect";
import { handleCalendarQuestion } from "../integrations/providers/googleCalendar/calendarQuestion";
import { handleCalendarWrite } from "../integrations/providers/googleCalendar/calendarActions";
import {
  handleGmailClarification,
  handleGmailDraftFollowup,
  handleGmailWrite,
} from "../integrations/providers/gmail/gmailActions";
import { handleGmailCommand } from "../integrations/providers/gmail/gmailCommand";
import { handleGmailDraftLifecycle } from "../integrations/providers/gmail/gmailDraftLifecycle";
import { handleGmailQuestion } from "../integrations/providers/gmail/gmailQuestion";
import { handleGmailReadOne } from "../integrations/providers/gmail/gmailReadOne";
import { handleGmailSearch } from "../integrations/providers/gmail/gmailSearchQuestion";
import { handleGmailSummary } from "../integrations/providers/gmail/gmailSummary";
import { handleMemoryCommand } from "../users/memory";
import { handleReminderCommand } from "../reminders/reminders";

/**
 * Deterministic inbound routing (extracted from `webhooks.ts`).
 *
 * WHY THIS EXISTS. This cascade previously lived inline in the webhook handler as a
 * chain of hand-maintained boolean guards — every new handler meant editing every
 * later guard. Two things followed from that:
 *
 *  1. It could not be tested end-to-end. Handlers were imported directly, so a test
 *     could only exercise one in isolation — which is exactly why "Star the first
 *     one" reaching the generic model was never caught: every isolated unit test
 *     passed. The bug lived in the routing, and the routing had no test.
 *  2. The guards were easy to get subtly wrong, and a missed guard silently sends a
 *     recognised action to the model, which then invents an answer.
 *
 * So routing is now ONE ordered list with injectable handlers. Order is the entire
 * contract; the list below IS the specification, top to bottom. A `null` return
 * means nothing claimed the message and the caller may use the generic brain.
 */

/** The shape every handler shares. */
export interface HandlerResult {
  handled: boolean;
  reply?: string;
}

type Handler = (userId: string, text: string | undefined) => Promise<HandlerResult>;

/** Every handler is injectable so routing can be tested with zero real providers. */
export interface InboundRouterDeps {
  memory?: Handler;
  reminder?: Handler;
  confirmation?: Handler;
  gmailClarify?: Handler;
  gmailDraftFollowup?: Handler;
  gmailDraftLifecycle?: Handler;
  gmailCommand?: Handler;
  calendarWrite?: Handler;
  gmailWrite?: Handler;
  actionIntent?: Handler;
  calendar?: Handler;
  gmailReadOne?: Handler;
  gmailSummary?: Handler;
  gmailSearch?: Handler;
  gmailQuestion?: Handler;
  pendingReprompt?: (userId: string) => Promise<HandlerResult>;
}

/** What routing decided, for the caller to send and log. */
export interface RoutedReply {
  reply: string;
  /** Which handler answered — safe to log (a name, never content). */
  source: string;
}

/**
 * The ordered cascade. Earlier entries win.
 *
 * The ordering rules that are load-bearing (do not reorder without reading these):
 *  - `memory` and `reminder` keep absolute priority — they are the user's own stored
 *    data and must never be reinterpreted as an email or calendar request.
 *  - `confirmation` must precede every write handler, so "no, cancel" always
 *    abandons a pending action and can never be re-read as a fresh command.
 *  - `gmailDraftFollowup` precedes `gmailDraftLifecycle` so "send the draft" sends
 *    rather than being read as a draft command.
 *  - `gmailCommand` precedes `gmailWrite` so "archive those" is never extracted as a
 *    compose, and precedes `gmailSearch`/`gmailQuestion` so a request carrying real
 *    meaning ("important emails regarding work") is interpreted WHOLE rather than
 *    claimed by whichever keyword matched first. It declines anything that isn't a
 *    Gmail list/manage/undo/state request, so the tested search and draft paths keep
 *    their behaviour.
 *  - `gmailReadOne` precedes `gmailSummary` so the existing single-email summary
 *    path ("summarise Rob's latest email") keeps its tested behaviour; `gmailSummary`
 *    only takes what it declines ("summarise them", "which of these need me?").
 *  - `gmailSearch` precedes `gmailQuestion` so a qualified search isn't swallowed by
 *    the generic "latest emails" intent.
 *  - `pendingReprompt` is LAST: while a confirmable action is pending, an
 *    unrecognised reply must never reach the brain, which could fabricate a success.
 */
function buildChain(deps: InboundRouterDeps): { name: string; run: Handler }[] {
  return [
    { name: "memory", run: deps.memory ?? handleMemoryCommand },
    { name: "reminder", run: deps.reminder ?? handleReminderCommand },
    { name: "confirmation", run: deps.confirmation ?? handleActionConfirmation },
    { name: "gmailClarify", run: deps.gmailClarify ?? handleGmailClarification },
    { name: "gmailDraftFollowup", run: deps.gmailDraftFollowup ?? handleGmailDraftFollowup },
    { name: "gmailDraftLifecycle", run: deps.gmailDraftLifecycle ?? handleGmailDraftLifecycle },
    { name: "gmailCommand", run: deps.gmailCommand ?? handleGmailCommand },
    { name: "calendarWrite", run: deps.calendarWrite ?? handleCalendarWrite },
    { name: "gmailWrite", run: deps.gmailWrite ?? handleGmailWrite },
    { name: "actionIntent", run: deps.actionIntent ?? handleActionIntent },
    { name: "calendar", run: deps.calendar ?? handleCalendarQuestion },
    { name: "gmailReadOne", run: deps.gmailReadOne ?? handleGmailReadOne },
    { name: "gmailSummary", run: deps.gmailSummary ?? handleGmailSummary },
    { name: "gmailSearch", run: deps.gmailSearch ?? handleGmailSearch },
    { name: "gmailQuestion", run: deps.gmailQuestion ?? handleGmailQuestion },
  ];
}

/** The ordered handler names, exported so tests can pin the contract. */
export function inboundHandlerOrder(): string[] {
  return buildChain({}).map((h) => h.name);
}

/**
 * Route one inbound message from an already-linked user.
 *
 * Returns the first handler's reply, or `null` when nothing claimed it (the caller
 * then uses the generic brain). Never throws: a handler that blows up is logged by
 * the handler itself and treated as "declined", so one broken path cannot take down
 * the whole reply.
 */
export async function routeInboundText(
  userId: string,
  text: string | undefined,
  deps: InboundRouterDeps = {},
): Promise<RoutedReply | null> {
  for (const { name, run } of buildChain(deps)) {
    const result = await run(userId, text);
    if (result.handled && result.reply) return { reply: result.reply, source: name };
  }

  // Safety net: with a confirmable action pending, an unrecognised reply must be
  // re-prompted deterministically rather than handed to the brain.
  const reprompt = deps.pendingReprompt ?? handlePendingProposalReprompt;
  const guard = await reprompt(userId);
  if (guard.handled && guard.reply) return { reply: guard.reply, source: "pendingReprompt" };

  return null;
}
