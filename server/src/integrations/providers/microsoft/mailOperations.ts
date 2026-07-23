import { microsoftGraphRequest, MicrosoftGraphError, isSafeMicrosoftNextLink } from "./graph";
import { normalizeOutlookBody } from "./mailBody";
import { logger } from "../../../utils/logger";
import { completeOutlookSubject } from "./mailComposition";
import type {
  OutlookAddress,
  OutlookAttachment,
  OutlookFolder,
  OutlookMailMutation,
  OutlookMessage,
  OutlookMessageQuery,
  OutlookMutationReceipt,
  OutlookPage,
  OutlookWellKnownFolder,
} from "./mailTypes";

const LIST_SELECT = [
  "id", "conversationId", "internetMessageId", "parentFolderId", "subject",
  "from", "sender", "replyTo", "toRecipients", "ccRecipients", "bccRecipients",
  "receivedDateTime", "sentDateTime", "createdDateTime", "lastModifiedDateTime",
  "isRead", "isDraft", "importance", "hasAttachments", "bodyPreview",
].join(",");
const DETAIL_SELECT = `${LIST_SELECT},body`;
const MAX_RESULTS = 20;
const MAX_PAGES = 3;
const DELETE_VERIFY_DELAYS_MS = [0, 300, 900, 1_500] as const;

export type MailRequest = typeof microsoftGraphRequest;

export interface OutlookMailDeps {
  request?: MailRequest;
  sleep?: (ms: number) => Promise<void>;
}

