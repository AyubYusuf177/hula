import { listRecentProposalsByAction, type ActionProposalView } from "./proposals";
import { textForProviderMentionDetection } from "../integrations/providerMentions";

/**
 * Cross-provider entity-context arbitration.
 *
 * THE REAL FAILURE THIS FIXES. A user listed their Todoist tasks, saw a numbered
 * list, and said "Change the second one's priority to high". Hula replied:
 *
 *     "I'm not sure which draft you mean — try 'show me my drafts' first."
 *
 * Nothing about that message concerns email. It was intercepted by the Gmail
 * DRAFT LIFECYCLE handler, which sits above Todoist in the cascade and whose gate
 * matches a bare "change" (a deliberately broad edit hint, safe on its own terms).
 * The extractor then read it as a draft edit, found no draft, and answered.
 *
 * THE DEEPER PROBLEM. Cascade order alone cannot arbitrate follow-ups. "The second
 * one" is meaningless in isolation — its meaning comes ENTIRELY from the last
 * grounded list the user was shown. A fixed handler order asks "who matches first?"
 * when the only correct question is "what were we just talking about?". Whichever
 * provider sits highest wins every ambiguous pronoun, forever, regardless of
 * context. Moving Todoist above Gmail would simply invert the same bug.
 *
 * THE RULE, in priority order:
 *   1. EXPLICIT TYPED SEMANTICS WIN. "priority"/"task"/"project" mean Todoist;
 *      "draft"/"subject"/"recipient" mean Gmail drafts; "meeting"/"attendee" mean
 *      Calendar. A user who names the entity is never overruled by stale context.
 *   2. CONFLICTING EXPLICIT SEMANTICS FAIL CLOSED. "Change the second draft's
 *      priority" names two different entities; guessing would mutate the wrong
 *      provider, so Hula asks.
 *   3. OTHERWISE THE MOST RECENT GROUNDED CONTEXT DECIDES. Generic verbs
 *      ("change", "move", "delete the first one") belong to whatever list is
 *      actually on screen.
 *   4. NO CONTEXT AND NO SEMANTICS → no owner. The cascade proceeds unchanged.
 *
 * This REUSES the existing durable contexts (each provider already persists its
 * numbered list and acted-entity under a pseudo `actionId` in the shared proposal
 * store). It adds NO new memory, writes nothing, and calls no provider — it is a
 * pure read that answers one question: whose follow-up is this?
 */

/**
 * The entity kinds a follow-up can be about.
 *
 * `memory_item` has no numbered result set of its own — it exists here so an
 * EXPLICIT memory reference ("delete that memory") is recognised as naming another
 * provider, and is therefore never routed to Todoist by a stale task context.
 */
export type EntityKind =
  | "todoist_task"
  | "asana_task"
  | "notion_entity"
  | "gmail_email"
  | "gmail_draft"
  | "outlook_message"
  | "outlook_draft"
  | "calendar_event"
  | "outlook_calendar_event"
  | "drive_file"
  | "onedrive_file"
  | "slack_entity"
  | "memory_item";

/**
 * The pseudo action ids each provider already persists context under.
 *
 * Duplicated as literals rather than imported from the provider modules on
 * purpose: importing them would make this low-level arbiter depend on every
 * provider package (and on their handler imports), which is a cycle waiting to
 * happen. The ids are a stable storage contract, and the tests pin them.
 */
