import { loadGroundedContexts } from "../../../actions/entityContextArbiter";
import { getGoogleDriveConnection } from "../googleDrive/client";
import {
  analyzeDriveDocument,
  compareDriveDocuments,
  type DocumentAnalysisMode,
  type DocumentGenerator,
} from "../googleDrive/documentIntelligence";
import { logger } from "../../../utils/logger";
import { getMicrosoftConnection } from "./client";
import {
  loadOneDriveEntity,
  loadOneDriveSelection,
  recordOneDriveEntity,
  recordOneDriveSelection,
  resolveOneDriveReference,
  type OneDriveContextStore,
  type OneDriveItemRef,
} from "./oneDriveContext";
import {
  explicitFileProvider,
  explicitOneDriveFollowupIntent,
  explicitOneDriveIntent,
  extractOneDriveIntent,
  shouldConsiderOneDrive,
  type OneDriveIntent,
  type OneDriveIntentGenerator,
} from "./oneDriveIntent";
import { discoverOneDriveNamedItem } from "./oneDriveDiscovery";
import {
  getOneDriveDriveOwner,
  getOneDriveItem,
  getOneDriveTextContent,
  listOneDriveFolder,
  listOneDriveRecent,
  listOneDriveRoot,
  oneDriveDocumentContent,
  ONEDRIVE_MAX_LIST_ITEMS,
  searchOneDriveItems,
  type OneDriveDeps,
} from "./oneDriveOperations";
import type { OneDriveIdentity, OneDriveItem } from "./oneDriveTypes";
import { MicrosoftGraphError } from "./graph";

export interface OneDriveConversationDeps extends OneDriveDeps, OneDriveContextStore {
  arbitrated?: boolean;
  extract?: typeof extractOneDriveIntent;
  generateIntent?: OneDriveIntentGenerator;
  generateAnalysis?: DocumentGenerator;
  getMicrosoftState?: (userId: string) => Promise<{ connected: boolean }>;
  getGoogleState?: (userId: string) => Promise<{ connected: boolean }>;
  getContexts?: typeof loadGroundedContexts;
  root?: typeof listOneDriveRoot;
  recent?: typeof listOneDriveRecent;
  search?: typeof searchOneDriveItems;
  folder?: typeof listOneDriveFolder;
  get?: typeof getOneDriveItem;
  getOwner?: typeof getOneDriveDriveOwner;
  getContent?: typeof getOneDriveTextContent;
  analyze?: typeof analyzeDriveDocument;
  compare?: typeof compareDriveDocuments;
}

export interface OneDriveConversationResult {
  handled: boolean;
  reply?: string;
  routeSource?: string;
}

async function microsoftState(userId: string): Promise<{ connected: boolean }> {
  const connection = await getMicrosoftConnection(userId);
  return { connected: connection?.status === "connected" && connection.capabilities.includes("onedrive.read") };
}

async function googleState(userId: string): Promise<{ connected: boolean }> {
  const connection = await getGoogleDriveConnection(userId);
  return { connected: connection?.status === "connected" };
}

async function fileOwner(
  userId: string,
  text: string,
  deps: OneDriveConversationDeps,
): Promise<"onedrive" | "google_drive" | "ambiguous" | "none"> {
  const explicit = explicitFileProvider(text);
  const microsoft = await (deps.getMicrosoftState ?? microsoftState)(userId);
  const google = await (deps.getGoogleState ?? googleState)(userId);
  if (explicit === "onedrive") return microsoft.connected ? "onedrive" : "none";
  if (explicit === "google_drive") return "google_drive";
  if (deps.arbitrated) return "onedrive";
  const contexts = await (deps.getContexts ?? loadGroundedContexts)(userId);
  const file = contexts.find((item) => item.kind === "onedrive_file" || item.kind === "drive_file");
  if (file?.kind === "onedrive_file") return "onedrive";
  if (file?.kind === "drive_file") return "google_drive";
  if (microsoft.connected && google.connected) return "ambiguous";
  if (microsoft.connected) return "onedrive";
  if (google.connected) return "google_drive";
  return "none";
}

function itemType(item: OneDriveItem): string {
  if (item.isFolder) return "folder";
  return item.extension?.toUpperCase() ?? item.mimeType ?? "file";
}

