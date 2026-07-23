import { z } from "zod";

import { generateAnthropicText } from "../../../ai/anthropicClient";
import { structuredJsonObjectCandidates } from "../../../ai/structuredJson";
import {
  buildUntrustedEmailBlock,
  untrustedContentSystemRules,
} from "../gmail/untrustedContent";
import type { OutlookMessage } from "./mailTypes";
import {
  classifyOutlookModelFailure,
  type OutlookModelDiagnostic,
} from "./mailModelFailure";

const OUTLOOK_ANALYSIS_TIMEOUT_MS = 30_000;
const OUTLOOK_ANALYSIS_ATTEMPTS = 2;

export type OutlookAnalysisDepth = "concise" | "multi_message" | "detailed";

export const OutlookAnalysisSchema = z.object({
  answer: z.string().trim().min(1).max(2000),
  explicitActionItems: z.array(z.string().trim().min(1).max(300)).max(10),
  explicitDeadlines: z.array(z.string().trim().min(1).max(300)).max(10),
  inference: z.string().trim().max(500),
  replyNeeded: z.enum(["yes", "no", "unclear"]),
});

export type OutlookAnalysis = z.infer<typeof OutlookAnalysisSchema>;

export type OutlookAnalysisGenerator = (params: {
  system: string;
  messages: { role: "user" | "assistant"; content: string }[];
  maxTokens?: number;
  timeoutMs?: number;
}) => Promise<string>;

function sender(message: OutlookMessage): string {
  const from = message.sender ?? message.from;
  return from ? from.name ? `${from.name} <${from.address}>` : from.address : "Unknown sender";
}

function evidence(message: OutlookMessage, index: number, label?: string): string {
  const attachmentLine = message.attachments.length
    ? `\nAttachment metadata only: ${message.attachments.map((item) => `${item.name} (${item.contentType ?? "unknown type"}, ${item.size} bytes)`).join(", ")}`
    : "";
  return [
    label ?? `MESSAGE ${index + 1}`,
    `Received: ${message.receivedAt ?? "unknown"}`,
    `Read state: ${message.isRead ? "read" : "unread"}`,
    `Provider importance flag: ${message.importance}`,
    buildUntrustedEmailBlock({
      sender: sender(message),
      subject: message.subject,
      body: message.body ?? message.preview,
    }),
    attachmentLine,
  ].join("\n");
}

export function outlookAnalysisDepth(question: string, messageCount: number): OutlookAnalysisDepth {
  if (/\b(?:detailed|in[- ]depth|deep\s+dive|explain\s+fully|full\s+explanation|thorough|comprehensive|step[- ]by[- ]step)\b/i.test(question)) {
    return "detailed";
  }
  return messageCount > 1 ? "multi_message" : "concise";
}

function responseDepthRules(depth: OutlookAnalysisDepth): string[] {
  if (depth === "detailed") {
    return [
      "The user explicitly requested detail. Give enough explanation to answer fully, but avoid repetition and irrelevant metadata.",
      "Keep answer self-contained and distinguish interpretations with words such as likely, appears, or suggests.",
    ];
  }
  if (depth === "multi_message") {
    return [
      "Synthesize the supplied messages directly. Avoid repeating the same metadata for every message.",
      "Normally keep answer under 180 words. Use concise comparisons or bullets only when they materially improve clarity.",
    ];
  }
  return [
    "This is an iMessage response about one selected message. Be concise by default.",
    "Answer in 1-3 short sentences and normally under 90 words.",
    "Use 1-2 sentences for a direct factual question; use at most 3 for a gist, summary, or implication.",
    "Do not repeat sender, date, subject, body, or read state unless the question asks for it or it is necessary to answer.",
    "State the underlying takeaway directly; do not narrate that the evidence has a subject or body, and do not quote it unless asked.",
    "For a simple confirmation or informational message, state the takeaway and whether any request or deadline exists without padding.",
  ];
}