export const CONTEXT_SOURCES: readonly { actionId: string; kind: EntityKind | "gmail_either" | "outlook_either" }[] = [
  { actionId: "drive.unresolvedAmbiguity", kind: "drive_file" },
  { actionId: "drive.lastSelection", kind: "drive_file" },
  { actionId: "drive.entityContext", kind: "drive_file" },
  { actionId: "slack.lastSelection", kind: "slack_entity" },
  { actionId: "slack.derivedSelection", kind: "slack_entity" },
  { actionId: "slack.entityContext", kind: "slack_entity" },
  { actionId: "notion.lastSelection", kind: "notion_entity" },
  { actionId: "notion.entityContext", kind: "notion_entity" },
  { actionId: "asana.lastSelection", kind: "asana_task" },
  { actionId: "asana.entityContext", kind: "asana_task" },
  { actionId: "todoist.lastSelection", kind: "todoist_task" },
  { actionId: "todoist.entityContext", kind: "todoist_task" },
  { actionId: "calendar.lastSelection", kind: "calendar_event" },
  { actionId: "calendar.entityContext", kind: "calendar_event" },
  { actionId: "microsoft.calendar.lastSelection", kind: "outlook_calendar_event" },
  { actionId: "microsoft.calendar.entityContext", kind: "outlook_calendar_event" },
  // Gmail stores messages AND drafts under ONE selection id, distinguished by the
  // payload's `itemKind` — so the row's own data decides which it is.
  { actionId: "email.lastSelection", kind: "gmail_either" },
  { actionId: "email.entityContext", kind: "gmail_email" },
  { actionId: "email.lastDraft", kind: "gmail_draft" },
  { actionId: "microsoft.mail.lastSelection", kind: "outlook_either" },
  { actionId: "microsoft.mail.entityContext", kind: "outlook_message" },
  { actionId: "microsoft.mail.lastDraft", kind: "outlook_draft" },
  { actionId: "microsoft.onedrive.lastSelection", kind: "onedrive_file" },
  { actionId: "microsoft.onedrive.entityContext", kind: "onedrive_file" },
];

// --- Follow-up shape (PURE) ----------------------------------------------

/**
 * PURE: is this message a bare ordinal/pronoun follow-up?
 *
 * These are the messages whose meaning lives entirely in the previous turn. A
 * message that names its own target ("complete the pitch deck task") does not need
 * arbitration — it is self-describing and the normal cascade handles it.
 */
