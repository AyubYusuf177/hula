/**
 * Todoist relevance gate (Section 19) — ALL PURE.
 *
 * THE COLLISION THIS FILE EXISTS FOR. "Remind me to call Rob tomorrow" is a
 * genuinely ambiguous sentence: it could be a Hula reminder or a Todoist task.
 * Hula has shipped reminders for several sections and users rely on that
 * behaviour. The section is unambiguous about the resolution — existing reminder
 * phrases must remain UNCHANGED unless the user explicitly references Todoist,
 * tasks, projects, labels, or completion.
 *
 * TWO INDEPENDENT MECHANISMS, both required:
 *
 *  1. ORDER. `memory` and `reminder` sit above every Todoist handler in the
 *     inbound cascade, so a message the reminder handler claims never reaches
 *     Todoist at all. That alone preserves existing behaviour.
 *
 *  2. THIS GATE. Order is not sufficient on its own, because the reminder handler
 *     DECLINES plenty of messages that are still not Todoist requests, and a
 *     greedy Todoist handler would then grab them and answer with a task list.
 *     So a message must show a real task-domain signal before Todoist spends a
 *     model call or claims anything.
 *
 * WHY THIS IS NOT THE FORBIDDEN KEYWORD RULE. The section bans literal
 * keyword-only ANSWERING ("when text contains work, return X") — deciding an
 * outcome from a keyword. This is a cheap PREFILTER that only decides whether to
 * ask the model at all; the model then does open-ended slot extraction, and the
 * backend answers strictly from Todoist. A prefilter that is slightly too narrow
 * costs a fallthrough to the brain; a prefilter that is too greedy silently
 * changes reminder behaviour. It is deliberately biased toward the former.
 */

/** PURE: normalize for matching. */
function norm(text: string | undefined): string {
  return (text ?? "").toLowerCase().trim();
}

/**
 * PURE: STRONG task signals — words that exist only in a task app.
 *
 * "task", "to-do", "todoist" and "my list" cannot plausibly mean a calendar event,
 * so they settle the question outright (see `mentionsEvent`).
 */
function mentionsTaskStrongly(text: string | undefined): boolean {
  const t = norm(text);
  if (!t) return false;
  return (
    /\btodoist\b/.test(t) ||
    /\btasks?\b/.test(t) ||
    /\bto-?dos?\b/.test(t) ||
    /\bmy\s+list\b/.test(t) ||
    /\bchecklist\b/.test(t)
  );
}

/**
 * PURE: WEAK task signals — real task vocabulary that a calendar request can also
 * legitimately contain.
 *
 * "project", "label" and "section" are Todoist concepts, but "schedule a PROJECT
 * review meeting" is plainly a meeting. So these are enough to CONSIDER Todoist,
 * but not enough to overrule explicit event language.
 */
function mentionsTaskWeakly(text: string | undefined): boolean {
  const t = norm(text);
  if (!t) return false;
  return /\bprojects?\b/.test(t) || /\blabels?\b/.test(t) || /\bsections?\b/.test(t);
}

/**
 * PURE: does the message name Todoist, or a concept that only exists in a task app?
 * Strong or weak — used by callers that just need "is this task-domain at all".
 */
export function mentionsTodoistExplicitly(text: string | undefined): boolean {
  return mentionsTaskStrongly(text) || mentionsTaskWeakly(text);
}

/**
 * PURE: explicit CALENDAR-EVENT language.
 *
 * An event is a thing you attend at a moment, usually with other people. A task is
 * a thing you do by a moment. Words like "meeting", "appointment" and "invite" only
 * make sense for the former.
 *
 * Deliberately EXCLUDES bare "add" and bare due-date phrasing. "Add X for Friday at
 * 5" is not evidence of an event — that assumption is exactly what misrouted a task
 * to the calendar on a real device. A due date does not turn a task into an event.
 */
function mentionsEvent(text: string | undefined): boolean {
  const t = norm(text);
  if (!t) return false;
  return (
    /\bmeetings?\b/.test(t) ||
    /\bappointments?\b/.test(t) ||
    /\bcalendars?\b/.test(t) ||
    /\binvites?\b/.test(t) ||
    /\bgoogle\s+meet\b/.test(t) ||
    /\bzoom\b/.test(t) ||
    /\bschedule\b/.test(t) ||
    /\bbook\s+(?:a|an|the)\b/.test(t) ||
    /\b(?:call|lunch|dinner|coffee|catch\s*up)\s+with\b/.test(t)
  );
}

