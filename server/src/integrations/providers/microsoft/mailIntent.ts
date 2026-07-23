import { z } from "zod";

import { generateAnthropicText } from "../../../ai/anthropicClient";
import {
  structuredBoolean,
  structuredInteger,
  structuredJsonObjectCandidates,
  structuredRecord,
  structuredStringList,
  structuredToken,
} from "../../../ai/structuredJson";
import {
  classifyOutlookModelFailure,
  type OutlookModelDiagnostic,
} from "./mailModelFailure";
import { textForProviderMentionDetection } from "../../providerMentions";

const nullableText = (max: number) => z.string().trim().min(1).max(max).nullable().optional();
const OUTLOOK_INTENT_ATTEMPTS = 2;

export const OutlookIntentSchema = z.object({
  provider: z.enum(["outlook", "gmail", "unknown", "not_mail"]),
  operation: z.enum([
    "list", "search", "folders", "get", "summarize", "question", "compare", "attachments",
    "create_draft", "create_reply_draft", "create_reply_all_draft", "create_forward_draft",
    "update_draft", "delete_draft", "send", "reply", "reply_all", "forward", "send_draft",
    "mark_read", "mark_unread", "not_mail",
  ]),
  count: z.number().int().min(1).max(20).nullable().optional(),
  ordinal: z.number().int().min(1).max(20).nullable().optional(),
  secondOrdinal: z.number().int().min(1).max(20).nullable().optional(),
  query: nullableText(300),
  sender: nullableText(200),
  subject: nullableText(300),
  folder: nullableText(200),
  unread: z.boolean().nullable().optional(),
  receivedAfter: nullableText(64),
  receivedBefore: nullableText(64),
  question: nullableText(500),
  to: z.array(z.string().trim().email()).max(50).nullable().optional(),
  cc: z.array(z.string().trim().email()).max(50).nullable().optional(),
  bcc: z.array(z.string().trim().email()).max(50).nullable().optional(),
  draftBody: nullableText(20_000),
  draftSubject: nullableText(998),
  draftSubjectSource: z.enum(["explicit", "inferred"]).nullable().optional(),
  proposalRevision: z.boolean().nullable().optional(),
  useContext: z.boolean().nullable().optional(),
  requiresFresh: z.boolean().nullable().optional(),
});

export type OutlookIntent = z.infer<typeof OutlookIntentSchema>;

export type OutlookIntentGenerator = (params: {
  system: string;
  messages: { role: "user" | "assistant"; content: string }[];
  maxTokens?: number;
  timeoutMs?: number;
}) => Promise<string>;

const operationAliases: Record<string, OutlookIntent["operation"]> = {
  draft: "create_draft",
  compose: "create_draft",
  compose_draft: "create_draft",
  draft_email: "create_draft",
  create_email_draft: "create_draft",
  reply_draft: "create_reply_draft",
  draft_reply: "create_reply_draft",
  reply_all_draft: "create_reply_all_draft",
  draft_reply_all: "create_reply_all_draft",
  forward_draft: "create_forward_draft",
  draft_forward: "create_forward_draft",
  edit_draft: "update_draft",
  remove_draft: "delete_draft",
  send_email: "send",
  email_send: "send",
  reply_email: "reply",
  replyall: "reply_all",
  reply_all_email: "reply_all",
  forward_email: "forward",
  send_existing_draft: "send_draft",
  mark_as_read: "mark_read",
  mark_as_unread: "mark_unread",
};

const providerAliases: Record<string, OutlookIntent["provider"]> = {
  microsoft: "outlook",
  microsoft_365: "outlook",
  outlook_mail: "outlook",
  office_365: "outlook",
  email: "unknown",
  mail: "unknown",
};

function normalizedOperation(value: unknown): OutlookIntent["operation"] | null {
  const token = structuredToken(value);
  if (!token) return null;
  if (OutlookIntentSchema.shape.operation.safeParse(token).success) {
    return token as OutlookIntent["operation"];
  }
  return operationAliases[token] ?? null;
}

function normalizedProvider(value: unknown): OutlookIntent["provider"] {
  const token = structuredToken(value);
  if (token && OutlookIntentSchema.shape.provider.safeParse(token).success) {
    return token as OutlookIntent["provider"];
  }
  return token ? providerAliases[token] ?? "unknown" : "unknown";
}

