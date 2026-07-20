import { z } from "zod";

import { generateAnthropicText } from "../../../ai/anthropicClient";

export const DriveOperationSchema = z.enum([
  "status",
  "recent",
  "list",
  "search",
  "metadata",
  "owner",
  "modified_time",
  "link",
  "parent",
  "summarize",
  "key_points",
  "decisions",
  "action_items",
  "deadlines",
  "question",
  "compare",
  "create_folder",
  "create_doc",
  "not_drive",
]);

export const DriveIntentSchema = z.object({
  provider: z.enum([
    "google_drive", "gmail", "calendar", "slack", "notion", "todoist",
    "asana", "reminder", "memory", "unknown",
  ]),
  operation: DriveOperationSchema,
  query: z.string().trim().min(1).max(500).nullable().optional(),
  name: z.string().trim().min(1).max(300).nullable().optional(),
  searchField: z.enum(["name", "full_text", "both"]).nullable().optional(),
  mimeCategory: z.enum([
    "google_doc", "pdf", "folder", "plain_text", "markdown", "any",
  ]).nullable().optional(),
  createdAfter: z.string().max(50).nullable().optional(),
  createdBefore: z.string().max(50).nullable().optional(),
  modifiedAfter: z.string().max(50).nullable().optional(),
  modifiedBefore: z.string().max(50).nullable().optional(),
  starred: z.boolean().nullable().optional(),
  ownerEmail: z.string().email().max(320).nullable().optional(),
  sharedWithMe: z.boolean().nullable().optional(),
  position: z.number().int().min(1).max(20).nullable().optional(),
  comparePosition: z.number().int().min(1).max(20).nullable().optional(),
  question: z.string().trim().min(1).max(1_000).nullable().optional(),
  content: z.string().max(12_000).nullable().optional(),
  count: z.number().int().min(1).max(20).nullable().optional(),
  unresolvedReference: z.boolean().default(false),
  needsClarification: z.boolean().default(false),
});

export type DriveIntent = z.infer<typeof DriveIntentSchema>;
export type DriveIntentGenerator = typeof generateAnthropicText;