function obj(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function date(value: unknown): string | null {
  const parsed = text(value);
  return parsed && Number.isFinite(Date.parse(parsed)) ? new Date(parsed).toISOString() : null;
}

function address(value: unknown): OutlookAddress | null {
  const wrapper = obj(value);
  const raw = obj(wrapper?.emailAddress ?? value);
  const valueAddress = text(raw?.address)?.toLowerCase();
  if (!valueAddress || !valueAddress.includes("@")) return null;
  return { address: valueAddress, name: text(raw?.name) };
}

function addresses(value: unknown): OutlookAddress[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: OutlookAddress[] = [];
  for (const item of value) {
    const parsed = address(item);
    if (!parsed || seen.has(parsed.address)) continue;
    seen.add(parsed.address);
    result.push(parsed);
  }
  return result;
}

function attachmentKind(value: unknown): OutlookAttachment["kind"] {
  const type = text(value)?.toLowerCase() ?? "";
  if (type.endsWith("fileattachment")) return "file";
  if (type.endsWith("itemattachment")) return "item";
  if (type.endsWith("referenceattachment")) return "reference";
  return "unknown";
}

function normalizeAttachment(value: unknown): OutlookAttachment | null {
  const raw = obj(value);
  const id = text(raw?.id);
  const name = text(raw?.name);
  if (!id || !name) return null;
  const size = typeof raw?.size === "number" && Number.isFinite(raw.size)
    ? Math.max(0, Math.trunc(raw.size))
    : 0;
  return {
    id,
    name,
    contentType: text(raw?.contentType),
    size,
    isInline: raw?.isInline === true,
    kind: attachmentKind(raw?.["@odata.type"]),
  };
}

export function normalizeOutlookMessage(value: unknown): OutlookMessage | null {
  const raw = obj(value);
  const id = text(raw?.id);
  if (!id) return null;
  const body = obj(raw?.body);
  const importance = text(raw?.importance)?.toLowerCase();
  return {
    id,
    conversationId: text(raw?.conversationId),
    internetMessageId: text(raw?.internetMessageId),
    parentFolderId: text(raw?.parentFolderId),
    subject: text(raw?.subject) ?? "(No subject)",
    from: address(raw?.from),
    sender: address(raw?.sender),
    replyTo: addresses(raw?.replyTo),
    to: addresses(raw?.toRecipients),
    cc: addresses(raw?.ccRecipients),
    bcc: addresses(raw?.bccRecipients),
    receivedAt: date(raw?.receivedDateTime),
    sentAt: date(raw?.sentDateTime),
    createdAt: date(raw?.createdDateTime),
    modifiedAt: date(raw?.lastModifiedDateTime),
    isRead: raw?.isRead === true,
    isDraft: raw?.isDraft === true,
    importance: importance === "low" || importance === "high" ? importance : "normal",
    hasAttachments: raw?.hasAttachments === true,
    preview: normalizeOutlookBody(text(raw?.bodyPreview) ?? "", "text").slice(0, 500),
    body: body ? normalizeOutlookBody(text(body.content) ?? "", text(body.contentType)) : null,
    bodyType: text(body?.contentType)?.toLowerCase() === "html" ? "html" : body ? "text" : null,
    attachments: Array.isArray(raw?.attachments)
      ? raw.attachments.flatMap((item) => normalizeAttachment(item) ?? [])
      : [],
  };
}

export function normalizeOutlookFolder(value: unknown): OutlookFolder | null {
  const raw = obj(value);
  const id = text(raw?.id);
  const displayName = text(raw?.displayName);
  if (!id || !displayName) return null;
  const count = (candidate: unknown) => typeof candidate === "number" && Number.isFinite(candidate)
    ? Math.max(0, Math.trunc(candidate))
    : 0;
  return {
    id,
    displayName,
    parentFolderId: text(raw?.parentFolderId),
    childFolderCount: count(raw?.childFolderCount),
    totalItemCount: count(raw?.totalItemCount),
    unreadItemCount: count(raw?.unreadItemCount),
    isHidden: raw?.isHidden === true,
  };
}

function collection(value: unknown): { value: unknown[]; nextLink: string | null } {
  const raw = obj(value);
  if (!raw || !Array.isArray(raw.value)) {
    throw new MicrosoftGraphError("malformed_provider_response");
  }
  const nextLink = text(raw["@odata.nextLink"]);
  if (nextLink && !isSafeMicrosoftNextLink(nextLink)) {
    throw new MicrosoftGraphError("malformed_provider_response");
  }
  return { value: raw.value, nextLink };
}

function bounded(value: number | undefined, fallback: number, max: number): number {
  return Number.isFinite(value) ? Math.min(Math.max(1, Math.trunc(value!)), max) : fallback;
}

function cleanSearchTerm(value: string): string {
  return value.replace(/["\\\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
}

export function buildOutlookSearchExpression(query: OutlookMessageQuery): string | null {
  const parts: string[] = [];
  const sender = query.sender ? cleanSearchTerm(query.sender) : "";
  const subject = query.subject ? cleanSearchTerm(query.subject) : "";
  const keyword = query.query ? cleanSearchTerm(query.query) : "";
  if (sender) parts.push(`from:${sender}`);
  if (subject) parts.push(`subject:${subject}`);
  if (keyword) parts.push(keyword);
  return parts.length ? `"${parts.join(" ")}"` : null;
}

function validIso(value: string | undefined): string | null {
  return value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
}

function localMatches(message: OutlookMessage, query: OutlookMessageQuery): boolean {
  if (query.unread !== undefined && message.isRead === query.unread) return false;
  const received = message.receivedAt ? Date.parse(message.receivedAt) : NaN;
  const after = validIso(query.receivedAfter);
  const before = validIso(query.receivedBefore);
  if (after && (!Number.isFinite(received) || received < Date.parse(after))) return false;
  if (before && (!Number.isFinite(received) || received >= Date.parse(before))) return false;
  return true;
}

function folderPath(folder: string | undefined): string {
  const value = (folder ?? "inbox").trim();
  return `/me/mailFolders/${encodeURIComponent(value)}/messages`;
}

export async function listOutlookMessages(
  userId: string,
  query: OutlookMessageQuery = {},
  deps: OutlookMailDeps = {},
): Promise<OutlookPage<OutlookMessage>> {
  const request = deps.request ?? microsoftGraphRequest;
  const limit = bounded(query.maxResults, 10, MAX_RESULTS);
  const maxPages = bounded(query.maxPages, MAX_PAGES, MAX_PAGES);
  const search = buildOutlookSearchExpression(query);
  const filters: string[] = [];
  if (!search && query.unread !== undefined) filters.push(`isRead eq ${query.unread ? "false" : "true"}`);
  const after = validIso(query.receivedAfter);
  const before = validIso(query.receivedBefore);
  if (!search && after) filters.unshift(`receivedDateTime ge ${after}`);
  if (!search && before) filters.unshift(`receivedDateTime lt ${before}`);
  // Graph requires every $orderby property to appear first in $filter. Add a
  // harmless mailbox-era lower bound when read state is the only filter.
  if (!search && filters.length && !after && !before) {
    filters.unshift("receivedDateTime ge 1900-01-01T00:00:00Z");
  }

  let nextLink: string | null = null;
  let page = 0;
  let fetchedCount = 0;
  const seen = new Set<string>();
  const items: OutlookMessage[] = [];
  do {
    const raw: unknown = await request(userId, {
      capability: "outlook_mail.read",
      path: nextLink ? undefined : folderPath(query.folder),
      nextLink: nextLink ?? undefined,
      query: nextLink ? undefined : {
        "$select": LIST_SELECT,
        "$top": Math.min(25, Math.max(limit, search ? limit * 2 : limit)),
        ...(search ? { "$search": search } : { "$orderby": "receivedDateTime desc" }),
        ...(filters.length ? { "$filter": filters.join(" and ") } : {}),
      },
      headers: { Prefer: 'IdType="ImmutableId", outlook.body-content-type="text"' },
    });
    const result = collection(raw);
    fetchedCount += result.value.length;
    for (const candidate of result.value) {
      const message = normalizeOutlookMessage(candidate);
      if (!message || seen.has(message.id) || !localMatches(message, query)) continue;
      seen.add(message.id);
      items.push(message);
    }
    nextLink = result.nextLink;
    page += 1;
  } while (nextLink && page < maxPages && items.length < limit);

  items.sort((a, b) => Date.parse(b.receivedAt ?? b.sentAt ?? "") - Date.parse(a.receivedAt ?? a.sentAt ?? ""));
  return {
    items: items.slice(0, limit),
    nextLink,
    hasMore: Boolean(nextLink) || items.length > limit,
    fetchedCount,
  };
}

export async function listOutlookFolders(
  userId: string,
  deps: OutlookMailDeps = {},
): Promise<OutlookPage<OutlookFolder>> {
  const request = deps.request ?? microsoftGraphRequest;
  const raw: unknown = await request(userId, {
    capability: "outlook_mail.read",
    path: "/me/mailFolders",
    query: {
      "$select": "id,displayName,parentFolderId,childFolderCount,totalItemCount,unreadItemCount,isHidden",
      "$top": 50,
      includeHiddenFolders: false,
    },
  });
  const result = collection(raw);
  const items = result.value.flatMap((item) => normalizeOutlookFolder(item) ?? []);
  return { items, nextLink: result.nextLink, hasMore: Boolean(result.nextLink), fetchedCount: result.value.length };
}

export async function resolveOutlookFolder(
  userId: string,
  value: string,
  deps: OutlookMailDeps = {},
): Promise<string> {
  const wellKnown = new Set<OutlookWellKnownFolder>(["inbox", "drafts", "sentitems", "deleteditems", "archive", "junkemail"]);
  const normalized = value.toLowerCase().replace(/[\s_-]+/g, "") as OutlookWellKnownFolder;
  if (wellKnown.has(normalized)) return normalized;
  const folders = await listOutlookFolders(userId, deps);
  const matches = folders.items.filter((folder) => folder.displayName.localeCompare(value, undefined, { sensitivity: "accent" }) === 0);
  if (matches.length !== 1) throw new MicrosoftGraphError(matches.length ? "invalid_request" : "not_found");
  return matches[0]!.id;
}

export async function getOutlookMessage(
  userId: string,
  messageId: string,
  deps: OutlookMailDeps = {},
): Promise<OutlookMessage> {
  const request = deps.request ?? microsoftGraphRequest;
  const raw: unknown = await request(userId, {
    capability: "outlook_mail.read",
    path: `/me/messages/${encodeURIComponent(messageId)}`,
    query: { "$select": DETAIL_SELECT },
    headers: { Prefer: 'IdType="ImmutableId", outlook.body-content-type="text"' },
  });
  const message = normalizeOutlookMessage(raw);
  if (!message) throw new MicrosoftGraphError("malformed_provider_response");
  if (!message.hasAttachments) return message;
  const attachmentRaw: unknown = await request(userId, {
    capability: "outlook_mail.read",
    path: `/me/messages/${encodeURIComponent(messageId)}/attachments`,
    query: { "$select": "id,name,contentType,size,isInline" },
  });
  const result = collection(attachmentRaw);
  return { ...message, attachments: result.value.flatMap((item) => normalizeAttachment(item) ?? []) };
}

export async function getOutlookMailboxAddress(
  userId: string,
  deps: OutlookMailDeps = {},
): Promise<string | null> {
  const raw: unknown = await (deps.request ?? microsoftGraphRequest)(userId, {
    capability: "outlook_mail.read",
    path: "/me",
    query: { "$select": "mail,userPrincipalName" },
  });
  const body = obj(raw);
  return email(body?.mail) ?? email(body?.userPrincipalName);
}

function graphAddress(value: string): Record<string, unknown> {
  return { emailAddress: { address: value } };
}

function email(value: unknown): string | null {
  const candidate = text(value)?.toLowerCase();
  return candidate && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidate) ? candidate : null;
}

function emailList(value: unknown): string[] {
  const source = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  return [...new Set(source.flatMap((item) => email(item) ?? []))].slice(0, 50);
}

function requireInputText(input: Record<string, unknown>, key: string, max = 20_000): string {
  const value = text(input[key]);
  if (!value || value.length > max) throw new MicrosoftGraphError("invalid_request");
  return value;
}

async function verifySent(
  userId: string,
  expected: { conversationId: string | null; subject: string; recipients: string[]; startedAt: number },
  deps: OutlookMailDeps,
): Promise<OutlookMessage | null> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) await (deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(attempt * 400);
    const page = await listOutlookMessages(userId, { folder: "sentitems", maxResults: 10, maxPages: 1 }, deps);
    const found = page.items.find((item) => {
      const sentAt = Date.parse(item.sentAt ?? item.createdAt ?? "");
      const recipients = new Set([...item.to, ...item.cc, ...item.bcc].map((recipient) => recipient.address));
      const recipientMatch = expected.recipients.every((recipient) => recipients.has(recipient));
      const identityMatch = expected.conversationId
        ? item.conversationId === expected.conversationId
        : item.subject === expected.subject;
      return identityMatch && recipientMatch && Number.isFinite(sentAt) && sentAt >= expected.startedAt - 60_000;
    });
    if (found) return found;
  }
  return null;
}

