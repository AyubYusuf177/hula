import { z } from "zod";

import { generateAnthropicText } from "../../../ai/anthropicClient";
import {
  structuredInteger,
  structuredJsonObjectCandidates,
  structuredRecord,
  structuredToken,
} from "../../../ai/structuredJson";
import { normalizeOneDriveRequestedName } from "./oneDriveDiscovery";

const ONEDRIVE_INTENT_ATTEMPTS = 2;

export const OneDriveIntentSchema = z.object({
  provider: z.enum(["onedrive", "google_drive", "unknown", "not_file"]),
  operation: z.enum([
    "root", "recent", "list_folder", "search", "get", "metadata", "owner", "modified", "link",
    "summarize", "key_points", "action_items", "deadlines", "decisions", "question", "compare", "not_file",
  ]),
  query: z.string().trim().min(1).max(300).nullable().optional(),
  name: z.string().trim().min(1).max(300).nullable().optional(),
  ordinal: z.number().int().min(1).max(20).nullable().optional(),
  secondOrdinal: z.number().int().min(1).max(20).nullable().optional(),
  question: z.string().trim().min(1).max(1_000).nullable().optional(),
  count: z.number().int().min(1).max(20).nullable().optional(),
});

export type OneDriveIntent = z.infer<typeof OneDriveIntentSchema>;
export type OneDriveIntentGenerator = typeof generateAnthropicText;

const oneDriveOperationAliases: Record<string, OneDriveIntent["operation"]> = {
  list_root: "root",
  latest: "recent",
  latest_files: "recent",
  list_files: "list_folder",
  folder: "list_folder",
  find: "search",
  find_file: "search",
  open: "get",
  open_file: "get",
  details: "metadata",
  file_details: "metadata",
  last_modified: "modified",
  get_link: "link",
  gist: "summarize",
  summary: "summarize",
  actionitems: "action_items",
  q_and_a: "question",
};

function normalizeOneDriveCandidate(candidate: unknown): Record<string, unknown> | null {
  const value = structuredRecord(candidate);
  if (!value) return null;
  const operationToken = structuredToken(value.operation ?? value.action ?? value.intent);
  const operation = operationToken && OneDriveIntentSchema.shape.operation.safeParse(operationToken).success
    ? operationToken as OneDriveIntent["operation"]
    : operationToken ? oneDriveOperationAliases[operationToken] : null;
  if (!operation) return null;
  const providerToken = structuredToken(value.provider ?? value.service);
  const provider = providerToken && OneDriveIntentSchema.shape.provider.safeParse(providerToken).success
    ? providerToken
    : providerToken && ["microsoft", "microsoft_365", "microsoft_drive", "one_drive"].includes(providerToken)
      ? "onedrive"
      : "unknown";
  return {
    ...value,
    provider,
    operation,
    ordinal: structuredInteger(value.ordinal, 1, 20) ?? value.ordinal,
    secondOrdinal: structuredInteger(value.secondOrdinal, 1, 20) ?? value.secondOrdinal,
    count: structuredInteger(value.count, 1, 20) ?? value.count,
    query: value.query ?? value.searchTerm ?? value.search ?? null,
    name: value.name ?? value.fileName ?? value.filename ?? value.folderName ?? null,
  };
}

export function explicitFileProvider(text: string): "onedrive" | "google_drive" | null {
  if (/\bone\s*drive\b|\b(?:microsoft|office\s*365)\s+(?:file|folder|document|doc)s?\b/i.test(text)) return "onedrive";
  if (/\bgoogle\s+drive\b|\bgoogle\s+docs?\b|\b(?:drive|docs)\.google\.com\b/i.test(text)) return "google_drive";
  return null;
}

export function shouldConsiderOneDrive(text: string, arbitrated = false): boolean {
  if (!text.trim()) return false;
  if (arbitrated || explicitFileProvider(text)) return true;
  return /\b(?:files?|folders?|documents?|docs?|pdfs?|markdown|\.txt|\.md|\.csv|\.json)\b/i.test(text)
    && /\b(?:find|search|show|list|open|read|summari[sz]e|pull\s+up|link|owner|modified|latest|recent)\b/i.test(text);
}

