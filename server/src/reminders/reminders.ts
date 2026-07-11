import { getPrisma } from "../db/prisma";
import { computeNextRun, extractTime, formatClock } from "./parse";
import type {
  RecurrenceRule,
  ReminderStatusValue,
  ReminderView,
} from "./types";

/**
 * Explicit reminders + a lightweight follow-up foundation (Section 9).
 *
 * Hula can now create reminders when the user EXPLICITLY asks ("remind me …"),
 * list them, and cancel them — all through natural iMessage commands, handled
 * DETERMINISTICALLY (no Anthropic call). A conservative worker (see `worker.ts`)
 * delivers due reminders proactively. There is intentionally NO automatic
 * inference from ordinary messages and NO proactive follow-up guessing yet; the
 * `future_*` reminder sources reserve space for integration-driven reminders
 * later without changing this code.
 *
 * The design mirrors `users/memory.ts`: PURE, DB-free functions (command
 * classification, title extraction, phrasing, matching) that are fully
 * unit-testable, plus thin DB-backed helpers and one orchestrator around them.
 */

// --- Caps / limits -------------------------------------------------------

/** Max active reminders a single user may hold (spam/cost guard). */
export const MAX_ACTIVE_REMINDERS = 50;
/** Max characters kept for a reminder title. */
const MAX_TITLE = 200;
/** Times a recurring reminder may fire before it auto-completes (cost bound). */
export const RECURRING_MAX_SENDS = 365;

// --- Fixed replies (iMessage-friendly, matching the codebase voice) ------

export const REMINDER_REPLIES = {
  listEmpty: "You don’t have any active reminders.",
  cancelledOne: "Done — I cancelled that reminder.",
  cancelledNone: "I couldn’t find an active reminder matching that.",
  cancelledAll: "Done — I cancelled all active reminders.",
  needsTime: "What time should I remind you?",
  needsTask: "What should I remind you about?",
  tooFrequent:
    "I can only do daily or weekly reminders for now — what day and time works?",
  inPast: "That time has already passed — when should I remind you?",
  limitReached:
    "You’ve hit the reminder limit (50). Cancel one and I’ll add this.",
} as const;

// --- Command classification (PURE) ---------------------------------------

/** The classified intent of an inbound message w.r.t. reminders. */
export type ReminderCommand =
  | { intent: "create"; body: string }
  | { intent: "list" }
  | { intent: "cancel"; scope: "all" }
  | { intent: "cancel"; scope: "match"; query: string }
  | { intent: "none" };

// Create: "remind me …", "can you remind me …", and explicit "follow up with me
// …" (treated as a reminder per Section 9). Politeness/opener prefixes allowed.
const REMIND_RE =
  /^(?:hey[,\s]+)?(?:please\s+|can you\s+|could you\s+|would you\s+|will you\s+)*remind me\b[\s:,-]*(.*)$/i;
const FOLLOW_UP_RE =
  /^(?:hey[,\s]+)?(?:please\s+|can you\s+|could you\s+)?follow up with me\b[\s:,-]*(.*)$/i;

// List.
const LIST_RES = [
  /what reminders do i have/i,
  /do i have any reminders/i,
  /what are my reminders/i,
  /^(?:please\s+)?(?:show|list|check)(?:\s+me)?\s+(?:my\s+)?reminders\b/i,
];

// Cancel everything (checked before a specific cancel).
const CANCEL_ALL_RE =
  /^(?:please\s+)?(?:cancel|delete|clear|remove|stop)\s+all(?:\s+(?:my|of my))?\s+reminders\b/i;

// Cancel a specific reminder: "cancel my gym reminder", "delete the form reminder".
const CANCEL_MATCH_RE =
  /^(?:please\s+)?(?:cancel|delete|remove)\s+(?:my\s+|the\s+|that\s+)?(.*?)\s*reminder\b/i;
// "stop reminding me about the form" / "stop reminding me to submit".
const STOP_REMINDING_RE =
  /^(?:please\s+)?stop reminding me(?:\s+(?:about|to|for|on))?\s*(.*)$/i;

/** Strip leading filler from a cancel query ("my", "the", "about", …). */
function cleanCancelQuery(raw: string): string {
  return raw
    .replace(/^[\s:,-]+/, "")
    .replace(/^(?:my|the|that|this|about)\s+/i, "")
    .replace(/\breminders?\b/gi, "")
    .trim();
}

/**
 * Pure: classify an inbound message into a reminder command (or `none`). Only
 * explicit front-of-message phrasing counts. Memory commands take precedence
 * upstream (this never sees "remember …"/"forget …"), so there is no overlap.
 */
