import { createHash } from "node:crypto";

import { createActionProposal, type CreateProposalInput } from "../../../actions/proposals";
import { logger } from "../../../utils/logger";
import { DriveError, getGoogleDriveConnection } from "./client";
import { fetchDriveDocumentContent } from "./content";
import {
  loadDriveEntity,
  loadDriveSelection,
  parseDriveOrdinal,
  recordDriveAmbiguity,
  recordDriveEntity,
  recordDriveSelection,
  resolveDriveReference,
  type DriveContextRef,
} from "./context";
import {
  analyzeDriveDocument,
  compareDriveDocuments,
  type DocumentAnalysisMode,
  type DocumentGenerator,
} from "./documentIntelligence";
import {
  explicitDriveIntent,
  extractDriveIntent,
  shouldConsiderGoogleDrive,
  type DriveIntent,
  type DriveIntentGenerator,
} from "./intent";
import {
  getDriveFile,
  listDriveFiles,
  resolveDriveParents,
  resolveDriveShortcut,
  type DriveSearchFilters,
  type ListDriveFilesOptions,
} from "./operations";
import {
  DRIVE_FOLDER_MIME,
  GOOGLE_DOC_MIME,
  type DriveDocumentContent,
  type DriveFileEntity,
} from "./types";

export interface HandlerResult {
  handled: boolean;
  reply?: string;
}

export interface DriveConversationDeps {
  arbitrated?: boolean;
  extract?: (input: { text: string; context?: boolean; generate?: DriveIntentGenerator }) => Promise<DriveIntent | null>;
  generateIntent?: DriveIntentGenerator;
  list?: (userId: string, options?: ListDriveFilesOptions) => Promise<Awaited<ReturnType<typeof listDriveFiles>>>;
  getFile?: (userId: string, fileId: string) => Promise<DriveFileEntity>;
  getParents?: (userId: string, file: DriveFileEntity) => Promise<DriveFileEntity[]>;
  resolveShortcut?: (userId: string, file: DriveFileEntity) => Promise<DriveFileEntity>;
  fetchContent?: (input: { userId: string; file: DriveFileEntity }) => Promise<DriveDocumentContent>;
  analyze?: typeof analyzeDriveDocument;
  compare?: typeof compareDriveDocuments;
  generateDocument?: DocumentGenerator;
  recordSelection?: typeof recordDriveSelection;
  recordAmbiguity?: typeof recordDriveAmbiguity;
  recordEntity?: typeof recordDriveEntity;
  resolveReference?: typeof resolveDriveReference;
  loadSelection?: typeof loadDriveSelection;
  loadEntity?: typeof loadDriveEntity;
  getConnection?: typeof getGoogleDriveConnection;
  propose?: (userId: string, input: CreateProposalInput) => Promise<unknown>;
  now?: Date;
  trace?: (event: DriveTraceEvent) => void;
}

export interface DriveTraceEvent {
  stage: "intent" | "entity" | "content" | "answer";
  operation: DriveIntent["operation"];
  fileRef?: string;
  fileName?: string;
  mimeType?: string;
  activeEntitySource?: "url" | "explicit_name" | "selection_name" | "ordinal_selection" | "active_entity";
  selectionSource?: "selection_set" | "none";
  contentCharacters?: number;
  contentLines?: number;
  contentSource?: "fresh";
  evidenceCharacters?: number;
}

const MIME_MAP: Record<NonNullable<DriveIntent["mimeCategory"]>, string[] | undefined> = {
  google_doc: [GOOGLE_DOC_MIME],
  pdf: ["application/pdf"],
  folder: [DRIVE_FOLDER_MIME],
  plain_text: ["text/plain"],
  markdown: ["text/markdown", "text/x-markdown"],
  any: undefined,
};