export function isFollowupShape(text: string | undefined): boolean {
  const t = (text ?? "").trim().toLowerCase();
  if (!t) return false;
  if (/^#?\d{1,2}\.?$/.test(t)) return true;
  if (/\b(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|last)\s+one\b/.test(t)) {
    return true;
  }
  if (/\b(?:the|that|this)\s+one\b/.test(t)) return true;
  // "the second one's priority", "the second task", "the 2nd"
  if (/\b(?:first|second|third|fourth|fifth|last)\b/.test(t)) return true;
  if (/\b\d{1,2}(?:st|nd|rd|th)\b/.test(t)) return true;
  if (/\ball\s+(?:of\s+)?(?:them|those|these)\b/.test(t)) return true;
  if (/\b(?:it|its|that|this|them|those|these|they)\b/.test(t)) return true;
  // Named read follow-ups can still refer to the immediately shown entity:
  // “What is Team Text?” and “Give me the link to Team Text.” Preserve the
  // existing context arbitration instead of sending these to the brain.
  if (/^(?:what(?:['’]s| is)|tell me about|give me (?:the )?link(?:\s+to)?|open (?:the )?link)\b/.test(t)) return true;
  return false;
}

// --- Typed semantics (PURE) ----------------------------------------------

/**
 * PURE: the entity kinds a message NAMES outright.
 *
 * Each pattern is a noun (or a state verb) that belongs to exactly one provider's
 * vocabulary. Deliberately NARROW: a generic verb like "change", "move" or
 * "delete" names nothing and must never appear here — letting "change" imply an
 * entity is precisely how a Todoist follow-up became a Gmail draft edit.
 */
export function explicitEntityKinds(text: string | undefined): EntityKind[] {
  const t = (text ?? "").trim().toLowerCase();
  if (!t) return [];
  const providerText = textForProviderMentionDetection(t);
  const kinds = new Set<EntityKind>();
  const explicitOutlook = /\b(?:outlook(?!\s+(?:calendar|meetings?|events?))|microsoft\s*(?:365)?\s*(?:mail|email|inbox)|hotmail)\b/.test(providerText);
  const explicitGmail = /\bgmail\b/.test(providerText);

  if (/\bslack\b|#[a-z0-9_-]+|\bslack\s+(?:channel|message|thread|workspace)\b/.test(t)) {
    kinds.add("slack_entity");
  }

  if (/\bgoogle\s+drive\b|\bgoogle\s+docs?\b|\b(?:docs|drive)\.google\.com\b/.test(t)) {
    kinds.add("drive_file");
  }
  if (/\bone\s*drive\b|\b(?:microsoft|office\s*365)\s+(?:files?|folders?|documents?|docs?)\b/.test(t)) {
    kinds.add("onedrive_file");
  }

  // An explicit provider name wins over generic task nouns.
  if (/\basana\b/.test(t)) {
    kinds.add("asana_task");
  }
  if (/\bnotion\b|\b(?:page|record|data source|database|block|comment)\s+(?:in\s+)?notion\b/.test(t)) kinds.add("notion_entity");
  if (!/\basana\b/.test(t) && !/\bone\s*drive\b|\bgoogle\s+drive\b|\bgoogle\s+docs?\b/.test(t) && (
    /\bpriority\b/.test(t) ||
    /\btasks?\b/.test(t) ||
    /\bto-?dos?\b/.test(t) ||
    /\bprojects?\b/.test(t) ||
    /\bsections?\b/.test(t) ||
    /\blabels?\b/.test(t) ||
    /\btodoist\b/.test(t) ||
    /\boverdue\b/.test(t)
  )) {
    kinds.add("todoist_task");
  }

  // Draft/message nouns are shared by Gmail and Outlook. Without an explicit
  // provider, fresh typed context decides instead of defaulting to Gmail.
  if (explicitGmail && (
    /\bdrafts?\b/.test(t) ||
    /\bsubject\b/.test(t) ||
    /\brecipients?\b/.test(t) ||
    /\b(?:email|message)\s+body\b/.test(t) ||
    /\bbody\b/.test(t)
  )) {
    kinds.add("gmail_draft");
  }

  // Gmail messages: inbox nouns and mail-specific verbs.
  if (explicitGmail && !/\bslack\b/.test(t) && (
    /\breply\b/.test(t) ||
    /\bemails?\b/.test(t) ||
    /\binbox\b/.test(t) ||
    /\bsenders?\b/.test(t) ||
    /\bunread\b/.test(t) ||
    /\barchive\b/.test(t)
  )) {
    kinds.add("gmail_email");
  }

  if (explicitOutlook) {
    if (/\bdrafts?\b/.test(t)) kinds.add("outlook_draft");
    else kinds.add("outlook_message");
  }

  // Calendar: event nouns.
  const explicitMicrosoftCalendar = /\b(?:outlook|microsoft(?:\s*365)?|office\s*365)\s+(?:calendar|meetings?|events?)\b|\bteams\s+(?:meeting|call)\b/.test(t);
  if (explicitMicrosoftCalendar) kinds.add("outlook_calendar_event");
  if (!explicitMicrosoftCalendar && (
    /\bmeetings?\b/.test(t) ||
    /\bevents?\b/.test(t) ||
    /\battendees?\b/.test(t) ||
    /\bcalendars?\b/.test(t) ||
    /\bgoogle\s+meet\b/.test(t) ||
    /\binvites?\b/.test(t)
  )) {
    kinds.add("calendar_event");
  }

  // Memory: the user's own saved facts. A user who says "memory" means memory,
  // whatever list happens to be on screen.
  if (/\bmemor(?:y|ies)\b/.test(t)) kinds.add("memory_item");

  return [...kinds];
}

/**
 * PURE: is this a DESTRUCTIVE follow-up naming only a pronoun ("delete it")?
 *
 * These are the messages that must never be answered on a guess. If no provider
 * owns one, the honest outcome is a question — letting it fall through to the
 * general brain risks a fabricated "Deleted!" for something that still exists.
 */
export function isDestructiveFollowup(text: string | undefined): boolean {
  const t = (text ?? "").trim().toLowerCase();
  if (!t) return false;
  if (!/^(?:please\s+)?(?:delete|remove|forget|clear|bin|trash)\b/.test(t)) return false;
  return isFollowupShape(t);
}

/**
 * PURE: collapse kinds that are not really in conflict.
 *
 * "Change the second draft's body" names `draft` AND `body` — both Gmail drafts,
 * so one kind. But "the second EMAIL's body" names a message and a draft noun,
 * which within Gmail is not a cross-provider conflict worth interrupting for: both
 * resolve inside the Gmail handlers, which already know how to tell them apart.
 * Only a genuinely CROSS-PROVIDER disagreement is a conflict.
 */
export function toProviderFamilies(kinds: readonly EntityKind[]): string[] {
  const families = new Set<string>();
  for (const kind of kinds) {
    families.add(
      kind === "gmail_email" || kind === "gmail_draft"
        ? "gmail"
        : kind === "outlook_message" || kind === "outlook_draft"
          ? "outlook"
          : kind,
    );
  }
  // `memory_item` is its own family: "delete that memory" vs a task is a genuine
  // cross-provider question, not a within-Gmail nuance.
  return [...families];
}

// --- Grounded context (I/O, injectable) ----------------------------------

/** A grounded context the user was actually shown, with when it was established. */
export interface GroundedContext {
  kind: EntityKind;
  actionId: string;
  /** ms since epoch — used only to pick the most recent. */
  at: number;
  /** Safe display names already shown to this user; never provider body content. */
  names: string[];
}

export interface ArbiterDeps {
  listRecent?: (userId: string, actionId: string, limit?: number) => Promise<ActionProposalView[]>;
  now?: Date;
}

/** PURE: read Gmail's selection payload to tell messages from drafts. */
function mailKindFromRow(row: ActionProposalView, source: "gmail_either" | "outlook_either"): EntityKind {
  const itemKind = (row.input as { itemKind?: unknown } | null)?.itemKind;
  if (source === "gmail_either") return itemKind === "drafts" ? "gmail_draft" : "gmail_email";
  const items = (row.input as { items?: unknown } | null)?.items;
  const firstKind = Array.isArray(items) && items[0] && typeof items[0] === "object"
    ? (items[0] as { itemKind?: unknown }).itemKind
    : null;
  return firstKind === "draft" ? "outlook_draft" : "outlook_message";
}

function contextNames(row: ActionProposalView, actionId: string): string[] {
  if (actionId === "drive.lastSelection" || actionId === "drive.unresolvedAmbiguity") {
    const refs = (row.input as { refs?: unknown } | null)?.refs;
    if (!Array.isArray(refs)) return [];
    return refs.flatMap((ref) => {
      const name = ref && typeof ref === "object" ? (ref as { name?: unknown }).name : null;
      return typeof name === "string" && name.trim() ? [name.trim()] : [];
    }).slice(0, 20);
  }
  if (actionId === "drive.entityContext") {
    const ref = (row.input as { ref?: unknown } | null)?.ref;
    const name = ref && typeof ref === "object" ? (ref as { name?: unknown }).name : null;
    return typeof name === "string" && name.trim() ? [name.trim()] : [];
  }
  if (actionId === "microsoft.mail.lastSelection") {
    const items = (row.input as { items?: unknown } | null)?.items;
    if (!Array.isArray(items)) return [];
    return items.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const raw = item as { subject?: unknown; senderName?: unknown };
      return [raw.subject, raw.senderName].filter((value): value is string => typeof value === "string" && value.trim().length > 0);
    }).slice(0, 40);
  }
  if (actionId === "microsoft.mail.entityContext" || actionId === "microsoft.mail.lastDraft") {
    const ref = (row.input as { ref?: unknown } | null)?.ref;
    if (!ref || typeof ref !== "object") return [];
    const raw = ref as { subject?: unknown; senderName?: unknown };
    return [raw.subject, raw.senderName].filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  }
  if (actionId === "microsoft.calendar.lastSelection" || actionId === "microsoft.onedrive.lastSelection") {
    const items = (row.input as { items?: unknown } | null)?.items;
    if (!Array.isArray(items)) return [];
    return items.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const raw = item as { subject?: unknown; name?: unknown };
      const name = typeof raw.subject === "string" ? raw.subject : typeof raw.name === "string" ? raw.name : null;
      return name?.trim() ? [name.trim()] : [];
    }).slice(0, 20);
  }
  if (actionId === "microsoft.calendar.entityContext" || actionId === "microsoft.onedrive.entityContext") {
    const ref = (row.input as { ref?: unknown } | null)?.ref;
    if (!ref || typeof ref !== "object") return [];
    const raw = ref as { subject?: unknown; name?: unknown };
    const name = typeof raw.subject === "string" ? raw.subject : typeof raw.name === "string" ? raw.name : null;
    return name?.trim() ? [name.trim()] : [];
  }
  return [];
}

/**
 * Load every live grounded context for a user, newest first.
 *
 * Expired rows are SKIPPED — a list the user can no longer see must not decide
 * what "the second one" means. Rows are user-scoped by the store, so one user's
 * context can never arbitrate another's message.
 */
export async function loadGroundedContexts(
  userId: string,
  deps: ArbiterDeps = {},
): Promise<GroundedContext[]> {
  const listRecent = deps.listRecent ?? listRecentProposalsByAction;
  const nowMs = (deps.now ?? new Date()).getTime();
  const found: GroundedContext[] = [];

  for (const source of CONTEXT_SOURCES) {
    let rows: ActionProposalView[];
    try {
      rows = await listRecent(userId, source.actionId, 100);
    } catch {
      // A lookup failure must never fabricate an owner — treat as no context.
      continue;
    }
    for (const row of rows) {
      if (Date.parse(row.expiresAt) <= nowMs) continue;
      if (source.actionId === "microsoft.mail.lastDraft" && row.input?.kind === "outlook_entity_invalidated") break;
      if (row.input?.kind === "outlook_entity_invalidated") continue;
      const payloadAt = (row.input as { contextEstablishedAt?: unknown } | null)?.contextEstablishedAt;
      const at = typeof payloadAt === "number" && Number.isFinite(payloadAt)
        ? payloadAt
        : Date.parse(row.createdAt);
      if (!Number.isFinite(at)) continue;
      found.push({
        kind: source.kind === "gmail_either" || source.kind === "outlook_either"
          ? mailKindFromRow(row, source.kind)
          : source.kind,
        actionId: source.actionId,
        at,
        names: contextNames(row, source.actionId),
      });
    }
  }

  return found.sort((a, b) => {
    const recency = b.at - a.at;
    if (recency !== 0) return recency;
    // A list and the entity selected from it are often persisted in the same
    // millisecond. On that exact tie, the concrete active entity must outrank
    // the preserved candidate list or factual follow-ups can lose ownership.
    const active = (actionId: string) => actionId.endsWith(".entityContext") ? 1 : 0;
    return active(b.actionId) - active(a.actionId);
  });
}

// --- Arbitration ---------------------------------------------------------

/** Who owns this follow-up. */
export type FollowupOwner =
  | { kind: "owner"; owner: EntityKind; reason: "explicit" | "context" }
  | { kind: "conflict"; clarification: string }
  | { kind: "none" };

function normalizedName(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ").trim();
}

function textMentionsName(text: string, name: string): boolean {
  const haystack = normalizedName(text);
  const needle = normalizedName(name);
  if (needle.length < 2) return false;
  const index = haystack.indexOf(needle);
  if (index < 0) return false;
  const before = haystack[index - 1] ?? "";
  const after = haystack[index + needle.length] ?? "";
  return !/[\p{L}\p{N}]/u.test(before) && !/[\p{L}\p{N}]/u.test(after);
}

interface NamedContextMatch {
  kind: EntityKind;
  name: string;
}

function namedContextOwner(text: string, contexts: GroundedContext[]): NamedContextMatch | null {
  const matches = contexts.flatMap((context) => context.names
    .filter((name) => textMentionsName(text, name))
    .map((name) => ({ kind: context.kind, name, length: normalizedName(name).length, at: context.at })));
  if (matches.length === 0) return null;
  matches.sort((a, b) => b.length - a.length || b.at - a.at);
  const longest = matches[0]!.length;
  const kinds = [...new Set(matches.filter((match) => match.length === longest).map((match) => match.kind))];
  return kinds.length === 1 ? { kind: kinds[0]!, name: matches[0]!.name } : null;
}

/** Provider brands/signals only; generic content nouns deliberately do not count. */
function explicitProviderKinds(text: string): EntityKind[] {
  const providerText = textForProviderMentionDetection(text);
  const kinds = new Set<EntityKind>();
  if (/\bslack\b|#[a-z0-9_-]+/i.test(providerText)) kinds.add("slack_entity");
  if (/\bgoogle\s+drive\b|\bgoogle\s+docs?\b|\b(?:docs|drive)\.google\.com\b/i.test(providerText)) kinds.add("drive_file");
  if (/\bone\s*drive\b|\b(?:microsoft|office\s*365)\s+(?:files?|folders?|documents?|docs?)\b/i.test(providerText)) kinds.add("onedrive_file");
  if (/\basana\b/i.test(providerText)) kinds.add("asana_task");
  if (/\bnotion\b/i.test(providerText)) kinds.add("notion_entity");
  if (/\btodoist\b/i.test(providerText)) kinds.add("todoist_task");
  if (/\bgmail\b/i.test(providerText)) kinds.add("gmail_email");
  if (/\b(?:outlook(?!\s+(?:calendar|meetings?|events?))|microsoft\s*(?:365)?\s*(?:mail|email|inbox)|hotmail)\b/i.test(providerText)) kinds.add("outlook_message");
  if (/\b(?:outlook|microsoft(?:\s*365)?|office\s*365)\s+(?:calendar|meetings?|events?)\b|\bteams\s+(?:meeting|call)\b/i.test(providerText)) kinds.add("outlook_calendar_event");
  else if (/\bcalendar\b|\bmeetings?\b|\bevents?\b/i.test(providerText)) kinds.add("calendar_event");
  if (/\bremind(?:er)?\b/i.test(providerText)) kinds.add("memory_item");
  if (/\bmemor(?:y|ies)\b/i.test(providerText)) kinds.add("memory_item");
  return [...kinds];
}

function withoutNamedMention(text: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(escaped, "giu"), " ").replace(/\s+/g, " ").trim();
}

function mayNameGroundedEntity(text: string): boolean {
  return /[A-Z][\p{L}\p{N}.'-]*(?:\s+[A-Z][\p{L}\p{N}.'-]*)+/u.test(text) ||
    /[\p{L}\p{N} _-]+\.(?:pdf|docx?|xlsx?|pptx?|txt|md)\b/iu.test(text) ||
    /^(?:who|what|when|where|why|how)\b.*\b(?:in|from|about)\s+.{2,}$/iu.test(text) ||
    /^(?:summari[sz]e|show me|tell me about|give me (?:the )?link to)\s+.{2,}$/iu.test(text);
}