export function buildOneDriveIntentPrompt(hasContext: boolean): string {
  return [
    "Extract one file intent for Hula. Return strict JSON only; do not answer or act.",
    "Choose onedrive only for explicit OneDrive/Microsoft file language or supplied OneDrive entity context.",
    "Choose google_drive only for explicit Google Drive/Google Docs language. Generic file language stays unknown; deterministic code chooses a sole capable provider or asks.",
    `Fresh OneDrive context: ${hasContext}. A named entity always overrides an older pronoun context.`,
    "root lists OneDrive root. recent lists recently used files. list_folder lists the named/selected folder. search discovers by filename/provider search.",
    "metadata, owner, modified, and link use only provider metadata. summarize/key_points/action_items/deadlines/decisions/question support plain text, Markdown, CSV, and JSON only.",
    "PDF, DOCX, XLSX, PPTX, images, and other binary files are metadata-only. Never claim their contents were read.",
    "OneDrive writes are unavailable with the current Files.Read grant. Never emit a write operation.",
    "Mail, calendars, Teams chat, Slack, tasks, Notion, Asana, reminders, and memory are not_file.",
    JSON.stringify({
      provider: "onedrive|google_drive|unknown|not_file",
      operation: "root|recent|list_folder|search|get|metadata|owner|modified|link|summarize|key_points|action_items|deadlines|decisions|question|compare|not_file",
      query: null,
      name: null,
      ordinal: null,
      secondOrdinal: null,
      question: null,
      count: 10,
    }),
  ].join("\n");
}

export function parseOneDriveIntent(raw: string): OneDriveIntent | null {
  for (const candidate of structuredJsonObjectCandidates(raw)) {
    const parsed = OneDriveIntentSchema.safeParse(normalizeOneDriveCandidate(candidate));
    if (parsed.success) return parsed.data;
  }
  return null;
}

export async function extractOneDriveIntent(input: {
  text: string;
  hasContext?: boolean;
  generate?: OneDriveIntentGenerator;
}): Promise<OneDriveIntent | null> {
  const generate = input.generate ?? generateAnthropicText;
  const system = buildOneDriveIntentPrompt(input.hasContext === true);
  let messages: { role: "user" | "assistant"; content: string }[] = [{ role: "user", content: input.text }];
  for (let attempt = 0; attempt < ONEDRIVE_INTENT_ATTEMPTS; attempt += 1) {
    try {
      const raw = await generate({ system, messages, maxTokens: 700, timeoutMs: 12_000 });
      const parsed = parseOneDriveIntent(raw);
      if (parsed) return parsed;
      messages = [
        { role: "user", content: input.text },
        { role: "assistant", content: raw.slice(0, 10_000) },
        { role: "user", content: "Repair only the JSON representation. Preserve the same read-only operation and user-supplied file name or question. Never invent a file, provider, or write operation." },
      ];
    } catch {
      // Intent extraction is read-only; one bounded retry is safe.
    }
  }
  return null;
}