function normalizedSubjectSource(value: unknown): "explicit" | "inferred" | null {
  const token = structuredToken(value);
  if (token === "explicit" || token === "user" || token === "user_provided") return "explicit";
  if (token === "inferred" || token === "generated" || token === "model") return "inferred";
  return null;
}

/**
 * Normalize harmless model representation drift, then let the strict schema
 * validate semantics. This never reads the user's prose or invents a mutation.
 */
export function normalizeOutlookIntentCandidate(candidate: unknown): Record<string, unknown> | null {
  const value = structuredRecord(candidate);
  if (!value) return null;
  const operation = normalizedOperation(value.operation ?? value.action ?? value.intent);
  if (!operation) return null;
  const writeOperation = new Set<OutlookIntent["operation"]>([
    "create_draft", "create_reply_draft", "create_reply_all_draft", "create_forward_draft",
    "update_draft", "delete_draft", "send", "reply", "reply_all", "forward", "send_draft",
  ]).has(operation);
  const recipientSource = value.to ?? value.recipients ?? value.recipient;
  const bodySource = value.draftBody ?? value.body ?? value.messageBody ?? value.message ?? value.content;
  const subjectSource = value.draftSubject ?? (writeOperation ? value.subject : undefined);
  return {
    ...value,
    provider: normalizedProvider(value.provider ?? value.service),
    operation,
    count: structuredInteger(value.count, 1, 20) ?? value.count,
    ordinal: structuredInteger(value.ordinal, 1, 20) ?? value.ordinal,
    secondOrdinal: structuredInteger(value.secondOrdinal, 1, 20) ?? value.secondOrdinal,
    to: structuredStringList(recipientSource),
    cc: structuredStringList(value.cc),
    bcc: structuredStringList(value.bcc),
    draftBody: typeof bodySource === "string" ? bodySource.trim() || null : bodySource ?? null,
    draftSubject: typeof subjectSource === "string" ? subjectSource.trim() || null : subjectSource ?? null,
    draftSubjectSource: normalizedSubjectSource(value.draftSubjectSource ?? value.subjectSource),
    proposalRevision:
      structuredBoolean(value.proposalRevision ?? value.isRevision ?? value.revisePending)
      ?? value.proposalRevision
      ?? value.isRevision
      ?? value.revisePending,
    unread: structuredBoolean(value.unread) ?? value.unread,
    useContext: structuredBoolean(value.useContext) ?? value.useContext,
    requiresFresh: structuredBoolean(value.requiresFresh) ?? value.requiresFresh,
  };
}

export function explicitMailProvider(text: string): "outlook" | "gmail" | null {
  const providerText = textForProviderMentionDetection(text);
  if (/\boutlook\s+(?:calendar|meetings?|events?)\b|\b(?:microsoft|office\s*365)\s+(?:calendar|meetings?|events?)\b/i.test(providerText)) return null;
  if (/\b(?:outlook|microsoft\s*(?:365)?\s*(?:mail|email|inbox)|hotmail|live\.com)\b/i.test(providerText)) return "outlook";
  if (/\bgmail\b/i.test(providerText)) return "gmail";
  return null;
}

/** A broad domain gate only; the semantic extractor decides the operation. */
export function shouldConsiderMail(text: string, hasMailContext = false): boolean {
  if (!text.trim()) return false;
  if (/\boutlook\s+(?:calendar|meetings?|events?)\b|\b(?:microsoft|office\s*365)\s+(?:calendar|meetings?|events?)\b/i.test(text) && !/\b(?:mail|email|inbox|message|reply|draft)\b/i.test(text)) return false;
  if (hasMailContext && /\b(?:it|that|this|here|one|them|those|these|first|second|third|him|her|reply|respond|response|forward|draft|unread|read|gist|need|deadline|attachment|tell|write back|say|thank|supposed to do)\b/i.test(text)) return true;
  return /\b(?:outlook|gmail|e-?mails?|mails?|inbox|sender|subject|draft|reply|respond|forward|unread|sent items|attachments?)\b/i.test(text)
    || /\b(?:draft|compose|prepare|write|send|email|forward)\b[^.!?]{0,180}\b[^\s@]+@[^\s@]+\.[^\s@]+\b/i.test(text)
    || /\b[^\s@]+@[^\s@]+\.[^\s@]+\b[^.!?]{0,180}\b(?:draft|compose|prepare|write|send|email|forward)\b/i.test(text)
    || /\b(?:what|anything|something)\s+(?:came|come)\s+in\b/i.test(text)
    || /\bdid\s+.+\s+(?:send|email)\b/i.test(text)
    || /\banything\s+from\s+[^?]{1,120}/i.test(text)
    || /\b(?:find|pull up|show me)\b[^.!?]{0,160}\b(?:sent me|from|note|message)\b/i.test(text);
}