async function createDraftForMutation(
  userId: string,
  operation: OutlookMailMutation,
  input: Record<string, unknown>,
  deps: OutlookMailDeps,
): Promise<OutlookMessage> {
  const request = deps.request ?? microsoftGraphRequest;
  const body = text(input.body) ?? "";
  if (operation === "create_draft" || operation === "send") {
    if (!body) throw new MicrosoftGraphError("invalid_request");
    const recipients = emailList(input.to);
    if (!recipients.length) throw new MicrosoftGraphError("invalid_request");
    const completedSubject = completeOutlookSubject({
      body,
      subject: text(input.subject),
    });
    if (!completedSubject) throw new MicrosoftGraphError("invalid_request");
    const raw: unknown = await request(userId, {
      method: "POST",
      capability: "outlook_mail.write",
      path: "/me/messages",
      body: {
        subject: completedSubject.subject,
        body: { contentType: "Text", content: body },
        toRecipients: recipients.map(graphAddress),
        ccRecipients: emailList(input.cc).map(graphAddress),
        bccRecipients: emailList(input.bcc).map(graphAddress),
      },
    });
    const draft = normalizeOutlookMessage(raw);
    if (!draft?.isDraft) throw new MicrosoftGraphError("malformed_provider_response");
    logger.info("outlook.draft created", {
      operation,
      hasDraftId: true,
    });
    return draft;
  }

  const sourceId = requireInputText(input, "sourceMessageId", 1000);
  const action = operation.includes("reply_all") ? "createReplyAll"
    : operation.includes("forward") ? "createForward" : "createReply";
  if (action !== "createForward" && !body) throw new MicrosoftGraphError("invalid_request");
  const forwardRecipients = action === "createForward" ? emailList(input.to) : [];
  if (action === "createForward" && !forwardRecipients.length) throw new MicrosoftGraphError("invalid_request");
  const raw: unknown = await request(userId, {
    method: "POST",
    capability: "outlook_mail.write",
    path: `/me/messages/${encodeURIComponent(sourceId)}/${action}`,
    body: action === "createForward"
      ? { comment: body, toRecipients: forwardRecipients.map(graphAddress) }
      : {},
  });
  const draft = normalizeOutlookMessage(raw);
  if (!draft?.isDraft) throw new MicrosoftGraphError("malformed_provider_response");
  if (action === "createForward") return draft;
  const patch: Record<string, unknown> = { body: { contentType: "Text", content: body } };
  const updatedRaw: unknown = await request(userId, {
    method: "PATCH",
    capability: "outlook_mail.write",
    path: `/me/messages/${encodeURIComponent(draft.id)}`,
    body: patch,
  });
  const updated = normalizeOutlookMessage(updatedRaw);
  if (!updated?.isDraft || updated.id !== draft.id) throw new MicrosoftGraphError("malformed_provider_response");
  return updated;
}