function explicitFollowupIntent(text: string): DriveIntent | null {
  const lower = text.toLowerCase();
  const position = parseDriveOrdinal(text);
  const base = {
    provider: "google_drive" as const,
    position,
    unresolvedReference: true,
    needsClarification: false,
  };
  if (/\bwho\b.*\b(?:owns?|owner)\b|\bowner\b/.test(lower)) return { ...base, operation: "owner" };
  if (/\b(?:modified|last changed|last updated|updated when)\b/.test(lower)) return { ...base, operation: "modified_time" };
  if (/\b(?:link|url)\b/.test(lower)) return { ...base, operation: "link" };
  if (/\b(?:folder|parent|where.*(?:stored|located))\b/.test(lower)) return { ...base, operation: "parent" };
  if (/\bcompare\b/.test(lower)) return { ...base, operation: "compare", comparePosition: position };
  if (/\b(?:key\s+(?:points?|priorities)|priorities)\b/.test(lower)) return { ...base, operation: "key_points" };
  if (/\bdecisions?\b/.test(lower)) return { ...base, operation: "decisions" };
  if (/\baction\s+items?\b|\b(?:tasks?\s+are\s+assigned|needs?\s+to\s+do\s+what)\b|\bunder\s+action\s+items?\b/.test(lower)) {
    return { ...base, operation: "action_items" };
  }
  if (/\bdeadlines?\b/.test(lower)) return { ...base, operation: "deadlines" };
  if (/\bsummari[sz]e|summary\b/.test(lower)) return { ...base, operation: "summarize" };
  if (/\b(?:what|who|when|where|why|how|does|is|are|which)\b/.test(lower)) {
    return { ...base, operation: "question", question: text };
  }
  return null;
}

function driveIdFromUrl(text: string): string | null {
  const match = /https?:\/\/(?:docs|drive)\.google\.com\/(?:document\/d\/|file\/d\/|open\?id=)([A-Za-z0-9_-]{10,})/i.exec(text);
  return match?.[1] ?? null;
}

function filtersFromIntent(intent: DriveIntent): DriveSearchFilters {
  const query = intent.query ?? intent.name ?? undefined;
  const filters: DriveSearchFilters = {
    mimeTypes: intent.mimeCategory ? MIME_MAP[intent.mimeCategory] : undefined,
    createdAfter: intent.createdAfter ?? undefined,
    createdBefore: intent.createdBefore ?? undefined,
    modifiedAfter: intent.modifiedAfter ?? undefined,
    modifiedBefore: intent.modifiedBefore ?? undefined,
    starred: intent.starred ?? undefined,
    ownerEmail: intent.ownerEmail ?? undefined,
    sharedWithMe: intent.sharedWithMe ?? undefined,
  };
  if (query) {
    if (intent.searchField === "name") filters.nameContains = query;
    else filters.fullTextContains = query;
  }
  return filters;
}

function applyExplicitFileType(text: string, intent: DriveIntent): DriveIntent {
  if (
    (intent.operation === "recent" || intent.operation === "list" || intent.operation === "search") &&
    /\bgoogle\s+docs?\b/i.test(text)
  ) {
    return { ...intent, mimeCategory: "google_doc" };
  }
  return intent;
}

function fileType(file: DriveFileEntity): string {
  if (file.mimeType === GOOGLE_DOC_MIME) return "Google Doc";
  if (file.mimeType === DRIVE_FOLDER_MIME) return "folder";
  if (file.mimeType === "application/pdf") return "PDF";
  if (file.contentAvailability === "plain_text") return "text file";
  if (file.contentAvailability === "shortcut") return "shortcut";
  return "file";
}

function displayFiles(files: DriveFileEntity[], incomplete: boolean): string {
  if (files.length === 0) return "I couldn’t find any matching, non-trashed files in your authorised Google Drive content.";
  const lines = files.map((file, index) => {
    const modified = file.modifiedTime ? ` — modified ${new Date(file.modifiedTime).toLocaleDateString("en-GB")}` : "";
    const location = file.sharedDrive ? " — Shared Drive" : "";
    return `${index + 1}. ${file.name} (${fileType(file)})${modified}${location}`;
  });
  if (incomplete) lines.push("", "Google reported that this Shared Drive search may be incomplete.");
  return lines.join("\n");
}

function sameName(files: DriveFileEntity[], name: string): DriveFileEntity[] {
  const exact = files.filter((file) => file.name.localeCompare(name, undefined, { sensitivity: "accent" }) === 0);
  return exact.length > 0 ? exact : files;
}

