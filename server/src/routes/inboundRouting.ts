import { handleActionConfirmation, handlePendingProposalReprompt } from "../actions/confirmations";
import { handleActionIntent } from "../actions/detect";
import { handleCalendarQuestion } from "../integrations/providers/googleCalendar/calendarQuestion";
import {
  handleCalendarUndo,
  handleCalendarWrite,
} from "../integrations/providers/googleCalendar/calendarActions";
import {
  handleCalendarAvailability,
  handleCalendarFlexibleRead,
} from "../integrations/providers/googleCalendar/calendarReads";
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
import {
  handleTodoistUndo,
  handleTodoistWrite,
} from "../integrations/providers/todoist/todoistActions";
import { handleTodoistRead } from "../integrations/providers/todoist/todoistReads";
import { handleAsanaRead } from "../integrations/providers/asana/asanaReads";
import { handleAsanaWrite } from "../integrations/providers/asana/asanaActions";
import { handleNotionConversation } from "../integrations/providers/notion/conversation";
import { handleSlackConversation } from "../integrations/providers/slack/conversation";
import { handleGoogleDriveConversation } from "../integrations/providers/googleDrive/conversation";
import { handleTransportKeyword } from "../channels/transportKeywords";
import { handleEntityFollowup } from "./entityFollowup";
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
  /** Underlying provider when a cross-provider arbiter delegated the request. */
  routeSource?: string;
}

type Handler = (userId: string, text: string | undefined) => Promise<HandlerResult>;