/**
 * PURE: is this the established Hula REMINDER shape?
 *
 * Matched conservatively and only at the START of the message, so "add a task to
 * remind the team" is not mistaken for a reminder.
 */
export function looksLikeReminderPhrase(text: string | undefined): boolean {
  const t = norm(text);
  if (!t) return false;
  return /^(?:hey\s+hula[,\s]+)?(?:please\s+)?remind\s+me\b/.test(t);
}

/**
 * PURE: task-domain language that is NOT reminder-shaped.
 *
 * Deliberately excludes bare "due" and bare "add", which collide with calendar
 * and general conversation respectively.
 */
function mentionsTaskWork(text: string | undefined): boolean {
  const t = norm(text);
  if (!t) return false;
  return (
    /\boverdue\b/.test(t) ||
    /\bmark\s+(?:it|that|the|them|all)?\s*\w*\s*(?:complete|done|off)\b/.test(t) ||
    /\b(?:complete|completed|completing)\b/.test(t) ||
    /\breopen\b/.test(t) ||
    /\bcross\s+(?:it|that|them)\s+off\b/.test(t) ||
    /\btick\s+(?:it|that|them)\s+off\b/.test(t) ||
    /\bwhat\s+(?:do\s+i|have\s+i)\s+(?:need\s+to\s+do|got\s+to\s+do)\b/.test(t) ||
    /\bon\s+my\s+plate\b/.test(t) ||
    /\bpriority\b/.test(t)
  );
}

/**
 * PURE: should the Todoist handlers consider this message at all?
 *
 * The reminder rule is the load-bearing line, and it reads exactly as the section
 * specifies: a reminder-shaped message is Todoist's ONLY if the user also said
 * something explicitly Todoist-ish. "Remind me to call Rob tomorrow" → false
 * (stays a Hula reminder, unchanged). "Remind me to call Rob by adding a task" →
 * true. "Add a Todoist task to call Rob" → true.
 */
export function shouldConsiderTodoist(text: string | undefined): boolean {
  const t = norm(text);
  if (!t) return false;

  if (looksLikeReminderPhrase(t)) {
    // Only an EXPLICIT task-app reference overrides established reminder
    // behaviour. Never a general task-work verb, which "remind me to complete
    // the deck" would otherwise trip.
    return mentionsTodoistExplicitly(t);
  }

  const strong = mentionsTaskStrongly(t);

  // Explicit event language wins UNLESS the message also names a task outright.
  // This is what keeps Calendar safe now that Todoist is evaluated first: Todoist
  // sits above `calendarWrite` in the cascade, so cascade position no longer
  // protects meetings — this line does.
  //
  //   "schedule a project review meeting Friday" → event + weak only → Calendar
  //   "complete the meeting prep task"           → event + STRONG      → Todoist
  //   "add X to my project for Friday at 5"      → no event signal     → Todoist
  if (mentionsEvent(t) && !strong) return false;

  return strong || mentionsTaskWeakly(t) || mentionsTaskWork(t);
}

/**
 * PURE: is this message a follow-up that only makes sense against a task list
 * Hula just showed ("the second one", "complete all of those", "undo that")?
 *
 * These carry NO task vocabulary at all, so `shouldConsiderTodoist` correctly
 * rejects them. They are only Todoist's when a live Todoist context exists, which
 * the caller checks — this function merely reports the shape.
 */
export function looksLikeTodoistFollowup(text: string | undefined): boolean {
  const t = norm(text);
  if (!t) return false;
  if (/^#?\d{1,2}\.?$/.test(t)) return true;
  if (/\b(?:first|second|third|fourth|fifth|last)\s+one\b/.test(t)) return true;
  if (/\ball\s+(?:of\s+)?(?:them|those|these)\b/.test(t)) return true;
  if (/\bundo\s+(?:that|it)?\b/.test(t)) return true;
  if (/\b(?:that|this|it)\s+one\b/.test(t)) return true;
  return false;
}
