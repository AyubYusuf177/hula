import { randomUUID } from "node:crypto";

import type {
  CalendarConference,
  ConferenceStatus,
  RawGoogleConferenceData,
} from "./types";

/**
 * Google Meet conference data (Section 18).
 *
 * THE ONE RULE THIS FILE EXISTS TO ENFORCE: a Meet URL is only ever a string
 * Google sent us. Hula never builds one, never guesses one from a conference id,
 * and never reports a link before Google has actually allocated the conference.
 *
 * That rule is not pedantry. A Meet URL is trivially *shaped* — `https://
 * meet.google.com/xxx-yyyy-zzz` — so a plausible-looking link can be fabricated
 * from an id in one line of code. It would look completely correct in an iMessage
 * and fail for everyone who clicked it, including people the user invited. The
 * only defence is that the URL is never derived from anything but a validated
 * `entryPoints` entry in Google's own response.
 *
 * How Google actually creates a Meet (verified against the Calendar API):
 *   1. `events.insert`/`events.patch` carries `conferenceData.createRequest` with
 *      a caller-generated `requestId` and `conferenceSolutionKey.type =
 *      "hangoutsMeet"`.
 *   2. The request MUST set `conferenceDataVersion=1`, or Google silently ignores
 *      the conference entirely and returns a perfectly normal event with no Meet
 *      — a success response for a request that did not do what was asked.
 *   3. The response's `conferenceData.createRequest.status.statusCode` is
 *      `success`, `pending`, or `failure`. Only `success` comes with entry points.
 *
 * `requestId` is the idempotency key: repeating a request with the SAME id
 * returns the SAME conference instead of allocating a second one, so it is
 * generated once at proposal time and replayed verbatim by the executor.
 *
 * Everything here is PURE and unit-tested. No network, no DB.
 */

/** The conference solution key Google requires for a Google Meet. */
export const HANGOUTS_MEET_SOLUTION = "hangoutsMeet" as const;

/** Google's entry-point type for the clickable video link. */
const VIDEO_ENTRY_POINT = "video" as const;
const PHONE_ENTRY_POINT = "phone" as const;

/**
 * PURE: is this a real, Google-issued Meet URL?
 *
 * Deliberately strict. It must parse as a URL, be https, and sit on a host Google
 * actually serves Meet from. Anything else — an http link, a look-alike host, a
 * `javascript:` URI, an empty string — is rejected and the conference reports as
 * having no usable link rather than passing an attacker-influenced or malformed
 * string on to the user. Provider data is untrusted input, including this.
 */
export function isValidMeetUrl(uri: unknown): uri is string {
  if (typeof uri !== "string" || uri.trim().length === 0) return false;
  let url: URL;
  try {
    url = new URL(uri.trim());
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  // Exact hosts only — a suffix check would accept "meet.google.com.evil.test".
  return host === "meet.google.com" || host === "meet.google.co.uk";
}

/**
 * PURE: read Google's conference create status. An ABSENT status is treated as
 * `success` because Google omits `createRequest` entirely on an event whose
 * conference already exists (a plain read of an event with a Meet); the caller
 * still only reports a link if a valid entry point survives validation, so this
 * can never manufacture a success on its own.
 */
export function readConferenceStatus(
  raw: RawGoogleConferenceData | undefined,
): ConferenceStatus {
  const code = raw?.createRequest?.status?.statusCode;
  if (code === "pending") return "pending";
  if (code === "failure") return "failure";
  if (code === "success") return "success";
  return "success";
}

/**
 * PURE: normalize Google's `conferenceData` into the safe shape, or null when the
 * event has no conference at all.
 *
 * `meetUrl` is non-null ONLY when a `video` entry point exists AND its URI passes
 * `isValidMeetUrl`. A `pending` or `failure` conference therefore always reports
 * `meetUrl: null`, which is what lets every caller above this line stay honest
 * without re-implementing the check.
 */
export function normalizeConferenceData(
  raw: RawGoogleConferenceData | undefined,
): CalendarConference | null {
  if (!raw || typeof raw !== "object") return null;

  const status = readConferenceStatus(raw);
  const entryPoints = Array.isArray(raw.entryPoints) ? raw.entryPoints : [];

  const video = entryPoints.find(
    (e) => e?.entryPointType === VIDEO_ENTRY_POINT && isValidMeetUrl(e?.uri),
  );
  const phone = entryPoints.find(
    (e) => e?.entryPointType === PHONE_ENTRY_POINT && typeof e?.uri === "string",
  );

  const hasAnySignal =
    video !== undefined ||
    phone !== undefined ||
    typeof raw.conferenceId === "string" ||
    raw.createRequest !== undefined;
  if (!hasAnySignal) return null;

  return {
    status,
    // A link is reported ONLY from a validated video entry point. Never derived
    // from `conferenceId`, which would be fabrication.
    meetUrl: video && isValidMeetUrl(video.uri) ? video.uri.trim() : null,
    conferenceId: typeof raw.conferenceId === "string" ? raw.conferenceId : null,
    phoneNumber: phone && typeof phone.uri === "string" ? phone.uri : null,
  };
}

/**
 * Generate a UNIQUE conference `requestId`.
 *
 * Uniqueness matters in both directions. Two different events must never share an
 * id (Google would hand back the first event's conference for the second event),
 * and one event confirmed twice must reuse its id (or a duplicate delivery
 * allocates a second Meet). This generates; the proposal STORES the result and
 * the executor replays it — that split is what makes the retry safe.
 */
export function generateConferenceRequestId(): string {
  return randomUUID();
}

/** PURE: the `conferenceData` body that asks Google to allocate a new Meet. */
export function buildConferenceCreateRequest(requestId: string): {
  createRequest: {
    requestId: string;
    conferenceSolutionKey: { type: string };
  };
} {
  return {
    createRequest: {
      requestId,
      conferenceSolutionKey: { type: HANGOUTS_MEET_SOLUTION },
    },
  };
}

/**
 * PURE: the honest, user-facing description of a conference result.
 *
 * Each branch is a DIFFERENT truth and they must not be collapsed:
 *  - a real link → give it;
 *  - `pending` → Google accepted the request but has not allocated the Meet yet,
 *    so say that and point at the event, rather than waiting or inventing;
 *  - `failure` / no conference → say plainly that no link was created. Reporting
 *    a Meet that does not exist is the single worst failure this feature has.
 */
export function describeConference(conference: CalendarConference | null): string {
  if (!conference) return "";
  if (conference.meetUrl) return conference.meetUrl;
  if (conference.status === "pending") {
    return "Google is still setting up the Meet link — it’ll appear on the event shortly.";
  }
  return "Google didn’t create a Meet link for this one.";
}