/** Every handler is injectable so routing can be tested with zero real providers. */
export interface InboundRouterDeps {
  transportKeyword?: Handler;
  memory?: Handler;
  reminder?: Handler;
  confirmation?: Handler;
  entityFollowup?: Handler;
  gmailClarify?: Handler;
  gmailDraftFollowup?: Handler;
  gmailDraftLifecycle?: Handler;
  gmailCommand?: Handler;
  calendarUndo?: Handler;
  calendarWrite?: Handler;
  gmailWrite?: Handler;
  actionIntent?: Handler;
  calendarAvailability?: Handler;
  calendar?: Handler;
  calendarRead?: Handler;
  gmailReadOne?: Handler;
  gmailSummary?: Handler;
  gmailSearch?: Handler;
  gmailQuestion?: Handler;
  todoistUndo?: Handler;
  todoistWrite?: Handler;
  todoistRead?: Handler;
  asanaWrite?: Handler;
  asanaRead?: Handler;
  notion?: Handler;
  slack?: Handler;
  drive?: Handler;
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
 *  - `transportKeyword` is ABSOLUTELY FIRST. A carrier keyword like START/UNSTOP is
 *    addressed to the messaging network, not to Hula — it carries no content intent
 *    at all. On a real device a bare "START" (sent to restore delivery after
 *    Sendblue read "Cancel" as an opt-out) fell through this cascade to the general
 *    brain, which fabricated "Cancelled — no worries. Both tasks left as they were."
 *    No such tasks existed. Nothing downstream can safely interpret a transport
 *    command, so nothing downstream ever sees one.
 *  - `memory` and `reminder` keep absolute priority over the CONTENT handlers — they
 *    are the user's own stored data and must never be reinterpreted as an email or
 *    calendar request.
 *  - `confirmation` must precede every write handler, so "no, cancel" always
 *    abandons a pending action and can never be re-read as a fresh command.
 *  - `entityFollowup` sits directly BELOW `confirmation` and ABOVE every provider
 *    handler. A bare follow-up ("the second one", "change its priority", "it") has
 *    no meaning of its own — it means whatever the last grounded list was about —
 *    so no fixed handler ORDER can route it correctly. Whoever sits highest would
 *    win every ambiguous pronoun forever, which is exactly what happened: Gmail's
 *    draft-edit gate matches a bare "change", so "Change the second one's priority
 *    to high" (said to a Todoist list) was answered with "I'm not sure which draft
 *    you mean". This step asks the only question that settles it — what were we
 *    just talking about? — and claims ONLY when the answer is Todoist, leaving
 *    every existing Gmail/Calendar path byte-for-byte unchanged.
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
 *  - `calendarUndo` FOLLOWS `gmailCommand` (Section 18) so Gmail's own undo keeps
 *    priority for "undo that" after an email action; the Calendar undo only takes
 *    it when Gmail has nothing to reverse. It declines unless a VERIFIED calendar
 *    create is there to invert, so it can never swallow an ordinary message.
 *  - `calendarAvailability` precedes `calendar` (Section 18). "Am I free tomorrow at
 *    3?" already matches the regex schedule path, which would answer it by LISTING
 *    tomorrow's events — a different question, answered from a capped event list
 *    rather than real free/busy. Availability has to win, or Hula infers
 *    availability from data it knows may be incomplete.
 *  - `calendarRead` FOLLOWS `calendar` (Section 18) for the mirror-image reason: the
 *    regex path's fixed shapes are tested and free, so they keep priority, and the
 *    model-backed reader only takes what they decline (arbitrary ranges, search).
 *  - `todoistUndo` FOLLOWS `calendarUndo` for the same reason Calendar's follows
 *    Gmail's: a bare "undo that" after an email or calendar action must keep meaning
 *    that action. Todoist's undo only takes it when neither has anything to reverse,
 *    and it declines unless a VERIFIED Todoist action exists to invert.
 *  - `todoistWrite` / `todoistRead` PRECEDE the Calendar handlers (Section 19
 *    correction). They originally sat below everything, on the principle that an
 *    established path keeps priority — and that was WRONG in a way only a real
 *    device showed: "add finish the pitch deck to my work project for Friday at 5"
 *    was claimed by `calendarWrite`, whose model extractor happily reads "… for
 *    Friday at 5" as an event. The user got a calendar-event confirmation for a
 *    request that never mentioned a calendar, twice.
 *
 *    Ordering alone cannot fix that (a request has to reach Todoist BEFORE Calendar
 *    interprets it), and neither can Calendar's extractor be trusted to decline —
 *    it is doing exactly what it was built to do. So Todoist goes first, and safety
 *    comes from the GATE instead: `shouldConsiderTodoist` demands explicit
 *    task-domain vocabulary (task/todoist/project/label/overdue/complete/…), and the
 *    model extractor is a second gate that returns `not_todoist_write` for anything
 *    that is really a meeting. "Book a meeting with Sam on Friday" fails the gate at
 *    step one and reaches Calendar untouched; "schedule a project review Friday"
 *    passes the gate but the extractor declines it, and it reaches Calendar too.
 *  - CRUCIALLY, both still sit below `reminder`, which keeps ABSOLUTE priority.
 *    "Remind me to call Rob tomorrow" is claimed by the reminder handler and never
 *    reaches Todoist, so established reminder behaviour is untouched.
 *  - `pendingReprompt` is LAST: while a confirmable action is pending, an
 *    unrecognised reply must never reach the brain, which could fabricate a success.
 */
function buildChain(deps: InboundRouterDeps): { name: string; run: Handler }[] {
  return [
    { name: "transportKeyword", run: deps.transportKeyword ?? handleTransportKeyword },
    { name: "memory", run: deps.memory ?? handleMemoryCommand },
    { name: "reminder", run: deps.reminder ?? handleReminderCommand },
    { name: "confirmation", run: deps.confirmation ?? handleActionConfirmation },
    // Cross-provider follow-up arbitration. See the header note: cascade ORDER
    // cannot decide who owns "the second one" — only the last grounded list can.
    { name: "entityFollowup", run: deps.entityFollowup ?? handleEntityFollowup },
    { name: "slack", run: deps.slack ?? handleSlackConversation },
    // Drive is semantically gated and runs before Notion so an explicit Google
    // Doc can never be claimed as a generic Notion document/page request.
    { name: "drive", run: deps.drive ?? handleGoogleDriveConversation },
    // Explicit Notion and Notion-owned follow-ups run before task providers. Its
    // semantic extractor declines Todoist, Asana, mail, calendar and reminders.
    { name: "notion", run: deps.notion ?? handleNotionConversation },
    // Asana is gated by typed provider extraction. It must run before Todoist so
    // an explicitly named Asana task cannot be claimed by Todoist's task nouns.
    { name: "asanaWrite", run: deps.asanaWrite ?? handleAsanaWrite },
    { name: "asanaRead", run: deps.asanaRead ?? handleAsanaRead },
    { name: "gmailClarify", run: deps.gmailClarify ?? handleGmailClarification },
    { name: "gmailDraftFollowup", run: deps.gmailDraftFollowup ?? handleGmailDraftFollowup },
    { name: "gmailDraftLifecycle", run: deps.gmailDraftLifecycle ?? handleGmailDraftLifecycle },
    { name: "gmailCommand", run: deps.gmailCommand ?? handleGmailCommand },
    { name: "calendarUndo", run: deps.calendarUndo ?? handleCalendarUndo },
    // Todoist precedes Calendar: a task request must reach Todoist before
    // Calendar's extractor reads its due date as an event. See the header note.
    { name: "todoistUndo", run: deps.todoistUndo ?? handleTodoistUndo },
    { name: "todoistWrite", run: deps.todoistWrite ?? handleTodoistWrite },
    { name: "todoistRead", run: deps.todoistRead ?? handleTodoistRead },
    { name: "calendarWrite", run: deps.calendarWrite ?? handleCalendarWrite },
    { name: "gmailWrite", run: deps.gmailWrite ?? handleGmailWrite },
    { name: "actionIntent", run: deps.actionIntent ?? handleActionIntent },
    {
      name: "calendarAvailability",
      run: deps.calendarAvailability ?? handleCalendarAvailability,
    },
    { name: "calendar", run: deps.calendar ?? handleCalendarQuestion },
    { name: "calendarRead", run: deps.calendarRead ?? handleCalendarFlexibleRead },
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
    if (result.handled && result.reply) return { reply: result.reply, source: result.routeSource ?? name };
  }

  // Safety net: with a confirmable action pending, an unrecognised reply must be
  // re-prompted deterministically rather than handed to the brain.
  const reprompt = deps.pendingReprompt ?? handlePendingProposalReprompt;
  const guard = await reprompt(userId);
  if (guard.handled && guard.reply) return { reply: guard.reply, source: "pendingReprompt" };

  return null;
}