function normalizedMention(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ").trim();
}

function mentionsName(text: string, name: string): boolean {
  const haystack = normalizedMention(text);
  const needle = normalizedMention(name);
  if (needle.length < 2) return false;
  const index = haystack.indexOf(needle);
  if (index < 0) return false;
  const before = haystack[index - 1] ?? "";
  const after = haystack[index + needle.length] ?? "";
  return !/[\p{L}\p{N}]/u.test(before) && !/[\p{L}\p{N}]/u.test(after);
}

function namedSelectionReference(text: string, selection: DriveContextRef[]): DriveContextRef | null {
  const matches = selection
    .map((ref) => ({ ref, name: normalizedMention(ref.name) }))
    .filter(({ name }) => mentionsName(text, name))
    .sort((a, b) => b.name.length - a.name.length);
  if (!matches[0]) return null;
  if (matches[1]?.name.length === matches[0].name.length) return null;
  return matches[0].ref;
}

function dateQualifier(text: string): string | null {
  const match = /\b(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})\b/.exec(text);
  if (!match) return null;
  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10);
}

async function resolveSelectionQualifier(
  userId: string,
  text: string,
  deps: DriveConversationDeps,
): Promise<DriveFileEntity | null> {
  if (!/\b(?:the\s+)?one\b/i.test(text) || !/\bmodified\b/i.test(text)) return null;
  const date = dateQualifier(text);
  if (!date) return null;
  const selection = await (deps.loadSelection ?? loadDriveSelection)(userId);
  const matches = selection.filter((ref) => ref.modifiedTime?.slice(0, 10) === date);
  if (matches.length !== 1) return null;
  return authoritativeFile(userId, matches[0]!, deps);
}

async function resolveNamedFile(
  userId: string,
  name: string,
  deps: DriveConversationDeps,
  exactOnly = false,
): Promise<{ file: DriveFileEntity | null; ambiguous: DriveFileEntity[] }> {
  const result = await (deps.list ?? listDriveFiles)(userId, {
    filters: { nameContains: name },
    orderBy: "modifiedTime desc",
    maxResults: 10,
  });
  const candidates = exactOnly
    ? result.files.filter((file) => file.name.localeCompare(name, undefined, { sensitivity: "accent" }) === 0)
    : sameName(result.files, name);
  return {
    file: candidates.length === 1 ? candidates[0]! : null,
    ambiguous: candidates.length > 1 ? candidates : [],
  };
}

const DISCOVERABLE_NAMED_READ_OPERATIONS = new Set<DriveIntent["operation"]>([
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
]);

function isUnknownNamedReadCandidate(intent: DriveIntent | null): intent is DriveIntent & { name: string } {
  return Boolean(
    intent &&
    intent.provider === "unknown" &&
    intent.name?.trim() &&
    !intent.unresolvedReference &&
    DISCOVERABLE_NAMED_READ_OPERATIONS.has(intent.operation),
  );
}

async function recordNamedAmbiguity(
  userId: string,
  name: string,
  files: DriveFileEntity[],
  deps: DriveConversationDeps,
): Promise<HandlerResult> {
  await (deps.recordSelection ?? recordDriveSelection)(userId, files);
  await (deps.recordAmbiguity ?? recordDriveAmbiguity)(userId, files);
  return {
    handled: true,
    reply: `I found more than one Drive file called “${name}”.\n${displayFiles(files, false)}\nWhich one do you mean?`,
  };
}

async function authoritativeFile(
  userId: string,
  ref: DriveContextRef,
  deps: DriveConversationDeps,
): Promise<DriveFileEntity> {
  return (deps.getFile ?? getDriveFile)(userId, ref.fileId);
}