export function buildOutlookIntentPrompt(input: {
  nowIso: string;
  timezone: string;
  hasContext: boolean;
  pendingMailOperation?: string | null;
  pendingMailProvider?: string | null;
}): string {
  return [
    "You extract one EMAIL intent for Hula. Return one JSON object only, no prose.",
    `Current instant: ${input.nowIso}. User timezone: ${input.timezone}.`,
    `A fresh selected email/draft context exists: ${input.hasContext}.`,
    `Active pending email proposal: ${input.pendingMailProvider ?? "none"} / ${input.pendingMailOperation ?? "none"}.`,
    "Provider is outlook only when the user explicitly says Outlook/Microsoft/Hotmail, or when the caller-supplied context is Outlook.",
    "Provider is gmail only when explicitly stated. Generic email language is unknown; never choose by preference.",
    "Resolve today/yesterday into exact ISO [after,before) boundaries in the stated timezone.",
    "",
    "Schema:",
    JSON.stringify({
      provider: "outlook|gmail|unknown|not_mail",
      operation: "list|search|folders|get|summarize|question|compare|attachments|create_draft|create_reply_draft|create_reply_all_draft|create_forward_draft|update_draft|delete_draft|send|reply|reply_all|forward|send_draft|mark_read|mark_unread|not_mail",
      count: null,
      ordinal: null,
      secondOrdinal: null,
      query: null,
      sender: null,
      subject: null,
      folder: null,
      unread: null,
      receivedAfter: null,
      receivedBefore: null,
      question: null,
      to: null,
      cc: null,
      bcc: null,
      draftBody: null,
      draftSubject: null,
      draftSubjectSource: "explicit|inferred|null",
      proposalRevision: null,
      useContext: null,
      requiresFresh: null,
    }),
    "",
    "Intent rules:",
    "- Listing/recent/latest/what came in -> list. Any sender, subject, keyword, date, folder, or unread qualifier may be search.",
    "- Open/show/read one result -> get. Asking what it means, wants, requires, key points, action items, deadlines, importance, or gist -> summarize/question.",
    "- Set useContext true for plural follow-ups about the shown set (them/these/those/which emails) and for an inbox overview or recent-email summary.",
    "- Set requiresFresh true only when the user explicitly asks to refresh, re-check, verify a current provider state, or see whether the message changed. Ordinary interpretation of an already selected message is not fresh.",
    "- Attachment questions -> attachments. Metadata is not attachment content.",
    "- Draft/compose/prepare/save/leave unsent/do not send -> create_draft or create_reply_draft. Draft never means send.",
    "- An imperative asking Hula to transmit a new message now -> send. Verbs such as email, send, or shoot a message express transmission unless the user explicitly asks to draft, save, leave unsent, or not send.",
    "- With selected mail, tell the sender/respond/write back/reply with content -> reply because the user is asking to transmit a response.",
    "- Use create_reply_draft only when the user explicitly asks to draft/compose/save a reply or says not to send it.",
    "- Reply-all only when explicitly requested. Plain reply never becomes reply_all.",
    "- Forward requires a destination. Never invent an email address from a person's name.",
    "- mark/keep as read or unread -> mark_read/mark_unread.",
    "- A statement that the user has read or seen the selected message -> mark_read. A question asking whether it is read remains question.",
    "- Copy the user's requested message body faithfully into draftBody. Do not embellish it.",
    "- to, cc, and bcc MUST be JSON arrays of exact email-address strings, even when there is only one address.",
    "- For a NEW draft/send with an explicit subject, copy it exactly into draftSubject and set draftSubjectSource=explicit.",
    "- For a NEW draft/send with meaningful body content but no explicit subject, infer a short natural subject grounded only in that body and set draftSubjectSource=inferred.",
    "- Replies/reply-all preserve the conversation subject; do not invent a new unrelated subject.",
    "- When an active pending mail proposal exists and the user explicitly corrects its provider or changes send to draft, preserve its existing slots conceptually, classify only the requested operation/provider change, and set proposalRevision=true.",
    "- An ordinary new request is not a proposal revision; set proposalRevision=false or null.",
    "- Use draftSubject for a composed message subject and draftBody for its requested content.",
    "- Never invent a recipient, sender, date, ordinal, folder, count, or facts not grounded in the requested body.",
    "- Calendar, files, tasks, Slack, Notion, Asana, reminders, and ordinary conversation are not_mail.",
  ].join("\n");
}

