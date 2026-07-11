import { getPrisma } from "../db/prisma";

/**
 * Explicit long-term memory (Section 8).
 *
 * Hula can already identify users, store messages, sync profile context, and
 * call the brain. This module adds a small, conservative, USER-CONTROLLED memory
 * layer, similar in spirit to ChatGPT/Claude memory but deliberately minimal:
 *
 *   - Memory is only ever created when the user EXPLICITLY asks ("remember …").
 *     There is no automatic extraction from normal chat.
 *   - Memory is only ever removed when the user asks ("forget …") — and deletes
 *     are SOFT so nothing is destroyed.
 *   - Sensitive-adjacent but practical constraints (dietary/religious/health) are
 *     allowed when explicitly requested; true secrets (passwords, cards, IDs,
 *     precise address, evasion instructions) are always blocked.
 *
 * The design mirrors the rest of the codebase: PURE, DB-free functions that are
 * fully unit-testable (command classification, sanitisation, policy, phrasing),
 * plus thin DB-backed helpers around them. No embeddings, vector search, or
 * semantic matching yet — matching is simple keyword overlap.
 */

// --- Types ---------------------------------------------------------------

/** The kinds of memory we store (mirrors the Prisma `MemoryType` enum). */
export type MemoryTypeValue =
  | "preference"
  | "fact"
  | "instruction"
  | "goal"
  | "project"
  | "routine"
  | "constraint";

/** How much a memory should weigh (mirrors the Prisma `MemoryImportance` enum). */
export type MemoryImportanceValue = "low" | "medium" | "high";

/** A saved memory as returned to callers/endpoints. Safe fields only. */
export interface MemoryView {
  id: string;
  type: MemoryTypeValue;
  text: string;
  importance: MemoryImportanceValue;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
}

/** The classified intent of an inbound message w.r.t. memory. */
export type MemoryCommand =
  | { intent: "remember"; content: string }
  | { intent: "forget"; scope: "all" }
  | { intent: "forget"; scope: "match"; query: string }
  | { intent: "list" }
  | { intent: "none" };

// --- Fixed replies (iMessage-friendly, matching the codebase voice) ------

export const MEMORY_REPLIES = {
  forgotOne: "Done — I forgot that.",
  forgotNone: "I couldn’t find a saved memory matching that.",
  clearedAll: "Done — I cleared your saved memories.",
  listEmpty: "I don’t have any saved memories for you yet.",
  blocked:
    "I can keep that in mind for this chat, but I won’t save it as long-term memory.",
} as const;

// --- Caps ----------------------------------------------------------------

/** Max characters for a single stored memory — keeps memories short and useful. */
const MAX_MEMORY_TEXT = 280;
/** Max active memories loaded into the brain context for a single reply. */
export const MAX_MEMORY_CONTEXT = 20;

// --- Command classification (PURE) ---------------------------------------

