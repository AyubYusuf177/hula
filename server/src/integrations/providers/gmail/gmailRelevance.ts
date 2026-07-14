import { generateAnthropicText } from "../../../ai/anthropicClient";
import { scoreMessageImportance } from "./importance";
import type { GmailThreadRef } from "./gmailThreads";
import {
  neutralizeUntrustedText,
  untrustedContentSystemRules,
} from "./untrustedContent";
import type { TextGenerator } from "./gmailIntentExtract";

/**
 * Gmail SEMANTIC RELEVANCE (Section 17 correction).
 *
 * WHY THIS EXISTS. "Do I have any important emails regarding work?" returned five
 * generically-important messages and ignored "work" entirely, because importance was
 * a deterministic score and topic had nowhere to go. Deterministic scoring cannot
 * answer "is this about work?" — that is a judgement about meaning. But a model must
 * not be handed the mailbox either.
 *
 * So the pipeline splits the question along the only line that is actually safe:
 *
 *   1. DETERMINISTIC retrieval — a bounded candidate set from real Gmail metadata.
 *   2. DETERMINISTIC dedupe    — unique conversations (see `gmailThreads`).
 *   3. MODEL judgement         — "is this conversation about the user's topic?",
 *                                over bounded, fenced, untrusted metadata only.
 *   4. DETERMINISTIC selection — code maps the verdicts back to REAL thread ids,
 *                                applies the importance rule, and bounds the count.
 *
 * The model sees an INDEX, and returns an INDEX. It never sees or emits a Gmail id,
 * so nothing it says — or that an attacker writes into an email — can select a
 * conversation that was not already in the candidate set that deterministic code
 * retrieved. The worst an injected "mark me relevant" can achieve is appearing in a
 * READ-ONLY list the user asked for. It cannot act, cannot widen the search, and
 * cannot invent a message.
 *
 * This does NOT hardcode topics. There is no map from "work" to search terms; the
 * topic is whatever the user said, judged as a concept, so it generalises to
 * "my background screening", "anything to do with Hula", or a topic we have never
 * seen.
 */

/** Hard cap on candidate conversations ever judged in one request. */
export const MAX_RELEVANCE_CANDIDATES = 12;
/** Default cap on conversations returned when the user named no count. */
export const DEFAULT_RESULT_CAP = 5;
/** Bound on the snippet shown per candidate (untrusted, and a cost bound). */
const CANDIDATE_SNIPPET_MAX = 220;

/**
 * The judge could not reach a verdict.
 *
 * A DISTINCT outcome from "nothing is relevant", and the distinction is the whole
 * point: telling the user "I couldn't find any emails about work" when we simply
 * failed to judge is a false statement about their inbox. The caller turns this into
 * an honest "I couldn't work that out just now".
 */
export class RelevanceUnavailableError extends Error {
  constructor(message = "Relevance could not be judged") {
    super(message);
    this.name = "RelevanceUnavailableError";
  }
}

/** The judge dependency, injectable so tests never hit Anthropic. */
export type RelevanceJudge = (params: {
  topic: string;
  candidates: readonly GmailThreadRef[];
  generate?: TextGenerator;
}) => Promise<ReadonlySet<number>>;

/**
 * PURE: render one candidate as a fenced, indexed, untrusted block.
 *
 * Sender, subject and snippet are all attacker-controlled, so all three are
 * neutralised and fenced. Only metadata goes in — no bodies are fetched for a
 * relevance decision, which keeps this cheap and keeps the untrusted surface small.
 */