async function resolveTarget(
  userId: string,
  text: string,
  intent: DriveIntent,
  deps: DriveConversationDeps,
): Promise<{ file: DriveFileEntity | null; reply?: string; source?: DriveTraceEvent["activeEntitySource"] }> {
  const urlId = driveIdFromUrl(text);
  if (urlId) return { file: await (deps.getFile ?? getDriveFile)(userId, urlId), source: "url" };
  const requestedName = intent.name?.trim();
  if (requestedName && (!intent.unresolvedReference || mentionsName(text, requestedName))) {
    const named = await resolveNamedFile(userId, requestedName, deps);
    if (named.file) return { file: named.file, source: "explicit_name" };
    if (named.ambiguous.length > 0) {
      await (deps.recordSelection ?? recordDriveSelection)(userId, named.ambiguous);
      await (deps.recordAmbiguity ?? recordDriveAmbiguity)(userId, named.ambiguous);
      return { file: null, reply: `I found more than one Drive file called “${requestedName}”.\n${displayFiles(named.ambiguous, false)}\nWhich one do you mean?` };
    }
    return { file: null, reply: `I couldn’t find a Drive file called “${requestedName}”.` };
  }
  const selection = await (deps.loadSelection ?? loadDriveSelection)(userId);
  // Bare contextual follow-ups must resolve through activeEntity. Only use the
  // candidate list when the message actually names one of its files.
  const namedSelection = intent.name ? namedSelectionReference(text, selection) : null;
  if (namedSelection) return { file: await authoritativeFile(userId, namedSelection, deps), source: "selection_name" };
  const ref = await (deps.resolveReference ?? resolveDriveReference)(userId, text, intent.position);
  if (!ref) return { file: null, reply: "Which Drive file do you mean? Ask me to find it first, or give me its Google Drive link." };
  return {
    file: await authoritativeFile(userId, ref, deps),
    source: intent.position ? "ordinal_selection" : "active_entity",
  };
}

function analysisMode(operation: DriveIntent["operation"]): DocumentAnalysisMode {
  if (operation === "key_points" || operation === "decisions" || operation === "action_items" || operation === "deadlines") return operation;
  if (operation === "question") return "question";
  return "summary";
}

function idempotencyKey(userId: string, operation: string, name: string, content: string, now: Date): string {
  const tenMinuteBucket = Math.floor(now.getTime() / (10 * 60 * 1000));
  return createHash("sha256")
    .update(`${userId}\u0000${operation}\u0000${name.trim()}\u0000${content}\u0000${tenMinuteBucket}`)
    .digest("hex")
    .slice(0, 48);
}

function safeFileReference(fileId: string): string {
  return createHash("sha256").update(fileId).digest("hex").slice(0, 12);
}

function driveErrorReply(error: DriveError): string {
  if (error.reason === "provider_request_invalid") return "Google Drive couldn’t accept that request, so I didn’t make any changes. Please try again later.";
  if (error.reason === "not_connected") return "Connect Google Drive in Hula first, then I can help with your files.";
  if (error.reason === "insufficient_scope") return "Reconnect Google Drive and grant the requested Drive permissions before I can do that.";
  if (error.reason === "invalid_grant" || error.reason === "no_refresh_token") return "Your Google Drive connection needs to be reconnected in Hula.";
  if (error.reason === "file_not_found") return "That Drive file is no longer available to this connection. Ask me to find it again before trying another question about it.";
  if (error.reason === "unsupported_content") return "I can access this file’s details and link, but I can’t read PDF, Office, or image content yet.";
  if (error.reason === "response_too_large") return "That file is too large for me to read completely, so I haven’t analysed its content.";
  if (error.reason === "provider_rate_limited") return "Google Drive is rate-limiting requests right now. Please try again shortly.";
  if (error.reason === "drive_timeout") return "Google Drive took too long to respond. I didn’t make up an answer—please try again.";
  return "I couldn’t retrieve that from Google Drive reliably just now. Please try again.";
}