export function buildOutlookAnalysisPrompt(
  question: string,
  messages: OutlookMessage[],
  depth = outlookAnalysisDepth(question, messages.length),
  evidenceLabels?: string[],
): string {
  return [
    "Answer the user's question using ONLY the supplied Outlook message evidence.",
    untrustedContentSystemRules(),
    "The provider importance flag is evidence about an Outlook flag, not proof of human importance.",
    "Attachment metadata proves only that an attachment exists. Never claim to have read an attachment.",
    "Put only directly stated tasks in explicitActionItems and only directly stated dates/times in explicitDeadlines.",
    "If you make a useful interpretation, label it as inference and never rewrite it as fact.",
    "Do not claim coverage beyond these supplied messages. Do not claim any action was taken.",
    "For comparisons, the supplied comparison-role line identifies each email using the order Hula displayed. That displayed order remains authoritative even when timestamps differ.",
    "Use comparison roles only to understand identity. Never repeat role labels or narrate ordinal mapping, timestamp sorting, selection state, or internal context mechanics.",
    "Never use internal vocabulary such as RESULT, active selection, active entity, selection metadata, context entity, entity owner, immutable ID, result-set context, provider arbitration, or internal ordinal mapping.",
    "A timestamp difference is an ordinary factual difference, never evidence that displayed labels are mismatched.",
    "For a simple comparison, state the shared meaning first, then only meaningful differences such as request, deadline, changed information, attachments, wording, sender, or timing.",
    "The answer field must directly answer the question and must not duplicate the action-item, deadline, or inference fields.",
    ...responseDepthRules(depth),
    "Return one JSON object only in exactly this shape:",
    '{"answer":"grounded answer","explicitActionItems":[],"explicitDeadlines":[],"inference":"","replyNeeded":"yes|no|unclear"}',
    "replyNeeded must be one of the strings yes, no, or unclear — never a boolean.",
    "",
    `USER QUESTION: ${question.slice(0, 500)}`,
    "",
    messages.map((message, index) => evidence(message, index, evidenceLabels?.[index])).join("\n\n"),
  ].join("\n");
}

function wordCount(value: string): number {
  return value.trim().split(/\s+/).filter(Boolean).length;
}

