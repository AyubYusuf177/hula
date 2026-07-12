import type { NormalizedGmailMessage } from "./types";

/**
 * Deterministic "likely-important" scoring (Section 14) — READ-ONLY heuristics.
 *
 * This module NEVER asks a model what the inbox contains. It scores each already
 * normalized, safe message with fixed, documented signals and selects the ones
 * that clear a documented threshold. The language it enables upstream is
 * deliberately hedged ("looks important" / "likely important") — it never claims
 * certainty.
 *
 * Signals (documented in the Section 14 spec):
 *   +5  Gmail IMPORTANT label
 *   +3  unread
 *   +2  received within the last 24 hours
 *   +2  action-oriented subject term
 *   +2  direct-looking sender / business communication
 *   -3  CATEGORY_PROMOTIONS
 *   -3  CATEGORY_SOCIAL
 *   -2  newsletter / bulk indicators
 *   -2  promotional no-reply patterns
 */

/** Messages scoring at or above this are surfaced as "likely important". */
export const IMPORTANCE_THRESHOLD = 5;

const MS_PER_HOUR = 60 * 60 * 1000;

/** Action-oriented subject terms (word-boundary, case-insensitive). */
export const ACTION_TERMS: readonly string[] = [
  "urgent",
  "action required",
  "interview",
  "appointment",
  "deadline",
  "payment",
  "invoice",
  "account",
  "confirmation",
  "verification",
  "application",
  "offer",
  "security",
  "booking",
  "document",
  "response required",
];

/** Newsletter / bulk sender or subject indicators. */
const BULK_PATTERNS: readonly RegExp[] = [
  /\bnewsletter\b/i,
  /\bunsubscribe\b/i,
  /\bdigest\b/i,
  /\bweekly\b/i,
  /\bpromo(?:tion|tional)?\b/i,
  /\bmarketing\b/i,
  /\bmailer\b/i,
  /\bbulletin\b/i,
];

/** Promotional / automated no-reply sender patterns. */
const NO_REPLY_PATTERNS: readonly RegExp[] = [
  /no-?reply/i,
  /do-?not-?reply/i,
  /\bnotifications?@/i,
  /\bmailer@/i,
  /\bmarketing@/i,
  /\bnews@/i,
  /\bnewsletter@/i,
];

/** PURE: does the subject contain an action-oriented term? */
export function hasActionTerm(subject: string | null | undefined): boolean {
  const s = (subject ?? "").toLowerCase();
  if (!s) return false;
  return ACTION_TERMS.some((term) => {
    // Word-ish boundary so "account" doesn't match "accountant" mid-word.
    const re = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    return re.test(s);
  });
}

/** PURE: does the sender look like a direct/business address (not bulk/no-reply)? */
export function looksDirectSender(msg: NormalizedGmailMessage): boolean {
  const addr = (msg.fromAddress ?? "").toLowerCase();
  if (!addr) return false;
  if (NO_REPLY_PATTERNS.some((re) => re.test(addr))) return false;
  if (BULK_PATTERNS.some((re) => re.test(addr))) return false;
  // A plausible person/business address with a real local-part and a named sender.
  const named = Boolean(msg.fromName && msg.fromName.trim().length > 0);
  const looksBulkFree = !msg.labels.includes("CATEGORY_PROMOTIONS") &&
    !msg.labels.includes("CATEGORY_SOCIAL");
  return named && looksBulkFree;
}

/** PURE: is the subject or sender a newsletter/bulk pattern? */
export function looksBulk(msg: NormalizedGmailMessage): boolean {
  const subject = msg.subject ?? "";
  const addr = msg.fromAddress ?? "";
  return BULK_PATTERNS.some((re) => re.test(subject) || re.test(addr));
}

/** PURE: is the sender a promotional/automated no-reply? */
export function looksNoReply(msg: NormalizedGmailMessage): boolean {
  const addr = msg.fromAddress ?? "";
  return NO_REPLY_PATTERNS.some((re) => re.test(addr));
}

/** The safe, explainable score breakdown for one message. */
export interface ImportanceScore {
  score: number;
  /** Safe, human-readable reasons (never message content beyond labels/flags). */
  reasons: string[];
}

/**
 * PURE: score one message deterministically. `now` is injectable so "within 24h"
 * is testable. Returns the numeric score and safe reason tags.
 */
export function scoreMessageImportance(
  msg: NormalizedGmailMessage,
  now: Date = new Date(),
): ImportanceScore {
  let score = 0;
  const reasons: string[] = [];

  if (msg.important) {
    score += 5;
    reasons.push("important_label");
  }
  if (msg.unread) {
    score += 3;
    reasons.push("unread");
  }
  if (msg.receivedAt) {
    const age = now.getTime() - Date.parse(msg.receivedAt);
    if (Number.isFinite(age) && age >= 0 && age <= 24 * MS_PER_HOUR) {
      score += 2;
      reasons.push("recent_24h");
    }
  }
  if (hasActionTerm(msg.subject)) {
    score += 2;
    reasons.push("action_subject");
  }
  if (looksDirectSender(msg)) {
    score += 2;
    reasons.push("direct_sender");
  }

  if (msg.labels.includes("CATEGORY_PROMOTIONS")) {
    score -= 3;
    reasons.push("promotions");
  }
  if (msg.labels.includes("CATEGORY_SOCIAL")) {
    score -= 3;
    reasons.push("social");
  }
  if (looksBulk(msg)) {
    score -= 2;
    reasons.push("bulk");
  }
  if (looksNoReply(msg)) {
    score -= 2;
    reasons.push("no_reply");
  }

  return { score, reasons };
}

/** A message paired with its importance score, for ranking. */
export interface ScoredGmailMessage {
  message: NormalizedGmailMessage;
  score: number;
  reasons: string[];
}

/**
 * PURE: score all messages and return the ones at/above the threshold, highest
 * score first (ties broken by most-recent). Never claims certainty — callers
 * must phrase these as "likely important".
 */
export function selectLikelyImportant(
  messages: readonly NormalizedGmailMessage[],
  now: Date = new Date(),
): ScoredGmailMessage[] {
  const scored: ScoredGmailMessage[] = messages.map((message) => {
    const { score, reasons } = scoreMessageImportance(message, now);
    return { message, score, reasons };
  });
  return scored
    .filter((s) => s.score >= IMPORTANCE_THRESHOLD)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const ta = a.message.receivedAt ? Date.parse(a.message.receivedAt) : 0;
      const tb = b.message.receivedAt ? Date.parse(b.message.receivedAt) : 0;
      return tb - ta;
    });
}