function date(value: string | null): string {
  if (!value) return "date unavailable";
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" }).format(new Date(value));
}

export function formatOneDriveItems(items: OneDriveItem[], hasMore = false): string {
  if (!items.length) return "I couldn’t find any matching OneDrive items.";
  const header = hasMore
    ? `I’m showing the first ${items.length} matching OneDrive items:`
    : `I found ${items.length} matching OneDrive item${items.length === 1 ? "" : "s"}:`;
  return [header, ...items.map((item, index) => `${index + 1}. ${item.name} — ${itemType(item)} — modified ${date(item.modifiedAt)}`)].join("\n");
}

function identityLabel(identity: OneDriveIdentity): string {
  return identity.name && identity.email ? `${identity.name} <${identity.email}>` : identity.name ?? identity.email ?? "not shown";
}

function metadata(item: OneDriveItem, owner?: OneDriveIdentity): string {
  return [
    `${item.name} — ${itemType(item)}`,
    `Owner: ${identityLabel(owner ?? item.owner)}`,
    `Last modified by: ${identityLabel(item.modifiedBy)}`,
    `Modified: ${date(item.modifiedAt)}`,
    `Created: ${date(item.createdAt)}`,
    `Size: ${item.sizeBytes === null ? "not shown" : `${item.sizeBytes.toLocaleString()} bytes`}`,
    `Folder: ${item.parentPath ?? "not shown"}`,
    item.webUrl ? `Link: ${item.webUrl}` : "Link: not returned",
  ].join("\n");
}

async function authoritative(ref: OneDriveItemRef, userId: string, deps: OneDriveConversationDeps): Promise<OneDriveItem> {
  return (deps.get ?? getOneDriveItem)(userId, ref, deps);
}

async function findNamed(
  userId: string,
  name: string,
  text: string,
  active: OneDriveItemRef | null,
  deps: OneDriveConversationDeps,
): Promise<Awaited<ReturnType<typeof discoverOneDriveNamedItem>>> {
  const useFolder = Boolean(
    active?.isFolder &&
    (/\b(?:this|that|the)\s+folder\b/i.test(text) || /\bin\s+it\b/i.test(text)),
  );
  return discoverOneDriveNamedItem({
    userId,
    query: name,
    search: () => (deps.search ?? searchOneDriveItems)(userId, name, 20, deps),
    fallback: () => useFolder
      ? (deps.folder ?? listOneDriveFolder)(userId, active!, ONEDRIVE_MAX_LIST_ITEMS, deps)
      : (deps.root ?? listOneDriveRoot)(userId, ONEDRIVE_MAX_LIST_ITEMS, deps),
    fallbackSource: useFolder ? "folder_listing" : "root_listing",
  });
}

async function resolveTarget(
  userId: string,
  text: string,
  intent: OneDriveIntent,
  active: OneDriveItemRef | null,
  deps: OneDriveConversationDeps,
): Promise<{ item: OneDriveItem | null; reply?: string }> {
  if (intent.name || intent.query) {
    const named = await findNamed(userId, intent.name ?? intent.query!, text, active, deps);
    if (named.item) return { item: named.item };
    if (named.ambiguous.length) {
      await recordOneDriveSelection(userId, named.ambiguous, deps);
      return { item: null, reply: `${formatOneDriveItems(named.ambiguous)}\nWhich one do you mean?` };
    }
    return { item: null, reply: "I couldn’t find a matching OneDrive item." };
  }
  const ref = await resolveOneDriveReference(userId, text, intent.ordinal, deps);
  return ref
    ? { item: await authoritative(ref, userId, deps) }
    : { item: null, reply: "Which OneDrive item do you mean? Ask me to find it first." };
}

function analysisMode(operation: OneDriveIntent["operation"]): DocumentAnalysisMode {
  if (operation === "key_points" || operation === "action_items" || operation === "deadlines" || operation === "decisions" || operation === "question") return operation;
  return "summary";
}