function sentenceCount(value: string): number {
  return value.split(/[.!?]+(?:["'”’)]*)?(?:\s+|$)/).filter((item) => item.trim()).length;
}

export function analysisMatchesDepth(analysis: OutlookAnalysis, depth: OutlookAnalysisDepth): boolean {
  if (depth === "detailed") return true;
  if (depth === "multi_message") return wordCount(analysis.answer) <= 180;
  return wordCount(analysis.answer) <= 90 && sentenceCount(analysis.answer) <= 3;
}

const INTERNAL_PRESENTATION_TERMS = /\b(?:result\s*\d+|active\s+selection|active\s+entity|selection\s+metadata|context\s+entity|entity\s+owner|immutable\s+id|result[- ]set\s+context|provider\s+arbitration|internal\s+ordinal\s+mapping|labels?\s+(?:are\s+)?mismatched|mismatched\s+labels?)\b/i;

export function analysisMatchesPresentationContract(analysis: OutlookAnalysis): boolean {
  return !INTERNAL_PRESENTATION_TERMS.test(analysis.answer);
}

export function parseOutlookAnalysis(raw: string): OutlookAnalysis | null {
  for (const candidate of structuredJsonObjectCandidates(raw)) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const value = candidate as Record<string, unknown>;
    const replyNeeded = value.replyNeeded === true
      ? "yes"
      : value.replyNeeded === false
        ? "no"
        : value.replyNeeded ?? "unclear";
    const result = OutlookAnalysisSchema.safeParse({
      ...value,
      explicitActionItems: value.explicitActionItems ?? [],
      explicitDeadlines: value.explicitDeadlines ?? [],
      inference: value.inference ?? "",
      replyNeeded,
    });
    if (result.success) return result.data;
  }
  return null;
}

function groundedExcerpt(message: OutlookMessage): string {
  const content = (message.body || message.preview || message.subject).replace(/\s+/g, " ").trim();
  if (!content) return `Subject: ${message.subject}`;
  return content.length > 500 ? `${content.slice(0, 497).trimEnd()}…` : content;
}

/** A non-inventive last resort when deeper read-only reasoning is unavailable. */
export function fallbackOutlookAnalysis(messages: OutlookMessage[]): OutlookAnalysis {
  const excerpts = messages.slice(0, 2).map(groundedExcerpt);
  const answer = excerpts.length === 1
    ? `I couldn’t complete the deeper analysis, but the message itself says: “${excerpts[0]}”`
    : `I couldn’t complete the deeper analysis, but the grounded messages say:\n${excerpts.map((item) => `• “${item}”`).join("\n")}`;
  return {
    answer,
    explicitActionItems: [],
    explicitDeadlines: [],
    inference: "",
    replyNeeded: "unclear",
  };
}

export async function analyzeOutlookMessages(input: {
  question: string;
  messages: OutlookMessage[];
  evidenceLabels?: string[];
  generate?: OutlookAnalysisGenerator;
  onDiagnostic?: (diagnostic: OutlookModelDiagnostic) => void;
}): Promise<OutlookAnalysis> {
  if (!input.messages.length) throw new Error("outlook_analysis_requires_evidence");
  const messages = input.messages.slice(0, 5);
  const generate = input.generate ?? generateAnthropicText;
  const depth = outlookAnalysisDepth(input.question, messages.length);
  const system = buildOutlookAnalysisPrompt(input.question, messages, depth, input.evidenceLabels);
  for (let attempt = 0; attempt < OUTLOOK_ANALYSIS_ATTEMPTS; attempt += 1) {
    let raw: string;
    try {
      raw = await generate({
        system,
        messages: [{
          role: "user",
          content: attempt === 0
            ? "Analyse only the fenced evidence and return the JSON result."
            : "Return schema-valid JSON only. Keep the answer natural and user-facing; do not mention evidence labels, result numbers, selection/context internals, or label mismatches. replyNeeded must be the string yes, no, or unclear, and list fields must be arrays.",
        }],
        maxTokens: depth === "concise" ? 450 : depth === "multi_message" ? 700 : 900,
        timeoutMs: OUTLOOK_ANALYSIS_TIMEOUT_MS,
      });
    } catch (error) {
      const failure = classifyOutlookModelFailure(error, "analysis_generation");
      input.onDiagnostic?.({ stage: failure.stage, classification: failure.classification });
      if (attempt + 1 < OUTLOOK_ANALYSIS_ATTEMPTS && failure.retryable) continue;
      return fallbackOutlookAnalysis(messages);
    }

    const parsed = parseOutlookAnalysis(raw);
    if (parsed && analysisMatchesDepth(parsed, depth) && analysisMatchesPresentationContract(parsed)) return parsed;
    input.onDiagnostic?.({
      stage: "analysis_parse",
      classification: raw.trim() ? "malformed" : "empty_response",
    });
    // One schema-repair generation is safe: analysis is read-only and cannot act.
  }
  return fallbackOutlookAnalysis(messages);
}

function normalizedForCoverage(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function isCoveredByAnswer(answer: string, item: string): boolean {
  const normalizedAnswer = normalizedForCoverage(answer);
  const normalizedItem = normalizedForCoverage(item);
  return normalizedItem.length > 5 && normalizedAnswer.includes(normalizedItem);
}

export function formatOutlookAnalysis(analysis: OutlookAnalysis, question = ""): string {
  const lines = [analysis.answer];
  const actionItems = analysis.explicitActionItems.filter((item) => !isCoveredByAnswer(analysis.answer, item));
  const deadlines = analysis.explicitDeadlines.filter((item) => !isCoveredByAnswer(analysis.answer, item));
  if (actionItems.length) {
    lines.push("", "Action items explicitly stated:", ...actionItems.map((item) => `• ${item}`));
  }
  if (deadlines.length) {
    lines.push("", "Deadlines explicitly stated:", ...deadlines.map((item) => `• ${item}`));
  }
  if (
    outlookAnalysisDepth(question, 1) === "detailed" &&
    analysis.inference &&
    !isCoveredByAnswer(analysis.answer, analysis.inference)
  ) {
    lines.push("", `Inference: ${analysis.inference}`);
  }
  return lines.join("\n");
}