export async function handleGoogleDriveConversation(
  userId: string,
  text: string | undefined,
  deps: DriveConversationDeps = {},
): Promise<HandlerResult> {
  const value = (text ?? "").trim();
  if (!shouldConsiderGoogleDrive(value, deps.arbitrated)) return { handled: false };
  const startedAt = Date.now();
  try {
    const contextual = deps.arbitrated === true;
    if (contextual) {
      const qualified = await resolveSelectionQualifier(userId, value, deps);
      if (qualified) {
        await (deps.recordEntity ?? recordDriveEntity)(userId, qualified);
        logger.info("googleDrive.entity resolved", {
          operation: "disambiguate",
          fileRef: safeFileReference(qualified.fileId),
          mimeType: qualified.mimeType,
          source: "selection_metadata",
        });
        return {
          handled: true,
          reply: `I’ve selected “${qualified.name}”, modified ${new Date(qualified.modifiedTime!).toLocaleDateString("en-GB")}.`,
        };
      }
    }
    const deterministic = contextual ? explicitFollowupIntent(value) : explicitDriveIntent(value);
    const semantic = await (deps.extract ?? extractDriveIntent)({
      text: value,
      context: contextual,
      generate: deps.generateIntent,
    });
    const semanticDrive = semantic?.provider === "google_drive" && semantic.operation !== "not_drive"
      ? semantic
      : null;
    let discoveredTarget: { file: DriveFileEntity; source: "explicit_name" } | null = null;
    let discoveredIntent: DriveIntent | null = null;
    if (isUnknownNamedReadCandidate(semantic)) {
      const requestedName = semantic.name.trim();
      const named = await resolveNamedFile(userId, requestedName, deps, true);
      if (named.ambiguous.length > 0) {
        return recordNamedAmbiguity(userId, requestedName, named.ambiguous, deps);
      }
      if (!named.file) return { handled: false };
      discoveredIntent = { ...semantic, provider: "google_drive", name: requestedName };
      discoveredTarget = { file: named.file, source: "explicit_name" };
    }
    const extractedIntent = discoveredIntent ?? (contextual && deterministic && semanticDrive
      ? {
          ...semanticDrive,
          ...deterministic,
          // The deterministic `question` shape is only a routing fallback.
          // A semantic content mode (for example “What work is outstanding?”
          // → action_items) is more specific and must not be flattened back to
          // generic QA. Explicit metadata/summary patterns remain authoritative.
          operation: deterministic.operation === "question"
            ? semanticDrive.operation
            : deterministic.operation,
          name: semanticDrive.name ?? deterministic.name,
          question: semanticDrive.operation === "question"
            ? deterministic.question ?? semanticDrive.question
            : semanticDrive.question,
        }
      : semanticDrive ?? deterministic);
    const intent = extractedIntent ? applyExplicitFileType(value, extractedIntent) : null;
    if (!intent || intent.provider !== "google_drive" || intent.operation === "not_drive") return { handled: false };
    logger.info("googleDrive.intent resolved", {
      operation: intent.operation,
      mimeCategory: intent.mimeCategory ?? "any",
      explicitName: Boolean(intent.name),
      contextual,
    });
    deps.trace?.({ stage: "intent", operation: intent.operation });
    if (intent.needsClarification) return { handled: true, reply: "I need a little more detail before I can safely resolve that Drive request." };

    if (intent.operation === "status") {
      const connection = await (deps.getConnection ?? getGoogleDriveConnection)(userId);
      return connection?.status === "connected"
        ? { handled: true, reply: "Your Google Drive connection is active." }
        : { handled: true, reply: "Google Drive isn’t connected yet. You can connect it from Hula’s Integrations screen." };
    }

    if (intent.operation === "recent" || intent.operation === "list" || intent.operation === "search") {
      const result = await (deps.list ?? listDriveFiles)(userId, {
        filters: filtersFromIntent(intent),
        orderBy: intent.operation === "recent" ? "modifiedTime desc" : "modifiedTime desc",
        maxResults: intent.count ?? 10,
      });
      if (result.files.length > 0) await (deps.recordSelection ?? recordDriveSelection)(userId, result.files);
      logger.info("googleDrive.provider method", {
        method: "files.list",
        operation: intent.operation,
        resultCount: result.files.length,
        pagesFetched: result.pagesFetched,
        incompleteSearch: result.incompleteSearch,
        durationMs: Date.now() - startedAt,
      });
      return { handled: true, reply: displayFiles(result.files, result.incompleteSearch) };
    }

    if (intent.operation === "create_folder" || intent.operation === "create_doc") {
      const name = intent.name?.trim();
      if (!name) return { handled: true, reply: intent.operation === "create_folder" ? "What should I call the new Drive folder?" : "What should I call the new Google Doc?" };
      const content = intent.operation === "create_doc" ? intent.content ?? "" : "";
      const actionId = intent.operation === "create_folder" ? "drive.createFolder" : "drive.createDocument";
      const input = {
        name,
        content,
        idempotencyKey: idempotencyKey(userId, intent.operation, name, content, deps.now ?? new Date()),
      };
      const preview = intent.operation === "create_folder"
        ? `I’ll create an empty folder called “${name}” in your My Drive root. Reply Yes to confirm.`
        : `I’ll create a Google Doc called “${name}” in your My Drive root${content ? " with the initial content you provided" : ""}. Reply Yes to confirm.`;
      await (deps.propose ?? createActionProposal)(userId, {
        provider: "google_drive",
        actionId,
        riskLevel: "write",
        confirmationRequired: true,
        input,
        previewText: preview,
      });
      return { handled: true, reply: preview };
    }

    if (intent.operation === "compare") {
      const activeRef = await (deps.loadEntity ?? loadDriveEntity)(userId);
      const selection = await (deps.loadSelection ?? loadDriveSelection)(userId);
      const position = intent.comparePosition ?? parseDriveOrdinal(value);
      const otherRef = position ? selection[position - 1] : null;
      const firstRef = activeRef ?? selection[0] ?? null;
      if (!firstRef || !otherRef || firstRef.fileId === otherRef.fileId) {
        return { handled: true, reply: "Which two Drive documents should I compare? Find them first, then refer to their numbers." };
      }
      const [firstFile, secondFile] = await Promise.all([
        authoritativeFile(userId, firstRef, deps),
        authoritativeFile(userId, otherRef, deps),
      ]);
      const [firstContent, secondContent] = await Promise.all([
        (deps.fetchContent ?? fetchDriveDocumentContent)({ userId, file: firstFile }),
        (deps.fetchContent ?? fetchDriveDocumentContent)({ userId, file: secondFile }),
      ]);
      const reply = await (deps.compare ?? compareDriveDocuments)({
        first: firstContent,
        second: secondContent,
        generate: deps.generateDocument,
      });
      await (deps.recordEntity ?? recordDriveEntity)(userId, firstFile);
      return { handled: true, reply: `Based on what I read in “${firstFile.name}” and “${secondFile.name}”:\n${reply}` };
    }

    const target: {
      file: DriveFileEntity | null;
      reply?: string;
      source?: DriveTraceEvent["activeEntitySource"];
    } = discoveredTarget ?? await resolveTarget(userId, value, intent, deps);
    if (!target.file) return { handled: true, reply: target.reply };
    const originalFile = target.file;
    const file = originalFile.shortcut
      ? await (deps.resolveShortcut ?? resolveDriveShortcut)(userId, originalFile)
      : originalFile;
    logger.info("googleDrive.entity resolved", {
      operation: intent.operation,
      fileRef: safeFileReference(file.fileId),
      mimeType: file.mimeType,
      shortcutResolved: Boolean(originalFile.shortcut),
      activeEntitySource: target.source ?? "active_entity",
    });
    deps.trace?.({
      stage: "entity",
      operation: intent.operation,
      fileRef: safeFileReference(file.fileId),
      fileName: file.name,
      mimeType: file.mimeType,
      activeEntitySource: target.source ?? "active_entity",
      selectionSource: target.source === "selection_name" || target.source === "ordinal_selection" ? "selection_set" : "none",
    });

    if (intent.operation === "owner") {
      await (deps.recordEntity ?? recordDriveEntity)(userId, file);
      if (file.owners.length === 0) {
        return { handled: true, reply: file.sharedDrive
          ? `“${file.name}” is in a Shared Drive, where Google does not provide an individual owner.`
          : `Google didn’t provide owner information for “${file.name}”.` };
      }
      return { handled: true, reply: `Google Drive lists ${file.owners.map((item) => item.displayName ?? item.emailAddress ?? "an unnamed owner").join(", ")} as owner${file.owners.length === 1 ? "" : "s"} of “${file.name}”.` };
    }
    if (intent.operation === "modified_time") {
      await (deps.recordEntity ?? recordDriveEntity)(userId, file);
      return { handled: true, reply: file.modifiedTime
        ? `Google Drive says “${file.name}” was last modified ${new Date(file.modifiedTime).toLocaleString("en-GB")}.`
        : `Google didn’t provide a modified time for “${file.name}”.` };
    }
    if (intent.operation === "link") {
      await (deps.recordEntity ?? recordDriveEntity)(userId, file);
      return { handled: true, reply: file.webViewLink
        ? `Here’s Google Drive’s link for “${file.name}”: ${file.webViewLink}`
        : `Google didn’t provide a view link for “${file.name}”.` };
    }
    if (intent.operation === "parent") {
      const parents = await (deps.getParents ?? resolveDriveParents)(userId, file);
      await (deps.recordEntity ?? recordDriveEntity)(userId, file);
      return { handled: true, reply: parents.length > 0
        ? `Google Drive places “${file.name}” in ${parents.map((parent) => `“${parent.name}”`).join(", ")}.`
        : file.sharedDrive
          ? `Google didn’t expose an accessible parent folder for “${file.name}” in its Shared Drive.`
          : `Google Drive reports no accessible parent folder for “${file.name}”; it may be in My Drive root.` };
    }
    if (intent.operation === "metadata") {
      await (deps.recordEntity ?? recordDriveEntity)(userId, file);
      return { handled: true, reply: [
        `“${file.name}” is a ${fileType(file)} in ${file.sharedDrive ? "a Shared Drive" : "My Drive or shared-with-me content"}.`,
        file.modifiedTime ? `Modified: ${new Date(file.modifiedTime).toLocaleString("en-GB")}.` : null,
        file.webViewLink ? `Link: ${file.webViewLink}` : null,
      ].filter(Boolean).join("\n") };
    }

    const content = await (deps.fetchContent ?? fetchDriveDocumentContent)({ userId, file });
    logger.info("googleDrive.content loaded", {
      fileRef: safeFileReference(file.fileId),
      mimeType: file.mimeType,
      characters: content.processedCharacters,
      originalCharacters: content.originalCharacters,
      blocks: content.sections.length,
      lines: content.text.split(/\r?\n/).length,
      source: "fresh",
      truncated: content.truncated,
    });
    deps.trace?.({
      stage: "content",
      operation: intent.operation,
      fileRef: safeFileReference(file.fileId),
      fileName: file.name,
      mimeType: file.mimeType,
      contentCharacters: content.processedCharacters,
      contentLines: content.text.split(/\r?\n/).length,
      contentSource: "fresh",
    });
    const reply = await (deps.analyze ?? analyzeDriveDocument)({
      content,
      mode: analysisMode(intent.operation),
      question: intent.question ?? (intent.operation === "question" ? value : undefined),
      generate: deps.generateDocument,
    });
    await (deps.recordEntity ?? recordDriveEntity)(userId, file);
    logger.info("googleDrive.answer mode", {
      mode: analysisMode(intent.operation),
      fallback: reply === "I couldn’t find that in the document.",
      durationMs: Date.now() - startedAt,
      evidenceCharacters: reply.length,
    });
    deps.trace?.({
      stage: "answer",
      operation: intent.operation,
      fileRef: safeFileReference(file.fileId),
      fileName: file.name,
      mimeType: file.mimeType,
      evidenceCharacters: reply.length,
    });
    const provenance = `Based on what I read in “${file.name}”` +
      (content.truncated ? " (I could only read part of it)" : "") + ":";
    return { handled: true, reply: `${provenance}\n${reply}` };
  } catch (error) {
    if (error instanceof DriveError) {
      logger.info("googleDrive.route duration", { outcome: error.reason, durationMs: Date.now() - startedAt });
      return { handled: true, reply: driveErrorReply(error) };
    }
    logger.info("googleDrive.route duration", { outcome: "failed_closed", durationMs: Date.now() - startedAt });
    return { handled: true, reply: "I couldn’t complete that Google Drive request reliably, so I haven’t invented an answer." };
  }
}