function namedTerm(text: string): string | null {
  const quoted = /["“]([^"”]{2,300})["”]/.exec(text)?.[1];
  if (quoted) return quoted.trim();
  const named = /\b(?:called|named|titled)\s+([^.!?]{2,300})/i.exec(text)?.[1];
  if (named) return normalizeOneDriveRequestedName(named);
  const folder = /\b(?:what(?:['’]s| is)\s+in|contents?\s+of)\s+(?:the\s+)?([^.!?]{2,240}?)\s+folder\b/i.exec(text)?.[1];
  if (folder && !/^(?:this|that|the|my|one\s*drive)$/i.test(folder.trim())) return folder.trim();
  if (explicitFileProvider(text) !== "onedrive") return null;
  if (!/\b(?:find|search|show|open|pull\s+up|locate|where(?:['’]s| is))\b/i.test(text)) return null;
  const normalized = normalizeOneDriveRequestedName(text);
  return normalized && !/^(?:one\s*drive|microsoft(?:\s+365)?)$/i.test(normalized)
    ? normalized
    : null;
}

function requestedCount(text: string, fallback: number): number {
  const match = /\b(\d{1,2})\b(?=[^.!?]{0,40}\b(?:latest|recent|newest|files?|items?|folders?)\b)/i.exec(text)
    ?? /\b(?:latest|recent|newest)\s+(\d{1,2})\b/i.exec(text);
  const count = Number(match?.[1]);
  return Number.isInteger(count) && count >= 1 && count <= 20 ? count : fallback;
}

export function explicitOneDriveFollowupIntent(text: string): OneDriveIntent | null {
  const lower = text.toLowerCase();
  const ordinal = /\b(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\b|^(?:#|number\s+)?\d{1,2}(?:st|nd|rd|th)?\.?$/i.test(text.trim())
    ? undefined
    : null;
  const base = { provider: "onedrive" as const, ordinal };
  if (/\b(?:find|search|locate|pull\s+up)\b/.test(lower) && (/\b(?:this|that|the)\s+folder\b/.test(lower) || /\bin\s+it\b/.test(lower))) {
    const name = normalizeOneDriveRequestedName(text);
    return OneDriveIntentSchema.parse({ ...base, operation: "search", name, query: name, count: 10 });
  }
  if (/\b(?:link|url)\b|\bopen\s+the\s+link\b/.test(lower)) return OneDriveIntentSchema.parse({ ...base, operation: "link" });
  if (/\b(?:owner|owns?|who\s+(?:created|modified|changed|updated))\b/.test(lower)) return OneDriveIntentSchema.parse({ ...base, operation: "owner" });
  if (/\b(?:when|what\s+time)\b.*\b(?:modified|changed|updated)\b|\blast\s+(?:modified|changed|updated)\b/.test(lower)) {
    return OneDriveIntentSchema.parse({ ...base, operation: "modified" });
  }
  if (/\b(?:how\s+big|size|file\s+type|what\s+type|mime|which\s+folder|what\s+folder|where\s+is\s+it)\b/.test(lower)) {
    return OneDriveIntentSchema.parse({ ...base, operation: "metadata" });
  }
  if (/\b(?:what(?:'s| is)\s+in|contents?\s+of|list|show)\b[^.!?]*\b(?:this|that|the)?\s*folder\b|\bwhat\s+files?\s+are\s+in\s+it\b/.test(lower)) {
    return OneDriveIntentSchema.parse({ ...base, operation: "list_folder", count: requestedCount(text, 20) });
  }
  if (/\bdeadlines?\b|\bdue\s+dates?\b/.test(lower)) return OneDriveIntentSchema.parse({ ...base, operation: "deadlines", question: text });
  if (/\baction\s+items?\b|\bwho\s+needs?\s+to\s+do\s+what\b|\bwhat\s+should\s+i\s+do\b/.test(lower)) {
    return OneDriveIntentSchema.parse({ ...base, operation: "action_items", question: text });
  }
  if (/\bkey\s+points?\b|\bpriorities\b/.test(lower)) return OneDriveIntentSchema.parse({ ...base, operation: "key_points", question: text });
  if (/\bdecisions?\b/.test(lower)) return OneDriveIntentSchema.parse({ ...base, operation: "decisions", question: text });
  if (/\bsummari[sz]e|\bsummary\b|\bgist\b|\bbasically\b|\bwhat\s+matters\b|\bimportant\s+part\b|\bexplain\s+(?:this|it)\s+simply\b/.test(lower)) {
    return OneDriveIntentSchema.parse({ ...base, operation: "summarize", question: text });
  }
  if (/^\s*open\s+(?:it|this|that|the\s+(?:file|folder)|(?:the\s+)?\d+)/i.test(text)) {
    return OneDriveIntentSchema.parse({ ...base, operation: "get" });
  }
  if (/\b(?:what|who|when|where|why|how|does|is|are|which)\b/.test(lower)) {
    return OneDriveIntentSchema.parse({ ...base, operation: "question", question: text });
  }
  return null;
}

export function explicitOneDriveIntent(text: string): OneDriveIntent | null {
  if (explicitFileProvider(text) !== "onedrive") return null;
  const lower = text.toLowerCase();
  const name = namedTerm(text);
  if (/\b(?:latest|recent|newest)\b/.test(lower)) return OneDriveIntentSchema.parse({ provider: "onedrive", operation: "recent", count: requestedCount(text, 10) });
  if (/\b(?:root|top[- ]level)\b/.test(lower)) return OneDriveIntentSchema.parse({ provider: "onedrive", operation: "root", count: requestedCount(text, 10) });
  if (/\b(?:what(?:'s| is)\s+in|contents?\s+of|list|show)\b[^.!?]*\bfolder\b/.test(lower)) return OneDriveIntentSchema.parse({ provider: "onedrive", operation: "list_folder", name, count: requestedCount(text, 20) });
  if (/\b(?:what\s+files?|list|show)\b[^.!?]*\b(?:in\s+)?(?:my\s+)?one\s*drive\b/.test(lower) && !name) {
    return OneDriveIntentSchema.parse({ provider: "onedrive", operation: "root", count: requestedCount(text, 10) });
  }
  if (/\bsummari[sz]e|\bgist\b/.test(lower)) return OneDriveIntentSchema.parse({ provider: "onedrive", operation: "summarize", name });
  if (/\b(?:owner|owns?)\b/.test(lower)) return OneDriveIntentSchema.parse({ provider: "onedrive", operation: "owner", name });
  if (/\b(?:modified|changed|updated)\b/.test(lower)) return OneDriveIntentSchema.parse({ provider: "onedrive", operation: "modified", name });
  if (/\blink\b|\burl\b/.test(lower)) return OneDriveIntentSchema.parse({ provider: "onedrive", operation: "link", name });
  if (/\bopen\b|\bwhere(?:['’]s| is)\b/.test(lower)) return OneDriveIntentSchema.parse({ provider: "onedrive", operation: name ? "get" : "root", name, count: 10 });
  if (/\b(?:find|search|pull\s+up|show|locate)\b/.test(lower)) return OneDriveIntentSchema.parse({ provider: "onedrive", operation: name ? "search" : "root", name, query: name, count: 10 });
  return null;
}