/** PURE: a precise, non-mutating clarification for a cross-provider conflict. */
export function conflictClarification(kinds: readonly EntityKind[]): string {
  const label: Record<EntityKind, string> = {
    todoist_task: "a Todoist task",
    asana_task: "an Asana task",
    notion_entity: "Notion content",
    gmail_email: "an email",
    gmail_draft: "an email draft",
    outlook_message: "an Outlook message",
    outlook_draft: "an Outlook draft",
    calendar_event: "a calendar event",
    outlook_calendar_event: "an Outlook calendar event",
    drive_file: "a Google Drive file",
    onedrive_file: "a OneDrive file",
    slack_entity: "Slack content",
    memory_item: "something I’ve remembered",
  };
  const names = [...new Set(kinds.map((k) => label[k]))];
  const list =
    names.length === 2
      ? `${names[0]} or ${names[1]}`
      : `${names.slice(0, -1).join(", ")}, or ${names[names.length - 1]}`;
  return `Do you mean ${list}? I don’t want to change the wrong thing — tell me which and I’ll do it.`;
}

/**
 * Decide who owns a follow-up. Never throws; never writes; never calls a provider.
 *
 * Returns `none` for anything that isn't a follow-up, or where neither explicit
 * semantics nor a live context can say — in which case the caller leaves the
 * cascade completely unchanged.
 */
