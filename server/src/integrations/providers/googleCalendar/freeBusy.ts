import {
  GoogleCalendarError,
  getGoogleCalendarConnection,
  googleCalendarRequestForConnection,
} from "./client";
import type { FetchLike } from "./oauth";
import { wallTimeToUtc } from "../../../reminders/parse";

/**
 * Availability / free-busy (Section 18).
 *
 * "Am I free Friday at 3?" is a question Hula must answer from Google's REAL
 * free/busy data — the dedicated `freeBusy.query` endpoint — and never by
 * eyeballing a page of events.
 *
 * WHY THAT DISTINCTION IS NOT PEDANTIC. An `events.list` read is capped
 * (`maxResults`), paginated, and scoped to one calendar. Deriving "you're free"
 * from it means deriving a NEGATIVE from a list you already know may be
 * incomplete: the one event that conflicts could be on page two, or on the
 * user's other calendar, and Hula would confidently say "you're free" and be
 * wrong. `freeBusy.query` is the API Google provides precisely because it
 * answers the complete question over a bounded window. So: busy intervals come
 * from there, or Hula says it couldn't check. There is no third branch where it
 * guesses.
 *
 * Everything except `queryFreeBusy` is PURE and unit-tested.
 */

/** Google's free/busy response for one calendar. */
interface RawFreeBusyCalendar {
  busy?: { start?: string; end?: string }[];
  errors?: { domain?: string; reason?: string }[];
}

interface RawFreeBusyResponse {
  timeMin?: string;
  timeMax?: string;
  calendars?: Record<string, RawFreeBusyCalendar>;
}

/** A half-open busy/free interval [start, end) as absolute instants. */
export interface TimeInterval {
  /** ISO instant, inclusive. */
  start: string;
  /** ISO instant, exclusive. */
  end: string;
}

/** The bounded working window a free-window search is confined to. */
export interface WorkingWindow {
  /** Local hour the day opens (0-23). */
  startHour: number;
  /** Local hour the day closes (1-24). */
  endHour: number;
}

/**
 * The default working window. "When am I free next week?" must not offer 3am —
 * a technically-free slot no one wants is a wrong answer. Overridable per call
 * so a caller with better information (an explicit "Friday afternoon") can
 * narrow it.
 */
export const DEFAULT_WORKING_WINDOW: WorkingWindow = { startHour: 9, endHour: 17 };

/** Google caps a single freeBusy query at ~3 months; stay well inside it. */
const MAX_QUERY_DAYS = 60;

/**
 * PURE: sort + merge overlapping/adjacent intervals into a minimal disjoint set.
 *
 * Google returns busy blocks per calendar, unmerged and not guaranteed sorted;
 * two meetings 2:00–3:00 and 2:30–4:00 are ONE busy block 2:00–4:00. Without
 * merging, the gap-finder below would emit a phantom "free" window between two
 * overlapping meetings. Touching intervals (3:00–4:00 after 2:00–3:00) merge
 * too — there is no free time between them.
 */
export function mergeIntervals(intervals: TimeInterval[]): TimeInterval[] {
  const valid = intervals
    .map((i) => ({ start: Date.parse(i.start), end: Date.parse(i.end) }))
    .filter((i) => Number.isFinite(i.start) && Number.isFinite(i.end) && i.end > i.start)
    .sort((a, b) => a.start - b.start);

  const merged: { start: number; end: number }[] = [];
  for (const current of valid) {
    const last = merged[merged.length - 1];
    if (last && current.start <= last.end) {
      // Overlapping or touching → extend, never append.
      last.end = Math.max(last.end, current.end);
    } else {
      merged.push({ ...current });
    }
  }
  return merged.map((i) => ({
    start: new Date(i.start).toISOString(),
    end: new Date(i.end).toISOString(),
  }));
}

/**
 * PURE: is [start, end) entirely free given a merged busy set?
 *
 * Half-open on purpose: a meeting ending at 3:00 does NOT conflict with one
 * starting at 3:00. Treating that as a clash would tell the user they're busy
 * when they are not, which is just as wrong as the reverse.
 */
