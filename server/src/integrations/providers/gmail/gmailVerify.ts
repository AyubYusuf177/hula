import type { GmailThreadState } from "./gmailThreads";

/**
 * Gmail POSTCONDITION contract (Section 17 correction) — PURE.
 *
 * WHY THIS EXISTS. Real testing produced the worst failure in the product: Hula said
 * "Unstarred 1 email" while Gmail still showed the star. A 2xx from Gmail was being
 * treated as proof of the outcome. It is not — it only proves the request was
 * accepted for the message we named, which is a different claim from "the
 * conversation the user is looking at now looks the way they asked".
 *
 * So every mutation declares, in advance, the state it must be able to PROVE, and
 * the state is then read back from Gmail. No claim of success is made from anything
 * else.
 *
 * The scope of each expectation is chosen from Gmail's VISIBLE conversation
 * behaviour, which is the thing the user is actually judging us against:
 *
 *  - A conversation shows a star while ANY message in it is starred. So "starred"
 *    only needs one starred message, but "unstarred" needs EVERY star gone. That
 *    asymmetry is the entire bug from the transcript: we removed one star of
 *    several and called it done.
 *  - Same shape for unread (any message unread -> the row is bold) and for the
 *    inverse, read (no message may stay unread).
 */

/** A state one mutation must be able to prove about a conversation. */
export interface StateExpectation {
  /** The Gmail label the claim is about. */
  label: string;
  /** Must the label be present, or absent? */
  present: boolean;
  /**
   * `any` — at least one message satisfies it (enough for the row to show it).
   * `all` — every message must, because one exception leaves the row unchanged.
   */
  scope: "any" | "all";
}

/** The conversation-level operations that mutate state. */
export type GmailMutationAction =
  | "star"
  | "unstar"
  | "archive"
  /** Put an archived conversation back in the inbox — the reverse of `archive`. */
  | "unarchive"
  | "mark_read"
  | "mark_unread"
  | "trash"
  | "untrash"
  | "add_label"
  | "remove_label";

/**
 * PURE: the state a completed action must be able to prove.
 *
 * `labelId` is required for add_label/remove_label (the user's real, resolved label)
 * and ignored otherwise. Returns null only for an action with no resolved label,
 * which the caller treats as "cannot verify" — never as success.
 */
export function expectationFor(
  action: GmailMutationAction,
  labelId?: string | null,
): StateExpectation | null {
  switch (action) {
    // One starred message is enough for the row to show a star (Gmail's own rule).
    case "star":
      return { label: "STARRED", present: true, scope: "any" };
    // Every star must go, or the row still shows one — the shipped bug.
    case "unstar":
      return { label: "STARRED", present: false, scope: "all" };
    // Archiving hides the conversation only when no message keeps INBOX.
    case "archive":
      return { label: "INBOX", present: false, scope: "all" };
    case "unarchive":
      return { label: "INBOX", present: true, scope: "any" };
    case "mark_read":
      return { label: "UNREAD", present: false, scope: "all" };
    case "mark_unread":
      return { label: "UNREAD", present: true, scope: "any" };
    case "trash":
      return { label: "TRASH", present: true, scope: "all" };
    case "untrash":
      return { label: "TRASH", present: false, scope: "all" };
    case "add_label": {
      const id = (labelId ?? "").trim();
      return id ? { label: id, present: true, scope: "any" } : null;
    }
    case "remove_label": {
      const id = (labelId ?? "").trim();
      return id ? { label: id, present: false, scope: "all" } : null;
    }
    default:
      return null;
  }
}

/**
 * PURE: does the conversation's real state satisfy the expectation?
 *
 * A thread with no messages returns FALSE for every expectation: we cannot prove
 * anything about a conversation we could not read, and "cannot prove" must never
 * become "done".
 */
export function verifyThreadState(
  state: GmailThreadState,
  expectation: StateExpectation,
): boolean {
  const messages = state.messages ?? [];
  if (messages.length === 0) return false;

  const has = (labels: readonly string[]): boolean => labels.includes(expectation.label);

  if (expectation.present) {
    return expectation.scope === "any" ? messages.some((m) => has(m.labelIds)) : messages.every((m) => has(m.labelIds));
  }
  return expectation.scope === "any"
    ? messages.some((m) => !has(m.labelIds))
    : messages.every((m) => !has(m.labelIds));
}

/**
 * PURE: the reversing action, or null when the action is not safely reversible.
 *
 * This is the WHOLE definition of "undo" — it is a lookup against verified last
 * actions, never a general instruction. `trash` maps back to `untrash` because Gmail
 * keeps trashed mail; a send has no entry here and never will, because nothing can
 * unsend a delivered email.
 */
export function reverseOf(action: GmailMutationAction): GmailMutationAction | null {
  switch (action) {
    case "star":
      return "unstar";
    case "unstar":
      return "star";
    case "mark_read":
      return "mark_unread";
    case "mark_unread":
      return "mark_read";
    case "archive":
      return "unarchive";
    case "unarchive":
      return "archive";
    case "trash":
      return "untrash";
    case "untrash":
      return "trash";
    case "add_label":
      return "remove_label";
    case "remove_label":
      return "add_label";
    default:
      return null;
  }
}