function graphReply(error: MicrosoftGraphError): string {
  if (error.reason === "not_connected") return "Connect Microsoft 365 in Hula first, then I can check OneDrive.";
  if (error.reason === "reconnect_required") return "Your Microsoft 365 connection needs to be reconnected in Hula.";
  if (error.reason === "insufficient_capability" || error.reason === "permission_denied") return "Reconnect Microsoft 365 and grant OneDrive read access before I can do that.";
  if (error.reason === "unsupported_content") return "I can show this file’s metadata and link, but I can’t read this file type. OneDrive content Q&A currently supports plain text, Markdown, CSV, and JSON.";
  if (error.reason === "response_too_large") return "That text file is too large for the bounded OneDrive reader. I can still show its metadata and link.";
  if (error.reason === "rate_limited") return "OneDrive is rate-limiting requests right now. Please try again shortly.";
  if (error.reason === "not_found") return "That OneDrive item is no longer available. Ask me to find it again.";
  return "I couldn’t retrieve that reliably from OneDrive just now.";
}

export async function handleOneDriveConversation(
  userId: string,
  text: string | undefined,
  deps: OneDriveConversationDeps = {},
): Promise<OneDriveConversationResult> {
  const value = (text ?? "").trim();
  if (!shouldConsiderOneDrive(value, deps.arbitrated)) return { handled: false };
  const startedAt = Date.now();
  try {
    const explicit = explicitFileProvider(value);
    const owner = await fileOwner(userId, value, deps);
    if (explicit === "onedrive" && owner === "none") return { handled: true, reply: "Your OneDrive account isn’t available. Reconnect Microsoft 365 in Hula; I won’t silently use Google Drive instead." };
    if (owner === "google_drive") return { handled: false };
    if (owner === "ambiguous") return { handled: true, reply: "Do you want Google Drive or OneDrive? Both are connected, and I don’t want to search the wrong place." };
    if (owner === "none") return { handled: false };

    const active = await loadOneDriveEntity(userId, deps);
    const semantic = await (deps.extract ?? extractOneDriveIntent)({ text: value, hasContext: Boolean(active), generate: deps.generateIntent });
    let intent = semantic && semantic.operation !== "not_file"
      ? semantic
      : explicitOneDriveIntent(value) ?? (active || deps.arbitrated ? explicitOneDriveFollowupIntent(value) : null);
    if (intent && explicit === "onedrive") intent = { ...intent, provider: "onedrive" };
    if (intent && (active || deps.arbitrated) && intent.provider === "unknown") {
      intent = { ...intent, provider: "onedrive" };
    }
    if (!intent || intent.operation === "not_file" || intent.provider === "google_drive" || intent.provider === "not_file") {
      return explicit === "onedrive"
        ? { handled: true, reply: "What would you like me to find or explain in OneDrive?" }
        : { handled: false };
    }
    logger.info("onedrive.intent resolved", {
      operation: intent.operation,
      provider: intent.provider,
      hasName: Boolean(intent.name || intent.query),
      requestedCount: intent.count ?? null,
      source: semantic ? "semantic" : "deterministic",
    });

    if (intent.operation === "search") {
      const requestedName = intent.name ?? intent.query;
      if (!requestedName) return { handled: true, reply: "What should I search for in OneDrive?" };
      const named = await findNamed(userId, requestedName, value, active, deps);
      if (named.item) {
        await recordOneDriveSelection(userId, [named.item], deps);
        await recordOneDriveEntity(userId, named.item, deps);
        logger.info("onedrive.entity resolved", {
          operation: intent.operation,
          source: named.source,
          matchStrategy: named.matchStrategy,
          mimeCategory: named.item.contentAvailability,
        });
        return { handled: true, reply: formatOneDriveItems([named.item]) };
      }
      if (named.ambiguous.length) {
        await recordOneDriveSelection(userId, named.ambiguous, deps);
        return {
          handled: true,
          reply: `${formatOneDriveItems(named.ambiguous)}\nWhich one do you mean?`,
        };
      }
      return { handled: true, reply: `I couldn’t find a OneDrive item matching “${requestedName}”.` };
    }

    if (intent.operation === "root" || intent.operation === "recent") {
      const result = intent.operation === "root"
        ? await (deps.root ?? listOneDriveRoot)(userId, intent.count ?? 10, deps)
        : await (deps.recent ?? listOneDriveRecent)(userId, intent.count ?? 10, deps);
      await recordOneDriveSelection(userId, result.items, deps);
      return { handled: true, reply: formatOneDriveItems(result.items, result.hasMore) };
    }

    const target = await resolveTarget(userId, value, intent, active, deps);
    if (!target.item) return { handled: true, reply: target.reply };
    await recordOneDriveEntity(userId, target.item, deps);
    logger.info("onedrive.entity resolved", {
      operation: intent.operation,
      source: intent.name || intent.query ? "named_discovery" : "active_entity",
      mimeCategory: target.item.contentAvailability,
    });

    if (intent.operation === "list_folder") {
      if (!target.item.isFolder) return { handled: true, reply: `“${target.item.name}” is a file, not a OneDrive folder.` };
      const result = await (deps.folder ?? listOneDriveFolder)(userId, target.item, intent.count ?? 20, deps);
      await recordOneDriveSelection(userId, result.items, deps);
      return { handled: true, reply: formatOneDriveItems(result.items, result.hasMore) };
    }
    if (intent.operation === "link") return { handled: true, reply: target.item.webUrl ? `Here’s the OneDrive link: ${target.item.webUrl}` : "Microsoft didn’t return a web link for this item." };
    if (intent.operation === "modified") return { handled: true, reply: `“${target.item.name}” was last modified ${date(target.item.modifiedAt)} by ${identityLabel(target.item.modifiedBy)}.` };
    if (intent.operation === "owner") {
      const driveOwner = await (deps.getOwner ?? getOneDriveDriveOwner)(userId, target.item.driveId, deps);
      return { handled: true, reply: `The OneDrive owner is ${identityLabel(driveOwner)}. “${target.item.name}” was last modified by ${identityLabel(target.item.modifiedBy)}.` };
    }
    if (intent.operation === "get" || intent.operation === "metadata") {
      const driveOwner = await (deps.getOwner ?? getOneDriveDriveOwner)(userId, target.item.driveId, deps).catch(() => target.item!.owner);
      return { handled: true, reply: metadata(target.item, driveOwner) };
    }
    if (intent.operation === "compare") {
      const selection = await loadOneDriveSelection(userId, deps);
      const activeRef = await loadOneDriveEntity(userId, deps);
      const otherPosition = intent.secondOrdinal ?? intent.ordinal;
      const otherRef = otherPosition ? selection[otherPosition - 1] : null;
      if (!activeRef || !otherRef || activeRef.itemId === otherRef.itemId) return { handled: true, reply: "Which two OneDrive text files should I compare?" };
      const [first, second] = await Promise.all([authoritative(activeRef, userId, deps), authoritative(otherRef, userId, deps)]);
      const [firstRaw, secondRaw] = await Promise.all([
        (deps.getContent ?? getOneDriveTextContent)(userId, first, deps),
        (deps.getContent ?? getOneDriveTextContent)(userId, second, deps),
      ]);
      const reply = await (deps.compare ?? compareDriveDocuments)({
        first: oneDriveDocumentContent(firstRaw),
        second: oneDriveDocumentContent(secondRaw),
        generate: deps.generateAnalysis,
      });
      return { handled: true, reply };
    }
    if (target.item.contentAvailability !== "text") throw new MicrosoftGraphError("unsupported_content");
    const raw = await (deps.getContent ?? getOneDriveTextContent)(userId, target.item, deps);
    logger.info("onedrive.content loaded", {
      mimeCategory: target.item.extension ?? "text",
      contentLength: raw.processedCharacters,
      truncated: raw.truncated,
      source: "active_entity",
    });
    const reply = await (deps.analyze ?? analyzeDriveDocument)({
      content: oneDriveDocumentContent(raw),
      mode: analysisMode(intent.operation),
      question: intent.question ?? value,
      generate: deps.generateAnalysis,
    });
    logger.info("onedrive.grounding outcome", {
      operation: intent.operation,
      outcome: reply.trim() ? "grounded_answer" : "no_evidence",
    });
    return { handled: true, reply };
  } catch (error) {
    if (error instanceof MicrosoftGraphError) return { handled: true, reply: graphReply(error) };
    logger.error("onedrive conversation failed", { errorCode: "unexpected" });
    return { handled: true, reply: "I couldn’t handle that OneDrive request reliably just now." };
  } finally {
    logger.info("onedrive.route duration", { durationMs: Date.now() - startedAt });
  }
}