export function isIntervalFree(
  target: TimeInterval,
  busy: TimeInterval[],
): boolean {
  const s = Date.parse(target.start);
  const e = Date.parse(target.end);
  if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return false;
  return !busy.some((b) => {
    const bs = Date.parse(b.start);
    const be = Date.parse(b.end);
    return bs < e && be > s;
  });
}

/** PURE: the busy blocks that overlap a target interval (what conflicts). */
export function conflictsIn(
  target: TimeInterval,
  busy: TimeInterval[],
): TimeInterval[] {
  const s = Date.parse(target.start);
  const e = Date.parse(target.end);
  return busy.filter((b) => {
    const bs = Date.parse(b.start);
    const be = Date.parse(b.end);
    return Number.isFinite(bs) && Number.isFinite(be) && bs < e && be > s;
  });
}

/**
 * PURE: the local-day sub-windows a search is allowed to offer, in a timezone.
 *
 * Splits an arbitrary [from, to) span into one bounded working window per local
 * calendar day, then clips each to the span. Uses the same DST-correct
 * `wallTimeToUtc` the reminders use, so "9am Monday" is 9am local even across a
 * DST boundary inside the range.
 */
export function workingWindowsIn(
  from: string,
  to: string,
  timeZone: string | undefined,
  window: WorkingWindow = DEFAULT_WORKING_WINDOW,
): TimeInterval[] {
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return [];

  const out: TimeInterval[] = [];
  // Walk local calendar days from the day `from` falls on. Iterate on the
  // calendar (not by adding 24h) so DST-shortened days can't drift the date.
  const firstDay = localYmdOf(new Date(fromMs), timeZone);
  if (!firstDay) return [];

  for (let dayOffset = 0; dayOffset <= MAX_QUERY_DAYS; dayOffset += 1) {
    const cursor = new Date(
      Date.UTC(firstDay.y, firstDay.m - 1, firstDay.d + dayOffset),
    );
    const y = cursor.getUTCFullYear();
    const m = cursor.getUTCMonth() + 1;
    const d = cursor.getUTCDate();

    const openMs = wallTimeToUtc(y, m, d, window.startHour, 0, timeZone).getTime();
    // endHour 24 means local midnight → express as hour 0 of the NEXT day.
    const closeMs =
      window.endHour >= 24
        ? wallTimeToUtc(y, m, d + 1, 0, 0, timeZone).getTime()
        : wallTimeToUtc(y, m, d, window.endHour, 0, timeZone).getTime();

    if (openMs > toMs) break;
    const clippedStart = Math.max(openMs, fromMs);
    const clippedEnd = Math.min(closeMs, toMs);
    if (clippedEnd > clippedStart) {
      out.push({
        start: new Date(clippedStart).toISOString(),
        end: new Date(clippedEnd).toISOString(),
      });
    }
  }
  return out;
}