async function getOutlookMessageInFolder(
  userId: string,
  folder: OutlookWellKnownFolder,
  messageId: string,
  deps: OutlookMailDeps,
): Promise<OutlookMessage> {
  const raw: unknown = await (deps.request ?? microsoftGraphRequest)(userId, {
    capability: "outlook_mail.read",
    path: `/me/mailFolders/${folder}/messages/${encodeURIComponent(messageId)}`,
    query: { "$select": DETAIL_SELECT },
    headers: { Prefer: 'IdType="ImmutableId", outlook.body-content-type="text"' },
  });
  const message = normalizeOutlookMessage(raw);
  if (!message || message.id !== messageId) {
    throw new MicrosoftGraphError("malformed_provider_response");
  }
  return message;
}

async function verifyDraftRemovedFromDrafts(
  userId: string,
  draftId: string,
  draftsFolderId: string | null,
  deps: OutlookMailDeps,
): Promise<boolean> {
  for (let attempt = 0; attempt < DELETE_VERIFY_DELAYS_MS.length; attempt += 1) {
    const delay = DELETE_VERIFY_DELAYS_MS[attempt]!;
    if (delay > 0) {
      await (deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(delay);
    }
    try {
      const message = await getOutlookMessage(userId, draftId, deps);
      if (message.id !== draftId) throw new MicrosoftGraphError("malformed_provider_response");
      if (
        draftsFolderId &&
        message.parentFolderId &&
        message.parentFolderId !== draftsFolderId
      ) {
        logger.info("outlook.draft delete verification outcome", {
          outcome: "moved_from_drafts",
          attempt: attempt + 1,
          sameImmutableId: true,
        });
        return true;
      }
      if (!draftsFolderId || !message.parentFolderId) {
        try {
          await getOutlookMessageInFolder(userId, "drafts", draftId, deps);
        } catch (error) {
          if (error instanceof MicrosoftGraphError && error.reason === "not_found") {
            logger.info("outlook.draft delete verification outcome", {
              outcome: "draft_scoped_absent",
              attempt: attempt + 1,
              sameImmutableId: true,
            });
            return true;
          }
          throw error;
        }
      }
      logger.info("outlook.draft delete verification outcome", {
        outcome: "still_in_drafts",
        attempt: attempt + 1,
      });
    } catch (error) {
      if (error instanceof MicrosoftGraphError && error.reason === "not_found") {
        logger.info("outlook.draft delete verification outcome", {
          outcome: "globally_absent",
          attempt: attempt + 1,
        });
        return true;
      }
      logger.info("outlook.draft delete verification outcome", {
        outcome: "failed",
        attempt: attempt + 1,
        errorCode: error instanceof MicrosoftGraphError ? error.reason : "unknown",
      });
      throw error;
    }
  }
  return false;
}

export async function executeOutlookMailMutation(
  userId: string,
  input: Record<string, unknown>,
  deps: OutlookMailDeps = {},
): Promise<OutlookMutationReceipt> {
  const request = deps.request ?? microsoftGraphRequest;
  const operation = text(input.operation) as OutlookMailMutation | null;
  if (!operation) throw new MicrosoftGraphError("invalid_request");

  if (["create_draft", "create_reply_draft", "create_reply_all_draft", "create_forward_draft"].includes(operation)) {
    const draft = await createDraftForMutation(userId, operation, input, deps);
    const authoritative = await getOutlookMessage(userId, draft.id, deps);
    if (!authoritative.isDraft) throw new MicrosoftGraphError("verification_inconclusive");
    if (operation === "create_draft") {
      const expectedSubject = completeOutlookSubject({
        body: requireInputText(input, "body"),
        subject: text(input.subject),
      });
      if (!expectedSubject || authoritative.subject !== expectedSubject.subject) {
        throw new MicrosoftGraphError("verification_inconclusive");
      }
      if (authoritative.body !== requireInputText(input, "body")) {
        throw new MicrosoftGraphError("verification_inconclusive");
      }
      const expectedTo = emailList(input.to);
      const actualTo = new Set(authoritative.to.map((item) => item.address));
      if (!expectedTo.every((address) => actualTo.has(address))) {
        throw new MicrosoftGraphError("verification_inconclusive");
      }
    }
    return { operation, draftId: authoritative.id, messageId: authoritative.id, conversationId: authoritative.conversationId, verification: "verified" };
  }

  if (operation === "update_draft") {
    const draftId = requireInputText(input, "draftId", 1000);
    const patch: Record<string, unknown> = { body: { contentType: "Text", content: requireInputText(input, "body") } };
    if (text(input.subject)) patch.subject = requireInputText(input, "subject", 998);
    if (emailList(input.to).length) patch.toRecipients = emailList(input.to).map(graphAddress);
    const raw: unknown = await request(userId, { method: "PATCH", capability: "outlook_mail.write", path: `/me/messages/${encodeURIComponent(draftId)}`, body: patch });
    const updated = normalizeOutlookMessage(raw);
    if (!updated?.isDraft || updated.id !== draftId) throw new MicrosoftGraphError("verification_inconclusive");
    const authoritative = await getOutlookMessage(userId, draftId, deps);
    if (!authoritative.isDraft || authoritative.id !== draftId) throw new MicrosoftGraphError("verification_inconclusive");
    if (authoritative.body !== requireInputText(input, "body")) throw new MicrosoftGraphError("verification_inconclusive");
    if (text(input.subject) && authoritative.subject !== requireInputText(input, "subject", 998)) {
      throw new MicrosoftGraphError("verification_inconclusive");
    }
    const expectedTo = emailList(input.to);
    if (expectedTo.length) {
      const actualTo = new Set(authoritative.to.map((item) => item.address));
      if (!expectedTo.every((address) => actualTo.has(address))) throw new MicrosoftGraphError("verification_inconclusive");
    }
    return { operation, draftId, messageId: draftId, conversationId: authoritative.conversationId, verification: "verified" };
  }

  if (operation === "delete_draft") {
    const draftId = requireInputText(input, "draftId", 1000);
    const existing = await getOutlookMessageInFolder(userId, "drafts", draftId, deps);
    if (!existing.isDraft || existing.id !== draftId) throw new MicrosoftGraphError("invalid_request");
    logger.info("outlook.draft delete started", {
      hasDraftId: true,
    });
    await request(userId, { method: "DELETE", capability: "outlook_mail.write", path: `/me/messages/${encodeURIComponent(draftId)}`, responseKind: "empty" });
    logger.info("outlook.draft delete provider response", {
      outcome: "accepted",
    });
    if (!await verifyDraftRemovedFromDrafts(userId, draftId, existing.parentFolderId, deps)) {
      throw new MicrosoftGraphError("verification_inconclusive");
    }
    return { operation, draftId, messageId: draftId, conversationId: existing.conversationId, verification: "verified" };
  }

  if (operation === "mark_read" || operation === "mark_unread") {
    const messageId = requireInputText(input, "messageId", 1000);
    const expected = operation === "mark_read";
    await request(userId, { method: "PATCH", capability: "outlook_mail.write", path: `/me/messages/${encodeURIComponent(messageId)}`, body: { isRead: expected } });
    const verified = await getOutlookMessage(userId, messageId, deps);
    if (verified.isRead !== expected) throw new MicrosoftGraphError("verification_inconclusive");
    return { operation, draftId: null, messageId, conversationId: verified.conversationId, verification: "verified", isRead: verified.isRead };
  }

  const startedAt = Date.now();
  let draft: OutlookMessage;
  if (operation === "send_draft") {
    const draftId = requireInputText(input, "draftId", 1000);
    draft = await getOutlookMessage(userId, draftId, deps);
    if (!draft.isDraft) throw new MicrosoftGraphError("invalid_request");
  } else {
    draft = await createDraftForMutation(userId, operation, input, deps);
  }
  const recipients = [...draft.to, ...draft.cc, ...draft.bcc].map((item) => item.address);
  await request(userId, {
    method: "POST",
    capability: "outlook_mail.send",
    path: `/me/messages/${encodeURIComponent(draft.id)}/send`,
    responseKind: "empty",
  });
  const sent = await verifySent(userId, {
    conversationId: draft.conversationId,
    subject: draft.subject,
    recipients,
    startedAt,
  }, deps);
  return {
    operation,
    draftId: draft.id,
    messageId: sent?.id ?? null,
    conversationId: sent?.conversationId ?? draft.conversationId,
    verification: sent ? "verified" : "accepted",
  };
}

export function authoritativeReplyRecipients(
  message: OutlookMessage,
  currentUserAddress: string | null,
  replyAll: boolean,
): OutlookAddress[] {
  const own = currentUserAddress?.toLowerCase() ?? null;
  const source = message.replyTo.length ? message.replyTo : message.from ? [message.from] : [];
  const candidates = replyAll ? [...source, ...message.to, ...message.cc] : source;
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    if (candidate.address === own || seen.has(candidate.address)) return false;
    seen.add(candidate.address);
    return true;
  });
}
