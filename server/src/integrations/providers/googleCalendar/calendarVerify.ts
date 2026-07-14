import type { NormalizedCalendarEvent } from "./types";

/**
 * Calendar postcondition verification (Section 18).
 *
 * Mirrors `gmailVerify`: after a write, Hula RE-READS the event and checks that
 * reality matches what it is about to tell the user. Only then does it report
 * success.
 *
 * WHY A SEPARATE READ, when the write already returned the event? Because the
 * write's response is Google's echo of the request it just processed, and there
 * are real cases where the echo and the calendar disagree — most importantly the
 * conference one: `events.insert` WITHOUT `conferenceDataVersion=1` returns a
 * clean 200 describing an event with no Meet, having silently discarded the
 * conference request. Every field in that response looks right. The only way to
 * catch it is to state the expectation up front and check it against a fresh
 * read.
 *
 * The functions here are PURE comparisons; the caller supplies the re-fetched
 * event. A FAILED verification is never fatal on its own — it means Hula must
 * describe what it actually observed instead of what it intended.
 */

/** What a write claimed it would produce. Every field is optional. */
export interface EventExpectation {
  title?: string;
  /** Expected start as an absolute instant (timed events). */
  startIso?: string;
  endIso?: string;
  /** Expected start as `YYYY-MM-DD` (all-day events). */
  startDate?: string;
  location?: string;
  description?: string;
  /** Expected attendee addresses (compared case-insensitively, order-free). */
  attendees?: string[];
  /** True when a Google Meet was requested and should now exist. */
  expectMeet?: boolean;
}

/** One field that did not match, named safely for logs and honest replies. */
export type EventMismatch =
  | "title"
  | "start"
  | "end"
  | "location"
  | "description"
  | "attendees"
  | "conference";

export interface EventVerification {
  ok: boolean;
  mismatches: EventMismatch[];
  /**
   * True ONLY when a Meet was expected and Google is still allocating it. This
   * is NOT a failure — it is a real, honest intermediate state that the reply
   * must describe rather than paper over.
   */
  conferencePending: boolean;
}

/** PURE: compare two instants by VALUE, tolerating format differences. */
function sameInstant(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return false;
  // Google echoes an offset form ("...T13:00:00-04:00") where we sent a Z form.
  // These are the same moment; comparing strings would report a false mismatch.
  return ta === tb;
}

/** PURE: trimmed, case-insensitive text equality. */
function sameText(a: string | null | undefined, b: string | null | undefined): boolean {
  return (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();
}

/**
 * PURE: verify a re-fetched event against what the write promised.
 *
 * Only stated expectations are checked — an absent field is not an assertion, so
 * an update that changed the time says nothing about the title.
 */
export function verifyEventState(
  actual: NormalizedCalendarEvent | null,
  expected: EventExpectation,
): EventVerification {
  const mismatches: EventMismatch[] = [];
  let conferencePending = false;

  if (!actual) {
    // Nothing came back: every stated expectation is unmet. Reporting success
    // here is exactly the fabrication this module exists to prevent.
    const all: EventMismatch[] = [];
    if (expected.title !== undefined) all.push("title");
    if (expected.startIso !== undefined || expected.startDate !== undefined) all.push("start");
    if (expected.endIso !== undefined) all.push("end");
    if (expected.location !== undefined) all.push("location");
    if (expected.description !== undefined) all.push("description");
    if (expected.attendees !== undefined) all.push("attendees");
    if (expected.expectMeet) all.push("conference");
    return { ok: false, mismatches: all.length > 0 ? all : ["title"], conferencePending: false };
  }

  if (expected.title !== undefined && !sameText(actual.summary, expected.title)) {
    mismatches.push("title");
  }
  if (expected.startIso !== undefined && !sameInstant(actual.start, expected.startIso)) {
    mismatches.push("start");
  }
  if (expected.endIso !== undefined && !sameInstant(actual.end, expected.endIso)) {
    mismatches.push("end");
  }
  if (expected.startDate !== undefined) {
    // All-day: Google returns a bare `YYYY-MM-DD`, which must match exactly.
    if (!actual.allDay || (actual.start ?? "") !== expected.startDate) {
      mismatches.push("start");
    }
  }
  if (expected.location !== undefined && !sameText(actual.location, expected.location)) {
    mismatches.push("location");
  }
  if (expected.description !== undefined && !sameText(actual.description, expected.description)) {
    mismatches.push("description");
  }
  if (expected.attendees !== undefined) {
    const want = new Set(expected.attendees.map((e) => e.trim().toLowerCase()).filter(Boolean));
    const have = new Set(actual.attendees.map((a) => a.email.trim().toLowerCase()));
    // Every requested attendee must be present. Google adds the organizer's own
    // row unbidden, so `have` may legitimately be a superset — requiring exact
    // equality would fail every correct invite.
    const missing = [...want].filter((e) => !have.has(e));
    if (missing.length > 0) mismatches.push("attendees");
  }
  if (expected.expectMeet) {
    const conference = actual.conference;
    if (conference?.meetUrl) {
      // A real, validated link exists. Verified.
    } else if (conference?.status === "pending") {
      conferencePending = true;
    } else {
      mismatches.push("conference");
    }
  }

  return { ok: mismatches.length === 0, mismatches, conferencePending };
}