// Remember phrasing. `don't forget` is handled first so it is never mistaken
// for a `forget` command.
const DONT_FORGET_RE = /^(?:please\s+)?(?:don['’]?t|do not)\s+forget(?:\s+that)?[\s:,-]+(.+)$/i;
const REMEMBER_RE =
  /^(?:please\s+)?(?:remember|keep in mind|save this|save|make a note(?:\s+of)?|note down)(?:\s+that)?[\s:,-]+(.+)$/i;

// Forget-everything phrasing (must be checked before a plain `forget X`).
const FORGET_ALL_RE =
  /^(?:please\s+)?(?:forget|delete|remove|clear|wipe|erase)\s+(?:everything|all|my memory|my memories)\b/i;
const CLEAR_MEMORY_RE = /^(?:please\s+)?clear\s+my\s+memor(?:y|ies)\b/i;

// Forget-a-specific-thing phrasing. The remainder is the match query.
const FORGET_MATCH_RE = /^(?:please\s+)?(?:forget|delete|remove)\b(.*)$/i;

// List phrasing.
const LIST_RES = [
  /what do you remember/i,
  /what have you remembered/i,
  /what do you know about me/i,
  /^(?:please\s+)?(?:show|list)(?:\s+me)?\s+my\s+memories/i,
];

/** Strip leading filler ("that", "the", "my", "memory", …) from a forget query. */
function cleanForgetQuery(raw: string): string {
  return raw
    .replace(/^[\s:,-]+/, "")
    .replace(/^(?:that|the|this|my|about)\s+/i, "")
    .replace(/^(?:memory|memories)\s+(?:about|that|of)?\s*/i, "")
    .replace(/^(?:about|that)\s+/i, "")
    .trim();
}

/**
 * Pure: classify an inbound message into a memory command (or `none`). Only
 * explicit, front-of-message phrasing counts — this must NOT fire on ordinary
 * requests like "Plan a quick dinner for me." No I/O; fully unit-testable.
 */
export function classifyMemoryCommand(text: string | undefined): MemoryCommand {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return { intent: "none" };

  // List (questions about what is remembered) — checked first.
  if (LIST_RES.some((re) => re.test(trimmed))) return { intent: "list" };

  // "don't forget …" means remember, not forget.
  const dontForget = DONT_FORGET_RE.exec(trimmed);
  if (dontForget?.[1]) return { intent: "remember", content: dontForget[1].trim() };

  const remember = REMEMBER_RE.exec(trimmed);
  if (remember?.[1]) return { intent: "remember", content: remember[1].trim() };

  // Forget everything.
  if (FORGET_ALL_RE.test(trimmed) || CLEAR_MEMORY_RE.test(trimmed)) {
    return { intent: "forget", scope: "all" };
  }

  // Forget a specific memory.
  const forget = FORGET_MATCH_RE.exec(trimmed);
  if (forget) {
    const query = cleanForgetQuery(forget[1] ?? "");
    if (query) return { intent: "forget", scope: "match", query };
  }

  return { intent: "none" };
}

// --- Sanitisation + phrasing (PURE) --------------------------------------

/**
 * Pure: normalise a raw memory into a short, clean string. Collapses whitespace,
 * strips wrapping quotes, and caps length. Returns null when nothing usable
 * remains (so the caller can decline gracefully). Never stores whole paragraphs.
 */
export function sanitizeMemoryText(raw: string): string | null {
  const collapsed = raw.replace(/\s+/g, " ").trim().replace(/^["'“”]+|["'“”]+$/g, "").trim();
  if (collapsed.length < 2) return null;
  return collapsed.slice(0, MAX_MEMORY_TEXT).trim();
}

/**
 * Pure: rewrite a first-person memory ("I prefer …") into a direct second-person
 * statement ("You prefer …") so it reads naturally when Hula lists it back or
 * confirms it. Deterministic word-level substitution — no NLP. Capitalises the
 * first letter and ensures terminal punctuation.
 */
export function toSecondPerson(text: string): string {
  let out = text;
  const rules: [RegExp, string][] = [
    [/\bI['’]m\b/gi, "you're"],
    [/\bI am\b/gi, "you are"],
    [/\bI['’]ve\b/gi, "you've"],
    [/\bI have\b/gi, "you have"],
    [/\bI['’]ll\b/gi, "you'll"],
    [/\bI will\b/gi, "you will"],
    [/\bI['’]d\b/gi, "you'd"],
    [/\bmyself\b/gi, "yourself"],
    [/\bmine\b/gi, "yours"],
    [/\bmy\b/gi, "your"],
    [/\bI\b/g, "you"],
    [/\bme\b/gi, "you"],
  ];
  for (const [re, replacement] of rules) out = out.replace(re, replacement);
  out = out.trim();
  if (out.length === 0) return out;
  out = out[0]!.toUpperCase() + out.slice(1);
  if (!/[.!?]$/.test(out)) out += ".";
  return out;
}

/** Pure: lowercase the first character (for inline confirmation phrasing). */
function lowerFirst(text: string): string {
  return text.length ? text[0]!.toLowerCase() + text.slice(1) : text;
}

/** Pure: the "Got it — I'll remember that …" confirmation for a stored memory. */
export function rememberConfirmation(secondPersonText: string): string {
  return `Got it — I’ll remember that ${lowerFirst(secondPersonText)}`;
}

/** Pure: format a numbered list of saved memories (or the empty-state reply). */
export function formatMemoryList(texts: string[]): string {
  if (texts.length === 0) return MEMORY_REPLIES.listEmpty;
  const lines = texts.map((t, i) => `${i + 1}. ${t}`);
  return `I remember:\n${lines.join("\n")}`;
}

// --- Safety policy (PURE) ------------------------------------------------

// Phrases/patterns that must NEVER be stored as long-term memory, even when the
// user asks. Practical constraints (dietary/religious/health) are intentionally
// NOT here — those are allowed when explicitly requested.
const BLOCKED_PATTERNS: RegExp[] = [
  // Secrets / credentials.
  /\bpass(?:word|code|phrase)\b/i,
  /\bpin\s*(?:code|number|is|:)/i,
  /\bapi[\s-]?key\b/i,
  /\bsecret\s+key\b/i,
  /\b(?:access|auth|bearer)\s+token\b/i,
  /\bprivate\s+key\b/i,
  /\b(?:seed|recovery)\s+phrase\b/i,
  /\b(?:one[\s-]?time\s+(?:code|password)|otp|2fa\s+code)\b/i,
  // Financial.
  /\b(?:credit|debit)\s+card\b/i,
  /\bcard\s+number\b/i,
  /\bcvv|cvc\b/i,
  /\b(?:bank\s+account|account\s+number|routing\s+number|sort\s+code|iban|swift)\b/i,
  // Government / identity.
  /\bssn\b/i,
  /\bsocial\s+security\b/i,
  /\bpassport\s+number\b/i,
  /\bdriver['’]?s?\s+licen[cs]e\b/i,
  /\bnational\s+insurance\b/i,
  /\b(?:government|tax)\s+id\b/i,
  // Precise home address.
  /\b(?:home\s+address|i\s+live\s+at)\b/i,
  /\b\d{1,5}\s+\w+\s+(?:street|st|road|rd|avenue|ave|lane|ln|drive|dr|boulevard|blvd|court|ct|way|close|crescent)\b/i,
  // Evasion / clearly illegal concealment.
  /\bwithout\s+getting\s+caught\b/i,
  /\bget\s+away\s+with\b/i,
  /\bhide\s+(?:from\s+(?:the\s+)?police|the\s+body|evidence)\b/i,
  /\b(?:tax\s+evasion|evade\s+tax|launder(?:ing)?)\b/i,
  // A long bare digit run is almost always a card/account/ID/number.
  /\d{9,}/,
];

/** Pure: whether a memory is safe to store long-term. */
export function isMemoryAllowed(text: string): boolean {
  return !BLOCKED_PATTERNS.some((re) => re.test(text));
}

// --- Type + importance inference (PURE) ----------------------------------

/** Pure: best-effort classification of a memory into a `MemoryType`. */
export function inferMemoryType(text: string): MemoryTypeValue {
  const t = text.toLowerCase();
  if (/\b(don['’]?t eat|allerg|intoleran|vegan|vegetarian|halal|kosher|no pork|alcohol|avoid|gluten|dairy|lactose)\b/.test(t))
    return "constraint";
  if (/\b(prefer|blunt|concise|tone|reply|replies|call me|don['’]?t like|dislike|like)\b/.test(t))
    return "preference";
  if (/\b(building|project|working on|startup|launch(?:ing)?|shipping)\b/.test(t))
    return "project";
  if (/\b(goal|aiming|want to|trying to|target)\b/.test(t)) return "goal";
  if (/\b(every day|each morning|each night|routine|usually|daily|weekly)\b/.test(t))
    return "routine";
  if (/^(?:always|never|whenever|when you)\b/.test(t)) return "instruction";
  return "fact";
}

/** Pure: importance for a memory — practical constraints matter more. */
export function inferMemoryImportance(type: MemoryTypeValue): MemoryImportanceValue {
  return type === "constraint" ? "high" : "medium";
}

// --- Simple keyword matching for "forget X" (PURE) -----------------------

const STOPWORDS = new Set([
  "i","im","i'm","my","me","you","your","that","the","this","a","an","to","is",
  "are","was","were","and","or","do","does","don't","dont","about","of","for",
  "it","remember","memory","memories","please","forget","delete","remove",
]);

/** Pure: significant lowercase word tokens (stopwords + very short words dropped). */
function significantTokens(text: string): string[] {
  const words = text.toLowerCase().match(/[a-z0-9']+/g) ?? [];
  return words.filter((w) => w.length >= 2 && !STOPWORDS.has(w));
}

/**
 * Pure: whether a stored memory matches a free-text "forget" query. A match
 * needs at least one significant query word AND at least half of the query's
 * significant words to appear in the memory. No embeddings — simple overlap.
 */
export function memoryMatchesQuery(memoryText: string, query: string): boolean {
  const q = significantTokens(query);
  if (q.length === 0) return false;
  const m = new Set(significantTokens(memoryText));
  const hits = q.filter((w) => m.has(w)).length;
  return hits >= Math.max(1, Math.ceil(q.length / 2));
}

// --- DB-backed helpers ---------------------------------------------------

/** Map a stored Memory row to the safe view shape. */
function toMemoryView(row: {
  id: string;
  type: MemoryTypeValue;
  text: string;
  importance: MemoryImportanceValue;
  createdAt: Date;
  updatedAt: Date;
}): MemoryView {
  return {
    id: row.id,
    type: row.type,
    text: row.text,
    importance: row.importance,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Create an explicit memory for a user. Text is stored exactly as given. */
export async function createMemoryForUser(
  userId: string,
  input: {
    text: string;
    type?: MemoryTypeValue;
    importance?: MemoryImportanceValue;
    tags?: string[];
  },
): Promise<MemoryView> {
  const type = input.type ?? inferMemoryType(input.text);
  const importance = input.importance ?? inferMemoryImportance(type);
  const row = await getPrisma().memory.create({
    data: {
      userId,
      text: input.text,
      type,
      importance,
      source: "explicit_user_request",
      ...(input.tags && input.tags.length > 0 ? { tags: input.tags.slice(0, 8) } : {}),
    },
    select: {
      id: true,
      type: true,
      text: true,
      importance: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  return toMemoryView(row);
}

/** List a user's active memories, newest-updated first. */
export async function listActiveMemoriesForUser(
  userId: string,
  limit: number = 50,
): Promise<MemoryView[]> {
  const rows = await getPrisma().memory.findMany({
    where: { userId, status: "active" },
    orderBy: { updatedAt: "desc" },
    take: limit,
    select: {
      id: true,
      type: true,
      text: true,
      importance: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  return rows.map(toMemoryView);
}

/** Soft-delete one memory by id (scoped to the owning user). Returns true when a
 * previously-active memory was deactivated. */
export async function softDeleteMemory(
  userId: string,
  memoryId: string,
): Promise<boolean> {
  const result = await getPrisma().memory.updateMany({
    where: { id: memoryId, userId, status: "active" },
    data: { status: "deleted", deletedAt: new Date() },
  });
  return result.count > 0;
}

/** Soft-delete active memories whose text matches a free-text query. Returns the
 * number of memories deactivated. */
export async function softDeleteMemoriesByTextMatch(
  userId: string,
  query: string,
): Promise<number> {
  const rows = await getPrisma().memory.findMany({
    where: { userId, status: "active" },
    select: { id: true, text: true },
  });
  const matchedIds = rows.filter((r) => memoryMatchesQuery(r.text, query)).map((r) => r.id);
  if (matchedIds.length === 0) return 0;
  const result = await getPrisma().memory.updateMany({
    where: { id: { in: matchedIds }, userId, status: "active" },
    data: { status: "deleted", deletedAt: new Date() },
  });
  return result.count;
}

/** Soft-delete ALL of a user's active memories. Returns the number cleared. */
export async function softDeleteAllMemoriesForUser(userId: string): Promise<number> {
  const result = await getPrisma().memory.updateMany({
    where: { userId, status: "active" },
    data: { status: "deleted", deletedAt: new Date() },
  });
  return result.count;
}

/**
 * Load the active memory lines for a user's brain context (capped). Best-effort
 * updates `lastUsedAt` on the returned memories so we can later reason about what
 * is actually being used. Never throws — a memory failure must not break a reply.
 */
export async function buildMemoryContext(userId: string): Promise<string[]> {
  try {
    const memories = await listActiveMemoriesForUser(userId, MAX_MEMORY_CONTEXT);
    if (memories.length === 0) return [];
    // Best-effort "last used" bump; a failure here is irrelevant to the reply.
    try {
      await getPrisma().memory.updateMany({
        where: { id: { in: memories.map((m) => m.id) } },
        data: { lastUsedAt: new Date() },
      });
    } catch {
      // ignore — lastUsedAt is a soft signal only.
    }
    return memories.map((m) => m.text);
  } catch {
    return [];
  }
}

// --- Orchestrator (DB-backed) --------------------------------------------

/** Result of attempting to handle a message as a memory command. */
export interface MemoryCommandResult {
  handled: boolean;
  reply?: string;
  intent?: MemoryCommand["intent"];
}

/**
 * Deterministically handle a memory command from an already-linked user. Returns
 * `{ handled: false }` for ordinary messages (so the caller falls through to the
 * normal Hula brain). Never throws — any DB failure degrades to `handled: false`.
 * This never calls the Anthropic brain.
 */
export async function handleMemoryCommand(
  userId: string,
  text: string | undefined,
): Promise<MemoryCommandResult> {
  const command = classifyMemoryCommand(text);
  if (command.intent === "none") return { handled: false };

  try {
    if (command.intent === "list") {
      const memories = await listActiveMemoriesForUser(userId, MAX_MEMORY_CONTEXT);
      return { handled: true, intent: "list", reply: formatMemoryList(memories.map((m) => m.text)) };
    }

    if (command.intent === "forget") {
      if (command.scope === "all") {
        await softDeleteAllMemoriesForUser(userId);
        return { handled: true, intent: "forget", reply: MEMORY_REPLIES.clearedAll };
      }
      const count = await softDeleteMemoriesByTextMatch(userId, command.query);
      return {
        handled: true,
        intent: "forget",
        reply: count > 0 ? MEMORY_REPLIES.forgotOne : MEMORY_REPLIES.forgotNone,
      };
    }

    // remember
    const clean = sanitizeMemoryText(command.content);
    if (!clean) return { handled: false };
    if (!isMemoryAllowed(clean)) {
      return { handled: true, intent: "remember", reply: MEMORY_REPLIES.blocked };
    }
    const stored = toSecondPerson(clean);
    await createMemoryForUser(userId, { text: stored });
    return { handled: true, intent: "remember", reply: rememberConfirmation(stored) };
  } catch {
    // On any DB failure, fall through to the normal brain rather than lying.
    return { handled: false };
  }
}