export function parseOutlookIntent(raw: string): OutlookIntent | null {
  for (const candidate of structuredJsonObjectCandidates(raw)) {
    const normalized = normalizeOutlookIntentCandidate(candidate);
    const result = OutlookIntentSchema.safeParse(normalized);
    if (result.success) return result.data;
  }
  return null;
}

export async function extractOutlookIntent(input: {
  text: string;
  now?: Date;
  timezone?: string;
  hasContext?: boolean;
  pendingMailOperation?: string | null;
  pendingMailProvider?: string | null;
  generate?: OutlookIntentGenerator;
  onDiagnostic?: (diagnostic: OutlookModelDiagnostic) => void;
}): Promise<OutlookIntent | null> {
  const generate = input.generate ?? generateAnthropicText;
  const system = buildOutlookIntentPrompt({
    nowIso: (input.now ?? new Date()).toISOString(),
    timezone: input.timezone ?? "UTC",
    hasContext: input.hasContext === true,
    pendingMailOperation: input.pendingMailOperation,
    pendingMailProvider: input.pendingMailProvider,
  });
  let messages: { role: "user" | "assistant"; content: string }[] = [{ role: "user", content: input.text }];
  for (let attempt = 0; attempt < OUTLOOK_INTENT_ATTEMPTS; attempt += 1) {
    let raw: string;
    try {
      raw = await generate({
        system,
        messages,
        maxTokens: 800,
        timeoutMs: 12_000,
      });
    } catch (error) {
      const failure = classifyOutlookModelFailure(error, "intent_generation");
      input.onDiagnostic?.({ stage: failure.stage, classification: failure.classification });
      if (failure.retryable && attempt + 1 < OUTLOOK_INTENT_ATTEMPTS) continue;
      return null;
    }
    const parsed = parseOutlookIntent(raw);
    if (parsed) {
      return input.hasContext === true && parsed.provider === "unknown"
        ? { ...parsed, provider: "outlook" }
        : parsed;
    }
    input.onDiagnostic?.({ stage: "intent_parse", classification: raw.trim() ? "malformed" : "empty_response" });
    if (attempt + 1 >= OUTLOOK_INTENT_ATTEMPTS) return null;
    messages = [
      { role: "user", content: input.text },
      { role: "assistant", content: raw.slice(0, 10_000) },
      {
        role: "user",
        content: "Repair only the JSON representation. Preserve the same safe semantic operation and user-supplied values. Return one schema-valid object; recipient fields must be arrays. Do not add recipients, content, or a send instruction.",
      },
    ];
  }
  return null;
}

/** High-confidence fallback for explicit provider requests when AI is unavailable. */
export function explicitOutlookIntent(text: string): OutlookIntent | null {
  if (explicitMailProvider(text) !== "outlook") return null;
  const lower = text.toLowerCase();
  if (/\b(?:draft|compose|write|send|reply|respond|forward|mark|delete|remove|edit|update)\b/.test(lower)) return null;
  const countMatch = /\b(\d{1,2})\b/.exec(lower);
  const count = countMatch ? Math.min(20, Math.max(1, Number(countMatch[1]))) : null;
  if (/\bfolders?\b/.test(lower)) return OutlookIntentSchema.parse({ provider: "outlook", operation: "folders" });
  if (/\bunread\b/.test(lower)) return OutlookIntentSchema.parse({ provider: "outlook", operation: "search", unread: true, count });
  if (/\b(?:latest|recent|inbox|emails?|mail)\b/.test(lower)) return OutlookIntentSchema.parse({ provider: "outlook", operation: "list", count });
  return null;
}
