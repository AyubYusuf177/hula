import type { TimeInterval } from "./freeBusy";
import type { CalendarAttendee, NormalizedCalendarEvent } from "./types";

/**
 * Calendar presentation (Section 18) — PURE formatting for iMessage.
 *
 * Everything here is grounded: each line is built from fields Google actually
 * returned. Nothing is inferred, and a field we don't have is simply omitted
 * rather than filled in with a plausible guess. A raw provider payload never
 * reaches a reply.
 *
 * The formatting target is a phone. Long lines wrap badly in a message bubble,
 * so events get a compact headline plus only the detail lines that carry real
 * information — a location if there is one, attendees when they matter, a Meet
 * link when Google actually issued one.
 */

/** Titles are user/provider text — bound them so one can't flood a message. */
const MAX_TITLE = 120;
/** Beyond this many attendees, list a few and count the rest. */
const MAX_ATTENDEES_SHOWN = 3;

/** PURE: an event's display title, bounded. */
export function eventTitle(event: { summary: string | null }): string {
  const s = (event.summary ?? "").trim();
  if (s.length === 0) return "(untitled event)";
  return s.length > MAX_TITLE ? `${s.slice(0, MAX_TITLE - 1)}…` : s;
}

/** PURE: format an instant's clock time in a timezone ("1:00 PM"). */
export function formatClock(iso: string | null, tz: string | undefined): string {
  if (!iso) return "";
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(iso));
  } catch {
    return "";
  }
}

/** PURE: format an instant's weekday + date ("Mon, Jul 14") in a timezone. */
export function formatDay(iso: string | null, tz: string | undefined): string {
  if (!iso) return "";
  try {
    // An all-day `YYYY-MM-DD` has no time part; parsing it as UTC midnight and
    // then formatting in a WESTERN timezone would roll it back a day. Format the
    // bare date in UTC so "Jul 14" stays Jul 14 wherever the user is.
    const allDay = /^\d{4}-\d{2}-\d{2}$/.test(iso);
    return new Intl.DateTimeFormat("en-US", {
      timeZone: allDay ? "UTC" : tz,
      weekday: "short",
      month: "short",
      day: "numeric",
    }).format(new Date(allDay ? `${iso}T00:00:00Z` : iso));
  } catch {
    return "";
  }
}

/** PURE: the short timezone label ("EDT"), for when it genuinely helps. */
export function formatTimeZoneLabel(iso: string | null, tz: string | undefined): string {
  if (!iso || !tz) return "";
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      timeZoneName: "short",
    }).formatToParts(new Date(iso));
    return parts.find((p) => p.type === "timeZoneName")?.value ?? "";
  } catch {
    return "";
  }
}

/**
 * PURE: "Mon, Jul 14 from 1:00 PM to 2:00 PM", degrading gracefully.
 *
 * `includeTimeZone` is opt-in rather than always-on: the user's own timezone is
 * noise on every line of their own schedule, but it is essential on a single
 * confirmed event ("2:00 PM EDT") where a misread would mean a missed meeting.
 */
export function formatEventWhen(
  event: Pick<NormalizedCalendarEvent, "start" | "end" | "allDay">,
  tz: string | undefined,
  options: { includeDay?: boolean; includeTimeZone?: boolean } = {},
): string {
  const includeDay = options.includeDay ?? true;
  const day = includeDay ? formatDay(event.start, tz) : "";

  if (event.allDay) return day ? `${day} (all day)` : "all day";

  const from = formatClock(event.start, tz);
  const to = formatClock(event.end, tz);
  const zone = options.includeTimeZone ? formatTimeZoneLabel(event.start, tz) : "";
  const suffix = zone ? ` ${zone}` : "";

  if (day && from && to) return `${day} from ${from} to ${to}${suffix}`;
  if (day && from) return `${day} at ${from}${suffix}`;
  if (from && to) return `${from} to ${to}${suffix}`;
  if (from) return `${from}${suffix}`;
  return day;
}

/** PURE: an attendee's display name — the name if we have one, else the address. */
export function attendeeLabel(attendee: CalendarAttendee): string {
  const name = (attendee.displayName ?? "").trim();
  return name.length > 0 ? name : attendee.email;
}