/** PURE: local Y/M/D for an instant in a timezone. */
function localYmdOf(
  date: Date,
  timeZone: string | undefined,
): { y: number; m: number; d: number } | null {
  try {
    const dtf = new Intl.DateTimeFormat("en-CA", {
      timeZone: timeZone ?? "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const map: Record<string, number> = {};
    for (const p of dtf.formatToParts(date)) {
      if (p.type !== "literal") map[p.type] = Number(p.value);
    }
    if (!map.year || !map.month || !map.day) return null;
    return { y: map.year, m: map.month, d: map.day };
  } catch {
    return null;
  }
}

/**
 * PURE: the free gaps of at least `minMinutes`, inside the working windows of
 * [from, to), given a busy set.
 *
 * Subtracts merged busy blocks from each bounded working window and keeps the
 * remainders that are long enough to be worth offering. A window with no busy
 * overlap survives whole.
 */
export function computeFreeWindows(input: {
  from: string;
  to: string;
  busy: TimeInterval[];
  timeZone: string | undefined;
  minMinutes: number;
  workingWindow?: WorkingWindow;
  /** Never offer a slot before this instant (defaults to `from`). */
  notBefore?: string;
}): TimeInterval[] {
  const merged = mergeIntervals(input.busy);
  const minMs = Math.max(1, input.minMinutes) * 60_000;
  const floorMs = input.notBefore ? Date.parse(input.notBefore) : Date.parse(input.from);

  const free: TimeInterval[] = [];
  for (const window of workingWindowsIn(
    input.from,
    input.to,
    input.timeZone,
    input.workingWindow,
  )) {
    let cursor = Math.max(Date.parse(window.start), Number.isFinite(floorMs) ? floorMs : 0);
    const windowEnd = Date.parse(window.end);

    for (const block of merged) {
      const bs = Date.parse(block.start);
      const be = Date.parse(block.end);
      if (be <= cursor) continue;
      if (bs >= windowEnd) break;
      if (bs - cursor >= minMs) {
        free.push({
          start: new Date(cursor).toISOString(),
          end: new Date(Math.min(bs, windowEnd)).toISOString(),
        });
      }
      cursor = Math.max(cursor, be);
      if (cursor >= windowEnd) break;
    }
    if (windowEnd - cursor >= minMs) {
      free.push({
        start: new Date(cursor).toISOString(),
        end: new Date(windowEnd).toISOString(),
      });
    }
  }
  return free;
}

// --- Provider call -------------------------------------------------------

/** Resolve the connected connection id, or throw a safe `not_connected`. */
async function requireConnectionId(userId: string): Promise<string> {
  const connection = await getGoogleCalendarConnection(userId);
  if (!connection || connection.status !== "connected") {
    throw new GoogleCalendarError("not_connected", "Google Calendar is not connected");
  }
  return connection.id;
}

export interface FreeBusyOptions {
  timeMin: string;
  timeMax: string;
  /** Calendar to query. Defaults to the primary calendar. */
  calendarId?: string;
  timeZone?: string;
  fetchImpl?: FetchLike;
}

/**
 * Query Google's REAL free/busy for a window and return MERGED busy intervals.
 *
 * `freeBusy.query` is a POST that only reads — it mutates nothing, which is why
 * it is safe to run without a confirmation.
 *
 * The per-calendar `errors` array is the subtle failure this guards: Google
 * answers HTTP 200 with `{"busy": []}` AND an error entry when a calendar could
 * not actually be read (not found, or the grant lacks access). Taking that at
 * face value means reporting "you're completely free" for a calendar that was
 * never read — a fabricated answer wearing a 200. So an error entry throws, and
 * the caller tells the user it couldn't check.
 */
export async function queryFreeBusy(
  userId: string,
  options: FreeBusyOptions,
): Promise<TimeInterval[]> {
  const connectionId = await requireConnectionId(userId);
  const calendarId = options.calendarId ?? "primary";

  const body: Record<string, unknown> = {
    timeMin: options.timeMin,
    timeMax: options.timeMax,
    items: [{ id: calendarId }],
  };
  if (options.timeZone) body.timeZone = options.timeZone;

  const raw = await googleCalendarRequestForConnection<RawFreeBusyResponse>(
    connectionId,
    "POST",
    "/freeBusy",
    { query: {}, body },
    options.fetchImpl,
  );

  const calendars = raw?.calendars;
  if (!calendars || typeof calendars !== "object") {
    throw new GoogleCalendarError(
      "malformed_provider_response",
      "Google Calendar returned no free/busy calendars",
    );
  }

  // Google keys the result by the calendar id we asked for. Fall back to the
  // single returned entry when the key differs (aliases like "primary").
  const entry =
    calendars[calendarId] ??
    (Object.keys(calendars).length === 1
      ? calendars[Object.keys(calendars)[0]!]
      : undefined);

  if (!entry) {
    throw new GoogleCalendarError(
      "malformed_provider_response",
      "Google Calendar returned no free/busy entry for the calendar",
    );
  }

  if (Array.isArray(entry.errors) && entry.errors.length > 0) {
    // Never read an errored calendar as "no busy blocks".
    const reason = entry.errors[0]?.reason ?? "";
    throw new GoogleCalendarError(
      reason === "notFound" ? "calendar_not_found" : "provider_unavailable",
      "Google Calendar could not read free/busy for this calendar",
    );
  }

  if (!Array.isArray(entry.busy)) {
    throw new GoogleCalendarError(
      "malformed_provider_response",
      "Google Calendar free/busy response had no busy array",
    );
  }

  const intervals: TimeInterval[] = [];
  for (const block of entry.busy) {
    if (typeof block?.start !== "string" || typeof block?.end !== "string") continue;
    intervals.push({ start: block.start, end: block.end });
  }
  return mergeIntervals(intervals);
}