export async function resolveFollowupOwner(
  userId: string,
  text: string | undefined,
  deps: ArbiterDeps = {},
): Promise<FollowupOwner> {
  const value = (text ?? "").trim();
  // Teams chat/channel messaging is an explicit unsupported provider request,
  // never a pronoun that stale Slack context may claim. The routing guard
  // immediately after this arbiter returns the honest limitation.
  if (/\b(?:microsoft\s+)?teams\b/i.test(value) && !/\b(?:meeting|call|calendar|schedule|book|invite|join\s+link)\b/i.test(value)) {
    return { kind: "none" };
  }
  const followup = isFollowupShape(value);
  const mayNameEntity = mayNameGroundedEntity(value);
  const factualQuestion = /^(?:who|what|when|where|why|how|does|is|are|which)\b/i.test(value);
  if (!followup && !mayNameEntity && !factualQuestion) return { kind: "none" };

  const contexts = await loadGroundedContexts(userId, deps);
  const namedOwner = namedContextOwner(value, contexts);
  let semanticValue = value;

  if (namedOwner) {
    // Match provider brands only OUTSIDE the exact grounded title. A document
    // called “Todoist Migration Plan” is still a Drive entity, while “show Slack
    // messages about Launch Plan” is unambiguously Slack. This preserves explicit
    // provider precedence without treating generic task/project nouns as brands.
    const withoutName = withoutNamedMention(value, namedOwner.name);
    const namedFamily = toProviderFamilies([namedOwner.kind])[0];
    const otherProviderFamilies = toProviderFamilies(explicitProviderKinds(withoutName))
      .filter((family) => family !== namedFamily);
    if (otherProviderFamilies.length === 0) {
      return { kind: "owner", owner: namedOwner.kind, reason: "explicit" };
    }
    semanticValue = withoutName;
  }

  const explicit = explicitEntityKinds(semanticValue);
  const families = toProviderFamilies(explicit);
  const explicitlyBrandedElsewhere = explicitProviderKinds(semanticValue).length > 0;
  const namesSharedDraft = /\bdrafts?\b/i.test(semanticValue) && !explicitlyBrandedElsewhere;

  // A non-follow-up reaches this arbiter only because it may contain a proper
  // entity name. Provider words alone (for example “latest Google Docs”) must
  // continue through the normal provider cascade; only an exact name that the
  // user was actually shown is claimed here.
  if (!followup) {
    // A factual question can refer to a subject inside the currently selected
    // Drive document without repeating its filename ("When does Project Atlas
    // launch?"). Only a concrete active entity—not a list—may claim it, and an
    // explicit provider noun elsewhere in the question still wins.
    if (families.length > 0 && explicitlyBrandedElsewhere) return { kind: "none" };
    const newest = contexts[0];
    if (factualQuestion && (newest?.actionId === "drive.entityContext" || newest?.actionId === "microsoft.onedrive.entityContext")) {
      return { kind: "owner", owner: newest.actionId === "drive.entityContext" ? "drive_file" : "onedrive_file", reason: "context" };
    }
    return { kind: "none" };
  }

  // An exact entity title is stronger than generic domain nouns inside that
  // title or question (for example “project” in a Drive document question).
  // This is the cross-provider form of explicit-current-target precedence.
  // Inside a concrete Drive read conversation, generic task/project/priority
  // nouns can be document content rather than a Todoist command. Read-shaped
  // questions stay with the active document unless another provider is named.
  if (
    factualQuestion &&
    !explicitlyBrandedElsewhere &&
    (contexts[0]?.actionId === "drive.entityContext" || contexts[0]?.actionId === "microsoft.onedrive.entityContext")
  ) {
    return { kind: "owner", owner: contexts[0]?.actionId === "drive.entityContext" ? "drive_file" : "onedrive_file", reason: "context" };
  }

  // 2. Cross-provider disagreement inside one message → ask, never guess.
  // A provider-neutral draft noun still names the mail domain. If the same
  // request also names an unrelated entity family (for example a task priority),
  // surface that conflict instead of letting either side steal the mutation.
  if (namesSharedDraft && families.length > 0 && !families.includes("gmail") && !families.includes("outlook")) {
    return {
      kind: "conflict",
      clarification: conflictClarification([...explicit, "gmail_draft"]),
    };
  }
  if (families.length > 1) {
    return { kind: "conflict", clarification: conflictClarification(explicit) };
  }

  // 1. A single named entity wins outright, even over a more recent context.
  if (explicit.length === 1) {
    return { kind: "owner", owner: explicit[0]!, reason: "explicit" };
  }
  if (explicit.length > 1) {
    // Same family (e.g. draft + body). Prefer the more specific draft kind.
    const owner = explicit.includes("gmail_draft") ? "gmail_draft" : explicit[0]!;
    return { kind: "owner", owner, reason: "explicit" };
  }

  // Some entity nouns are shared across providers. They are still stronger than
  // an unrelated active context: "delete that draft" means the freshest actual
  // mail draft, not a newer Todoist task or saved memory. Do not assign the noun
  // to Gmail or Outlook by catalog order; choose only among grounded draft
  // contexts, and fail closed if equally fresh providers disagree.
  if (namesSharedDraft) {
    const draftContexts = contexts.filter(
      (context) => context.kind === "gmail_draft" || context.kind === "outlook_draft",
    );
    const newestDraft = draftContexts[0];
    if (newestDraft) {
      const tiedDrafts = draftContexts.filter((context) => context.at === newestDraft.at);
      if (toProviderFamilies(tiedDrafts.map((context) => context.kind)).length > 1) {
        return {
          kind: "conflict",
          clarification: conflictClarification(tiedDrafts.map((context) => context.kind)),
        };
      }
      return { kind: "owner", owner: newestDraft.kind, reason: "context" };
    }
  }

  // 3. Otherwise: whatever the user is actually looking at.
  const newest = contexts[0];
  if (!newest) return { kind: "none" };
  // Two provider contexts stamped at the same instant carry no defensible
  // recency ordering. This can happen when parallel lists are shown/recorded;
  // choosing either task provider would be a guess, so ask and write nothing.
  const equallyRecent = contexts.filter((context) => context.at === newest.at);
  const equallyRecentFamilies = toProviderFamilies(equallyRecent.map((context) => context.kind));
  if (equallyRecentFamilies.length > 1) {
    return {
      kind: "conflict",
      clarification: conflictClarification(equallyRecent.map((context) => context.kind)),
    };
  }
  return { kind: "owner", owner: newest.kind, reason: "context" };
}