const OTHER_PROVIDER = /\b(?:gmail|email|inbox|calendar|meeting|event|slack|todoist|asana|notion|remind|memory)\b/i;
const DRIVE_EVIDENCE = /\bgoogle\s+drive\b|\bdrive\s+(?:file|folder|document|doc|link)s?\b|\bgoogle\s+docs?\b|\bdocs\.google\.com\b|\bdrive\.google\.com\b/i;
const FILE_DOMAIN = /\b(?:files?|folders?|documents?|docs?|pdfs?|markdown)\b/i;
const READ_REQUEST = /^(?:who|what|when|where|why|how|which|summari[sz]e|list|show|tell|give|read|extract|find)\b/i;
const QUOTED_NAME = /["“][^"”\r\n]{2,300}["”]/u;
const FILE_NAME = /\b[^\s/\\]+\.(?:pdf|docx?|xlsx?|pptx?|txt|md|rtf|csv)\b/i;
const TITLE_PHRASE = /\b(?:[A-Z0-9][\p{L}\p{N}.'’_-]*)(?:\s+[A-Z0-9][\p{L}\p{N}.'’_-]*)+\b/u;

/**
 * Admit an explicit, concrete-looking name for semantic classification and
 * authoritative provider discovery. This does not claim Drive ownership.
 */
function hasExplicitNamedReadShape(value: string): boolean {
  if (!READ_REQUEST.test(value)) return false;
  return QUOTED_NAME.test(value) || FILE_NAME.test(value) || TITLE_PHRASE.test(value);
}

/** Broad enough to ask the semantic arbiter, but never enough to claim Drive. */
export function shouldConsiderGoogleDrive(text: string | undefined, arbitrated = false): boolean {
  const value = (text ?? "").trim();
  if (!value) return false;
  if (arbitrated) return true;
  if (DRIVE_EVIDENCE.test(value)) return true;
  if (OTHER_PROVIDER.test(value)) return false;
  return FILE_DOMAIN.test(value) || hasExplicitNamedReadShape(value);
}

export function buildDriveIntentPrompt(context: boolean, now = new Date()): string {
  return [
    "Interpret one user request for provider routing. Return strict JSON only; never answer or execute it.",
    "Choose google_drive only for Google Drive/Google Docs, an explicit Drive URL, or verified Drive entity context.",
    "Gmail email stays Gmail; meetings/events stay Calendar; Slack content stays Slack; Notion pages/databases stay Notion; tasks stay Todoist/Asana; reminders and memory stay Hula.",
    "Generic verbs such as find, create, add, update, share, document, or file do not select Drive by themselves.",
    "A read request may explicitly name a concrete document without naming its provider. Preserve the exact name and requested read operation, set provider to unknown, and set unresolvedReference to false. Do not assume it is in Drive; the provider handler will claim it only after an authoritative exact-name Drive lookup succeeds.",
    "If there is neither explicit provider evidence nor a concrete named entity, choose unknown and not_drive.",
    context
      ? "Verified durable context is available for an unresolved pronoun or ordinal. If the user names a file, preserve its exact name, set unresolvedReference to false, and let that name override older context."
      : "No verified Drive context was supplied. Do not invent conversational context. An explicit name may still be returned as an unknown-provider discovery candidate.",
    "Never output a Google Drive q expression, file ID, folder ID, or raw provider syntax. Output natural terms and allowlisted filter fields only.",
    "searchField name means filename only; full_text means Drive provider fullText; both means both concepts. This is provider indexed search, not semantic vector search.",
    "Use exact ownerEmail only when the user supplied an email. A person's name is not an authoritative owner email; set needsClarification instead of inventing one.",
    "Create operations are limited to a folder in My Drive root or a new Google Doc in My Drive root. Existing-file edits, moves, deletes, uploads, and sharing are not supported.",
    "For create_doc, name is the title and content is the initial user-provided body. For create_folder, name is the folder name.",
    "For a content question, operation is question and question preserves the user's question. Use summarize/key_points/decisions/action_items/deadlines for those explicit analysis modes.",
    "For compare, position is the first/current reference and comparePosition is the other ordinal when stated.",
    `Current UTC time: ${now.toISOString()}. Resolve relative date filters to ISO timestamps.`,
    `Operations: ${DriveOperationSchema.options.join(", ")}.`,
    `Shape: ${JSON.stringify({ provider: "google_drive", operation: "search", query: null, name: null, searchField: "both", mimeCategory: "any", createdAfter: null, createdBefore: null, modifiedAfter: null, modifiedBefore: null, starred: null, ownerEmail: null, sharedWithMe: null, position: null, comparePosition: null, question: null, content: null, count: 10, unresolvedReference: false, needsClarification: false })}`,
  ].join("\n");
}

export function parseDriveIntent(raw: string): DriveIntent | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = DriveIntentSchema.safeParse(JSON.parse(raw.slice(start, end + 1)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function extractDriveIntent(input: {
  text: string;
  context?: boolean;
  generate?: DriveIntentGenerator;
  now?: Date;
}): Promise<DriveIntent | null> {
  try {
    const raw = await (input.generate ?? generateAnthropicText)({
      system: buildDriveIntentPrompt(Boolean(input.context), input.now),
      messages: [{ role: "user", content: input.text }],
      maxTokens: 700,
      timeoutMs: 12_000,
    });
    return parseDriveIntent(raw);
  } catch {
    return null;
  }
}

/** High-confidence fallback for explicit Drive shapes when semantic AI is unavailable. */
export function explicitDriveIntent(text: string): DriveIntent | null {
  const value = text.trim();
  if (!DRIVE_EVIDENCE.test(value)) return null;
  const lower = value.toLowerCase();
  if (/\b(?:connected|connection|connect)\b/.test(lower)) {
    return DriveIntentSchema.parse({ provider: "google_drive", operation: "status" });
  }
  const folder = /\bcreate\s+(?:a\s+)?(?:google\s+drive\s+)?folder(?:\s+(?:called|named)\s+|\s+)([^.!?]{1,300})/i.exec(value);
  if (folder) return DriveIntentSchema.parse({ provider: "google_drive", operation: "create_folder", name: folder[1]?.trim() });
  const doc = /\bcreate\s+(?:a\s+)?google\s+doc(?:ument)?(?:\s+(?:called|named|titled)\s+|\s+)([^.!?]{1,300})/i.exec(value);
  if (doc) return DriveIntentSchema.parse({ provider: "google_drive", operation: "create_doc", name: doc[1]?.trim(), content: "" });
  const summarize = /\bsummari[sz]e\b.{0,80}\bgoogle\s+doc(?:ument)?\b(?:\s+(?:called|named|titled)\s+)?([^.!?]{1,300})?/i.exec(value);
  if (summarize) return DriveIntentSchema.parse({
    provider: "google_drive",
    operation: "summarize",
    name: summarize[1]?.trim() || undefined,
  });
  if (/\b(?:recent|recently|latest|newest)\b/.test(lower)) {
    return DriveIntentSchema.parse({ provider: "google_drive", operation: "recent", count: 10 });
  }
  if (/\b(?:list|show|find|search)\b/.test(lower)) {
    return DriveIntentSchema.parse({ provider: "google_drive", operation: "list", count: 10 });
  }
  return null;
}