export function classifyReminderCommand(text: string | undefined): ReminderCommand {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return { intent: "none" };

  // List first (questions can't be confused with create/cancel).
  if (LIST_RES.some((re) => re.test(trimmed))) return { intent: "list" };

  // Cancel-all before specific cancel.
  if (CANCEL_ALL_RE.test(trimmed)) return { intent: "cancel", scope: "all" };

  // "stop reminding me" with no target means cancel everything.
  const stop = STOP_REMINDING_RE.exec(trimmed);
  if (stop) {
    const query = cleanCancelQuery(stop[1] ?? "");
    return query
      ? { intent: "cancel", scope: "match", query }
      : { intent: "cancel", scope: "all" };
  }

  // Cancel a specific reminder.
  const cancelMatch = CANCEL_MATCH_RE.exec(trimmed);
  if (cancelMatch) {
    const query = cleanCancelQuery(cancelMatch[1] ?? "");
    if (query) return { intent: "cancel", scope: "match", query };
  }

  // Create ("remind me …").
  const remind = REMIND_RE.exec(trimmed);
  if (remind) return { intent: "create", body: (remind[1] ?? "").trim() };

  // Explicit follow-up counts as a reminder ("follow up with me tomorrow …").
  const follow = FOLLOW_UP_RE.exec(trimmed);
  if (follow) {
    const rest = (follow[1] ?? "").trim();
    // Prefix so the title reads naturally ("Follow up about the invoice").
    return { intent: "create", body: rest ? `follow up ${rest}` : "follow up" };
  }

  return { intent: "none" };
}

// --- Title extraction (PURE) ---------------------------------------------