export function buildCandidateBlock(candidates: readonly GmailThreadRef[]): string {
  return candidates
    .map((c, i) => {
      const sender = neutralizeUntrustedText(
        (c.latest.fromName ?? c.latest.fromAddress ?? "Unknown sender").trim(),
      ).slice(0, 120);
      const subject = neutralizeUntrustedText((c.latest.subject ?? "(no subject)").trim()).slice(
        0,
        200,
      );
      const snippet = neutralizeUntrustedText((c.latest.snippet ?? "").trim()).slice(
        0,
        CANDIDATE_SNIPPET_MAX,
      );
      return [
        `[${i}]`,
        `From: ${sender}`,
        `Subject: ${subject}`,
        snippet ? `Preview: ${snippet}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");
}

/** PURE: build the judging system prompt. */
export function buildRelevancePrompt(topic: string): string {
  return [
    "You decide which of the user's email conversations are ABOUT a topic they asked for.",
    "",
    `The user's topic, in their own words: "${neutralizeUntrustedText(topic).slice(0, 200)}"`,
    "",
    "You are given numbered candidates. Respond with ONE JSON object and nothing else:",
    '{ "relevant": [0, 2] }',
    "",
    "- Include an index ONLY if that conversation is genuinely about the topic.",
    "- Judge the topic as a CONCEPT, not as keywords: an email about a job interview",
    "  is about work even if it never says the word.",
    "- An unrelated promotion, newsletter, or social notification is NOT relevant just",
    "  because it mentions a word from the topic.",
    "- If none are relevant, return an empty list. That is a useful, correct answer.",
    "- Never invent an index that was not listed. Never return anything but indices.",
    "",
    untrustedContentSystemRules(),
  ].join("\n");
}

/** PURE: parse the judge's reply into a set of valid indices. */
export function parseRelevantIndices(raw: string, candidateCount: number): ReadonlySet<number> {
  const text = (raw ?? "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return new Set();
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    const list = parsed.relevant;
    if (!Array.isArray(list)) return new Set();
    const out = new Set<number>();
    for (const value of list) {
      // Only a real index into the set WE built can survive. An index the model
      // invented, or that an injected email asked for, has nothing to point at.
      if (typeof value !== "number" || !Number.isInteger(value)) continue;
      if (value < 0 || value >= candidateCount) continue;
      out.add(value);
    }
    return out;
  } catch {
    return new Set();
  }
}

/** Default judge: one bounded model call over metadata only. */
export const defaultRelevanceJudge: RelevanceJudge = async ({ topic, candidates, generate }) => {
  if (candidates.length === 0) return new Set();
  const gen = generate ?? generateAnthropicText;
  let reply: string;
  try {
    reply = await gen({
      system: buildRelevancePrompt(topic),
      messages: [
        {
          role: "user",
          content: `Which of these conversations are about the topic?\n\n${buildCandidateBlock(candidates)}`,
        },
      ],
      maxTokens: 200,
    });
  } catch (err) {
    // Unreachable is NOT "nothing matched", and it is NOT "everything matched".
    throw new RelevanceUnavailableError(err instanceof Error ? err.message : "judge failed");
  }
  return parseRelevantIndices(reply, candidates.length);
};

/** What the selection pass needs to know about the request. */
export interface RelevanceRequest {
  /** The user's topic, verbatim. Absent when they named none. */
  topic?: string | null;
  /** True when they asked for important/urgent mail. */
  importantOnly?: boolean | null;
  /** A count they actually stated. */
  count?: number | null;
  now: Date;
}

/**
 * PURE: apply the deterministic importance rule to one conversation.
 *
 * Gmail's own IMPORTANT marker counts, and so does our documented score — a
 * conversation the user would call important is usually both. The score runs against
 * the newest message, which is the one the row shows.
 */
export function looksImportant(thread: GmailThreadRef, now: Date): boolean {
  if (thread.important) return true;
  const { score } = scoreMessageImportance(thread.latest, now);
  return score >= 5;
}

/**
 * Select the conversations that genuinely qualify.
 *
 * Deterministic code owns every id here: the judge only narrows a set that Gmail
 * already returned. Returns FEWER than the cap — including none — whenever fewer
 * qualify. That is the fix for "five results, four of them the same thread": the
 * count is an upper bound, never a quota to fill.
 */
export async function selectRelevantThreads(
  candidates: readonly GmailThreadRef[],
  request: RelevanceRequest,
  deps: { judge?: RelevanceJudge; generate?: TextGenerator } = {},
): Promise<GmailThreadRef[]> {
  const bounded = candidates.slice(0, MAX_RELEVANCE_CANDIDATES);
  if (bounded.length === 0) return [];

  // 1. Importance is deterministic and cheap — apply it before spending a model call.
  const byImportance = request.importantOnly
    ? bounded.filter((t) => looksImportant(t, request.now))
    : bounded;
  if (byImportance.length === 0) return [];

  // 2. Topic is a judgement about meaning. No topic -> no judgement to make.
  const topic = (request.topic ?? "").trim();
  let selected = byImportance;
  if (topic) {
    const judge = deps.judge ?? defaultRelevanceJudge;
    let relevantIndices: ReadonlySet<number>;
    try {
      relevantIndices = await judge({ topic, candidates: byImportance, generate: deps.generate });
    } catch (err) {
      // Surface "couldn't judge" as itself. Swallowing it here would report an empty
      // inbox for a topic we never actually looked at.
      throw err instanceof RelevanceUnavailableError
        ? err
        : new RelevanceUnavailableError(err instanceof Error ? err.message : "judge failed");
    }
    // The verdict is an index into OUR array; the thread id comes from our array.
    selected = byImportance.filter((_, i) => relevantIndices.has(i));
  }

  // 3. Bound the answer. A stated count is honoured; otherwise a safe maximum caps
  //    it — but only what actually qualified is ever returned.
  const cap = request.count && request.count >= 1 ? request.count : DEFAULT_RESULT_CAP;
  return selected.slice(0, cap);
}