/**
 * PURE: the attendee summary line, excluding the user themselves.
 *
 * "You and 3 others" is what a person would say; listing the user's own address
 * back to them is noise.
 */
export function formatAttendees(attendees: CalendarAttendee[]): string {
  const others = attendees.filter((a) => !a.self);
  if (others.length === 0) return "";
  if (others.length <= MAX_ATTENDEES_SHOWN) {
    return others.map(attendeeLabel).join(", ");
  }
  const shown = others.slice(0, MAX_ATTENDEES_SHOWN).map(attendeeLabel).join(", ");
  return `${shown} +${others.length - MAX_ATTENDEES_SHOWN} more`;
}

/**
 * PURE: one full event card.
 *
 * Every optional line is genuinely optional — an event with no location, no
 * attendees, and no Meet renders as a clean two-line card rather than a form
 * with empty fields.
 */
export function formatEventDetail(
  event: NormalizedCalendarEvent,
  tz: string | undefined,
): string {
  const lines: string[] = [eventTitle(event)];
  const when = formatEventWhen(event, tz, { includeDay: true, includeTimeZone: true });
  if (when) lines.push(when);
  if (event.location) lines.push(`📍 ${event.location}`);

  const attendees = formatAttendees(event.attendees);
  if (attendees) lines.push(`👥 ${attendees}`);

  // A link is printed ONLY when Google issued a validated one. `pending` and
  // `failure` say what is actually true instead.
  if (event.conference?.meetUrl) {
    lines.push(`🎥 ${event.conference.meetUrl}`);
  } else if (event.conference?.status === "pending") {
    lines.push("🎥 Meet link still being created by Google");
  }
  return lines.join("\n");
}

/** PURE: one compact line in a numbered list. */
export function formatEventLine(
  event: NormalizedCalendarEvent,
  tz: string | undefined,
  options: { includeDay?: boolean } = {},
): string {
  const when = formatEventWhen(event, tz, { includeDay: options.includeDay ?? false });
  const bits = [when, eventTitle(event)].filter(Boolean);
  return bits.join(" — ");
}

/**
 * PURE: a NUMBERED list of events.
 *
 * Numbered rather than bulleted because the numbers are load-bearing: they are
 * exactly what "cancel the second one" resolves against, and the stored
 * selection snapshot uses this same order.
 */
export function formatEventList(
  events: NormalizedCalendarEvent[],
  tz: string | undefined,
  options: { header?: string; includeDay?: boolean } = {},
): string {
  const lines = events.map(
    (e, i) => `${i + 1}. ${formatEventLine(e, tz, { includeDay: options.includeDay })}`,
  );
  return options.header ? `${options.header}\n${lines.join("\n")}` : lines.join("\n");
}

// --- Availability formatting ---------------------------------------------

/** PURE: "1:00–2:00 PM" for a free window, in a timezone. */
export function formatWindow(window: TimeInterval, tz: string | undefined): string {
  const from = formatClock(window.start, tz);
  const to = formatClock(window.end, tz);
  return from && to ? `${from}–${to}` : from || to;
}

/**
 * PURE: group free windows by local day and render them.
 *
 * A flat list of eight windows over a week is unreadable in a message; grouped
 * by day it reads like something a person would say.
 */
export function formatFreeWindows(
  windows: TimeInterval[],
  tz: string | undefined,
  options: { includeDay?: boolean; max?: number } = {},
): string {
  const max = options.max ?? 6;
  const shown = windows.slice(0, max);
  if (!options.includeDay) {
    return shown.map((w) => `• ${formatWindow(w, tz)}`).join("\n");
  }

  const byDay = new Map<string, TimeInterval[]>();
  for (const w of shown) {
    const day = formatDay(w.start, tz);
    const list = byDay.get(day) ?? [];
    list.push(w);
    byDay.set(day, list);
  }
  return [...byDay.entries()]
    .map(([day, list]) => `• ${day}: ${list.map((w) => formatWindow(w, tz)).join(", ")}`)
    .join("\n");
}