/** Strip leading joiners ("to", "about", …) and cap the title length. */
export function cleanReminderTitle(raw: string): string | null {
  let out = raw
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:to|that|about|for|on|and|:|,|-|\s)+/i, "")
    .replace(/^["'“”]+|["'“”]+$/g, "")
    .replace(/[\s,]+please$/i, "")
    .trim();
  if (out.length < 2) return null;
  out = out.slice(0, MAX_TITLE).trim();
  return out;
}

/** The parsed result of a "remind me …" body. */
export type CreateParse =
  | {
      ok: true;
      title: string;
      dueAt: Date;
      recurrenceRule: RecurrenceRule | null;
      humanWhen: string;
    }
  | { ok: false; reason: "needs_time" | "too_frequent" | "in_past" | "needs_task" };

/**
 * Pure: parse the body of a create command into a concrete reminder. Extracts
 * the time phrase, then derives the title from what remains. Ambiguity (no time,
 * too-frequent, past, or no task) returns a specific reason so the caller can
 * ask exactly one clarifying question.
 */
export function parseCreate(
  body: string,
  now: Date,
  timeZone: string | undefined,
): CreateParse {
  const { parse, remainder } = extractTime(body, now, timeZone);
  if (!parse.ok) {
    return { ok: false, reason: parse.reason };
  }
  const title = cleanReminderTitle(remainder);
  if (!title) return { ok: false, reason: "needs_task" };
  return {
    ok: true,
    title,
    dueAt: parse.dueAt,
    recurrenceRule: parse.recurrenceRule,
    humanWhen: parse.humanWhen,
  };
}

// --- Phrasing (PURE) -----------------------------------------------------

/** "Got it — I'll remind you {when}: {title}." */
export function createConfirmation(humanWhen: string, title: string): string {
  return `Got it — I’ll remind you ${humanWhen}: ${title}.`;
}

/**
 * Pure: format one active reminder's "when" for the list. Recurring reminders
 * read as "every day at 8:00 AM"; one-offs read as "Jul 12 at 7:00 PM". Uses the
 * reminder's stored timezone (or UTC) so the phrasing is stable.
 */
export function formatReminderWhen(view: ReminderView): string {
  const iso = view.nextRunAt ?? view.dueAt;
  const when = new Date(iso);
  const tz = view.timezone ?? undefined;

  const parts = tzParts(when, tz);
  const clock = formatClock(parts.hour, parts.minute);

  if (view.recurrenceRule === "daily") return `every day at ${clock}`;
  if (view.recurrenceRule === "weekly") return `every ${parts.weekday} at ${clock}`;
  return `${parts.month} ${parts.day} at ${clock}`;
}

/** Read the display calendar fields for an instant in a timezone (or UTC). */
function tzParts(
  date: Date,
  timeZone: string | undefined,
): { weekday: string; month: string; day: number; hour: number; minute: number } {
  try {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "long",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    const map: Record<string, string> = {};
    for (const p of dtf.formatToParts(date)) {
      if (p.type !== "literal") map[p.type] = p.value;
    }
    return {
      weekday: map.weekday ?? "",
      month: map.month ?? "",
      day: Number(map.day ?? "1"),
      hour: Number(map.hour ?? "0") % 24,
      minute: Number(map.minute ?? "0"),
    };
  } catch {
    return {
      weekday: "",
      month: "",
      day: date.getUTCDate(),
      hour: date.getUTCHours(),
      minute: date.getUTCMinutes(),
    };
  }
}

/** Format a numbered list of active reminders (or the empty-state reply). */
export function formatReminderList(views: ReminderView[]): string {
  if (views.length === 0) return REMINDER_REPLIES.listEmpty;
  const lines = views.map((v, i) => `${i + 1}. ${v.title} — ${formatReminderWhen(v)}`);
  return `Your active reminders:\n${lines.join("\n")}`;
}

// --- Title matching for cancel (PURE) ------------------------------------

const STOPWORDS = new Set([
  "i","im","my","me","you","your","the","this","that","a","an","to","at","in",
  "on","of","for","and","or","about","reminder","reminders","remind","please",
]);

function significantTokens(text: string): string[] {
  const words = text.toLowerCase().match(/[a-z0-9']+/g) ?? [];
  return words.filter((w) => w.length >= 2 && !STOPWORDS.has(w));
}

/**
 * Pure: whether a reminder title matches a free-text cancel query. Needs at
 * least one significant query word AND at least half of the query's significant
 * words to appear in the title. No embeddings — simple overlap.
 */
export function reminderMatchesQuery(title: string, query: string): boolean {
  const q = significantTokens(query);
  if (q.length === 0) return false;
  const t = new Set(significantTokens(title));
  const hits = q.filter((w) => t.has(w)).length;
  return hits >= Math.max(1, Math.ceil(q.length / 2));
}

// --- DB-backed helpers ---------------------------------------------------

interface ReminderRow {
  id: string;
  title: string;
  body: string | null;
  status: ReminderStatusValue;
  dueAt: Date;
  nextRunAt: Date | null;
  recurrenceRule: string | null;
  timezone: string | null;
  createdAt: Date;
}

function toReminderView(row: ReminderRow): ReminderView {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    status: row.status,
    dueAt: row.dueAt.toISOString(),
    nextRunAt: row.nextRunAt ? row.nextRunAt.toISOString() : null,
    recurrenceRule: (row.recurrenceRule as RecurrenceRule | null) ?? null,
    timezone: row.timezone,
    createdAt: row.createdAt.toISOString(),
  };
}

const REMINDER_SELECT = {
  id: true,
  title: true,
  body: true,
  status: true,
  dueAt: true,
  nextRunAt: true,
  recurrenceRule: true,
  timezone: true,
  createdAt: true,
} as const;

/** Best-effort read of a user's stored timezone (from their profile). */
export async function getUserTimezone(userId: string): Promise<string | undefined> {
  try {
    const profile = await getPrisma().userProfile.findUnique({
      where: { userId },
      select: { timezone: true },
    });
    return profile?.timezone ?? undefined;
  } catch {
    return undefined;
  }
}

/** Count a user's active (scheduled) reminders. */
export async function countActiveReminders(userId: string): Promise<number> {
  return getPrisma().reminder.count({ where: { userId, status: "scheduled" } });
}

/** Create a reminder for a user. `nextRunAt` starts at `dueAt`. */
export async function createReminderForUser(
  userId: string,
  input: {
    title: string;
    dueAt: Date;
    recurrenceRule: RecurrenceRule | null;
    timezone?: string;
    originalText?: string;
  },
): Promise<ReminderView> {
  const row = await getPrisma().reminder.create({
    data: {
      userId,
      title: input.title,
      dueAt: input.dueAt,
      nextRunAt: input.dueAt,
      recurrenceRule: input.recurrenceRule,
      timezone: input.timezone ?? null,
      originalText: input.originalText ?? null,
      source: "explicit_user_request",
      channel: "imessage",
      provider: "sendblue",
      maxSends: input.recurrenceRule ? RECURRING_MAX_SENDS : 1,
    },
    select: REMINDER_SELECT,
  });
  return toReminderView(row);
}

/** List a user's active reminders, soonest first. */
export async function listActiveRemindersForUser(
  userId: string,
  limit: number = MAX_ACTIVE_REMINDERS,
): Promise<ReminderView[]> {
  const rows = await getPrisma().reminder.findMany({
    where: { userId, status: "scheduled" },
    orderBy: { nextRunAt: "asc" },
    take: limit,
    select: REMINDER_SELECT,
  });
  return rows.map(toReminderView);
}

/** Cancel one active reminder by id (scoped to the owning user). */
export async function cancelReminderById(
  userId: string,
  reminderId: string,
): Promise<boolean> {
  const result = await getPrisma().reminder.updateMany({
    where: { id: reminderId, userId, status: "scheduled" },
    data: { status: "cancelled", cancelledAt: new Date() },
  });
  return result.count > 0;
}

/** Cancel active reminders whose title matches a free-text query. */
export async function cancelRemindersByTitleMatch(
  userId: string,
  query: string,
): Promise<number> {
  const rows = await getPrisma().reminder.findMany({
    where: { userId, status: "scheduled" },
    select: { id: true, title: true },
  });
  const matchedIds = rows.filter((r) => reminderMatchesQuery(r.title, query)).map((r) => r.id);
  if (matchedIds.length === 0) return 0;
  const result = await getPrisma().reminder.updateMany({
    where: { id: { in: matchedIds }, userId, status: "scheduled" },
    data: { status: "cancelled", cancelledAt: new Date() },
  });
  return result.count;
}

/** Cancel ALL of a user's active reminders. Returns the number cancelled. */
export async function cancelAllRemindersForUser(userId: string): Promise<number> {
  const result = await getPrisma().reminder.updateMany({
    where: { userId, status: "scheduled" },
    data: { status: "cancelled", cancelledAt: new Date() },
  });
  return result.count;
}

// --- Orchestrator (DB-backed) --------------------------------------------

/** Result of attempting to handle a message as a reminder command. */
export interface ReminderCommandResult {
  handled: boolean;
  reply?: string;
  intent?: ReminderCommand["intent"];
}

/** Map a parse failure to the right clarification reply. */
function replyForParseFailure(
  reason: "needs_time" | "too_frequent" | "in_past" | "needs_task",
): string {
  switch (reason) {
    case "too_frequent":
      return REMINDER_REPLIES.tooFrequent;
    case "in_past":
      return REMINDER_REPLIES.inPast;
    case "needs_task":
      return REMINDER_REPLIES.needsTask;
    default:
      return REMINDER_REPLIES.needsTime;
  }
}

/**
 * Deterministically handle a reminder command from an already-linked user.
 * Returns `{ handled: false }` for ordinary messages (so the caller falls
 * through to the normal Hula brain). Never throws — any DB failure degrades to
 * `handled: false`. This never calls the Anthropic brain.
 */
export async function handleReminderCommand(
  userId: string,
  text: string | undefined,
): Promise<ReminderCommandResult> {
  const command = classifyReminderCommand(text);
  if (command.intent === "none") return { handled: false };

  try {
    if (command.intent === "list") {
      const reminders = await listActiveRemindersForUser(userId);
      return { handled: true, intent: "list", reply: formatReminderList(reminders) };
    }

    if (command.intent === "cancel") {
      if (command.scope === "all") {
        await cancelAllRemindersForUser(userId);
        return { handled: true, intent: "cancel", reply: REMINDER_REPLIES.cancelledAll };
      }
      const count = await cancelRemindersByTitleMatch(userId, command.query);
      return {
        handled: true,
        intent: "cancel",
        reply: count > 0 ? REMINDER_REPLIES.cancelledOne : REMINDER_REPLIES.cancelledNone,
      };
    }

    // create
    const timezone = await getUserTimezone(userId);
    const parsed = parseCreate(command.body, new Date(), timezone);
    if (!parsed.ok) {
      return { handled: true, intent: "create", reply: replyForParseFailure(parsed.reason) };
    }

    // Enforce the per-user cap before storing anything.
    const active = await countActiveReminders(userId);
    if (active >= MAX_ACTIVE_REMINDERS) {
      return { handled: true, intent: "create", reply: REMINDER_REPLIES.limitReached };
    }

    await createReminderForUser(userId, {
      title: parsed.title,
      dueAt: parsed.dueAt,
      recurrenceRule: parsed.recurrenceRule,
      timezone,
      originalText: (text ?? "").slice(0, 500),
    });
    return {
      handled: true,
      intent: "create",
      reply: createConfirmation(parsed.humanWhen, parsed.title),
    };
  } catch {
    // On any DB failure, fall through to the normal brain rather than lying.
    return { handled: false };
  }
}
