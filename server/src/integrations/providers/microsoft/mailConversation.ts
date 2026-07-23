import { executeAction, type ActionExecutionResult } from "../../../actions/executor";
import { loadGroundedContexts } from "../../../actions/entityContextArbiter";
import {
  createActionProposal,
  getActiveProposal,
  supersedeProposal,
  type ActionProposalView,
  type CreateProposalInput,
} from "../../../actions/proposals";
import { getUserTimezone } from "../../../reminders/reminders";
import { logger } from "../../../utils/logger";
import { getGmailConnection } from "../gmail/client";
import { getMicrosoftConnection } from "./client";
import { MicrosoftGraphError } from "./graph";
import {
  loadGroundedOutlookEntity,
  loadOutlookEntity,
  loadOutlookSelection,
  parseOutlookOrdinal,
  recordOutlookEntity,
  recordOutlookSelection,
  resolveOutlookReference,
  type OutlookContextStore,
  type OutlookMessageRef,
} from "./mailContext";
import {
  analyzeOutlookMessages,
  formatOutlookAnalysis,
  type OutlookAnalysisGenerator,
} from "./mailIntelligence";
import {
  completeOutlookSubject,
  type CompletedOutlookSubject,
} from "./mailComposition";
import {
  explicitMailProvider,
  explicitOutlookIntent,
  extractOutlookIntent,
  OutlookIntentSchema,
  shouldConsiderMail,
  type OutlookIntent,
  type OutlookIntentGenerator,
} from "./mailIntent";
import {
  consumePendingOutlookMailIntent,
  createPendingOutlookMailIntent,
  expirePendingOutlookMailIntent,
  loadPendingOutlookMailIntent,
  updatePendingOutlookMailIntent,
  type OutlookMailMissingField,
  type PendingOutlookMailIntent,
  type PendingOutlookMailIntentData,
} from "./mailClarification";
import {
  isOutlookProposalRevision,
  mayRevisePendingMailProposal,
  parsePendingMailProposal,
  revisedOutlookOperation,
  type PendingMailProposalSlots,
} from "./mailProposalRevision";
import type { OutlookModelDiagnostic } from "./mailModelFailure";
import {
  authoritativeReplyRecipients,
  getOutlookMailboxAddress,
  getOutlookMessage,
  listOutlookFolders,
  listOutlookMessages,
  resolveOutlookFolder,
  type OutlookMailDeps,
} from "./mailOperations";
import type { OutlookMessage, OutlookMessageQuery } from "./mailTypes";

export interface OutlookConversationResult {
  handled: boolean;
  reply?: string;
  routeSource?: string;
}

interface ConnectionState {
  connected: boolean;
  accountEmail?: string | null;
}

export interface OutlookConversationDeps extends OutlookMailDeps, OutlookContextStore {
  arbitrated?: boolean;
  extract?: typeof extractOutlookIntent;
  generateIntent?: OutlookIntentGenerator;
  generateAnalysis?: OutlookAnalysisGenerator;
  getMicrosoftState?: (userId: string) => Promise<ConnectionState>;
  getGmailState?: (userId: string) => Promise<ConnectionState>;
  getContexts?: typeof loadGroundedContexts;
  getTimezone?: typeof getUserTimezone;
  list?: typeof listOutlookMessages;
  folders?: typeof listOutlookFolders;
  get?: typeof getOutlookMessage;
  resolveFolder?: typeof resolveOutlookFolder;
  mailboxAddress?: typeof getOutlookMailboxAddress;
  analyze?: typeof analyzeOutlookMessages;
  execute?: typeof executeAction;
  propose?: (userId: string, input: CreateProposalInput) => Promise<unknown>;
  getActiveProposal?: typeof getActiveProposal;
  supersedeProposal?: typeof supersedeProposal;
  loadPendingIntent?: typeof loadPendingOutlookMailIntent;
  createPendingIntent?: typeof createPendingOutlookMailIntent;
  updatePendingIntent?: typeof updatePendingOutlookMailIntent;
  consumePendingIntent?: typeof consumePendingOutlookMailIntent;
  expirePendingIntent?: typeof expirePendingOutlookMailIntent;
  now?: Date;
}

async function microsoftState(userId: string): Promise<ConnectionState> {
  const connection = await getMicrosoftConnection(userId);
  return {
    connected: connection?.status === "connected" && connection.capabilities.includes("outlook_mail.read"),
    accountEmail: connection?.providerAccountEmail ?? null,
  };
}

async function gmailState(userId: string): Promise<ConnectionState> {
  const connection = await getGmailConnection(userId);
  return { connected: connection?.status === "connected" };
}

type MailOwner = "outlook" | "gmail" | "ambiguous" | "none";

async function resolveMailOwner(
  userId: string,
  text: string,
  deps: OutlookConversationDeps,
): Promise<MailOwner> {
  const explicit = explicitMailProvider(text);
  const microsoft = await (deps.getMicrosoftState ?? microsoftState)(userId);
  const gmail = await (deps.getGmailState ?? gmailState)(userId);
  if (explicit === "outlook") return microsoft.connected ? "outlook" : "none";
  if (explicit === "gmail") return "gmail";
  if (deps.arbitrated) return "outlook";

  const contexts = await (deps.getContexts ?? loadGroundedContexts)(userId);
  const mailContext = contexts.find((context) =>
    context.kind === "outlook_message" ||
    context.kind === "outlook_draft" ||
    context.kind === "gmail_email" ||
    context.kind === "gmail_draft");
  if (mailContext?.kind === "outlook_message" || mailContext?.kind === "outlook_draft") return "outlook";
  if (mailContext?.kind === "gmail_email" || mailContext?.kind === "gmail_draft") return "gmail";
  if (microsoft.connected && gmail.connected) return "ambiguous";
  if (microsoft.connected) return "outlook";
  if (gmail.connected) return "gmail";
  return "none";
}

function displayAddress(message: OutlookMessage): string {
  const address = message.sender ?? message.from;
  if (!address) return "Unknown sender";
  return address.name ? `${address.name} <${address.address}>` : address.address;
}

function displayTime(value: string | null, timezone: string | undefined): string {
  if (!value) return "time unavailable";
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone ?? "UTC",
      day: "numeric",
      month: "short",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(value));
  } catch {
    return new Date(value).toISOString();
  }
}

export function formatOutlookList(
  messages: OutlookMessage[],
  timezone?: string,
  hasMore = false,
): string {
  if (!messages.length) return "I couldn’t find any matching Outlook messages in the bounded search.";
  const lines = messages.map((message, index) => {
    const state = message.isRead ? "" : " — unread";
    return `${index + 1}. ${displayAddress(message)} — ${message.subject} — ${displayTime(message.receivedAt ?? message.sentAt, timezone)}${state}`;
  });
  const header = hasMore
    ? `I’m showing the first ${messages.length} matching Outlook messages:`
    : `I found ${messages.length} matching Outlook message${messages.length === 1 ? "" : "s"}:`;
  return [header, ...lines].join("\n");
}

function formatDetail(message: OutlookMessage, timezone?: string): string {
  const recipients = message.to.map((item) => item.address).join(", ") || "none shown";
  const body = message.body || message.preview || "(No readable message body.)";
  const attachments = message.attachments.length
    ? `\nAttachments (metadata only): ${message.attachments.map((item) => `${item.name} — ${item.contentType ?? "unknown type"}, ${item.size} bytes`).join("; ")}`
    : "\nAttachments: none";
  return [
    `From: ${displayAddress(message)}`,
    `To: ${recipients}`,
    `Subject: ${message.subject}`,
    `Received: ${displayTime(message.receivedAt ?? message.sentAt, timezone)}`,
    `State: ${message.isRead ? "read" : "unread"}`,
    "",
    body,
    attachments,
  ].join("\n");
}

function graphReply(error: MicrosoftGraphError): string {
  if (error.reason === "not_connected") return "Connect Microsoft 365 in Hula first, then I can check Outlook.";
  if (error.reason === "reconnect_required") return "Your Microsoft 365 connection needs to be reconnected in Hula.";
  if (error.reason === "insufficient_capability" || error.reason === "permission_denied") return "Reconnect Microsoft 365 and grant Outlook Mail access before I can do that.";
  if (error.reason === "not_found") return "That Outlook message is no longer available. Ask me to find it again.";
  if (error.reason === "rate_limited") return "Outlook is rate-limiting requests right now. Please try again shortly.";
  if (error.reason === "timeout") return "Outlook took too long to respond, so I haven’t made up an answer. Please try again.";
  return "I couldn’t retrieve that reliably from Outlook just now.";
}

function queryFromIntent(intent: OutlookIntent): OutlookMessageQuery {
  return {
    query: intent.query ?? undefined,
    sender: intent.sender ?? undefined,
    subject: intent.subject ?? undefined,
    folder: intent.folder ?? undefined,
    unread: intent.unread ?? undefined,
    receivedAfter: intent.receivedAfter ?? undefined,
    receivedBefore: intent.receivedBefore ?? undefined,
    maxResults: intent.count ?? 10,
  };
}

async function authoritativeRef(
  userId: string,
  ref: OutlookMessageRef,
  deps: OutlookConversationDeps,
): Promise<OutlookMessage> {
  return (deps.get ?? getOutlookMessage)(userId, ref.id, deps);
}

/**
 * Resolve a reference to usable evidence. Semantic follow-ups prefer the bounded
 * normalized snapshot already grounded in conversation; explicit freshness and
 * missing/legacy snapshots still read authoritative provider state.
 */
async function evidenceForRef(
  userId: string,
  ref: OutlookMessageRef,
  deps: OutlookConversationDeps,
  requiresFresh = false,
): Promise<OutlookMessage> {
  if (!requiresFresh) {
    const grounded = await loadGroundedOutlookEntity(userId, ref.itemKind, deps, ref.id);
    if (grounded?.message) return grounded.message;
  }
  return authoritativeRef(userId, ref, deps);
}

async function resolveTarget(
  userId: string,
  text: string,
  intent: OutlookIntent,
  deps: OutlookConversationDeps,
  itemKind: "message" | "draft" | "either" = "message",
  requiresFresh = false,
): Promise<{ message: OutlookMessage | null; reply?: string }> {
  const hasNamedCriteria = Boolean(intent.sender || intent.subject || intent.query);
  if (!hasNamedCriteria || intent.ordinal) {
    const ref = await resolveOutlookReference(userId, text, intent.ordinal, itemKind, deps);
    if (ref) return { message: await evidenceForRef(userId, ref, deps, requiresFresh) };
  }
  if (hasNamedCriteria) {
    const page = await (deps.list ?? listOutlookMessages)(userId, {
      ...queryFromIntent(intent),
      folder: itemKind === "draft" ? "drafts" : intent.folder ?? "inbox",
      maxResults: 10,
    }, deps);
    if (page.items.length === 1) return { message: await (deps.get ?? getOutlookMessage)(userId, page.items[0]!.id, deps) };
    if (page.items.length > 1) {
      await recordOutlookSelection(userId, page.items, deps);
      const timezone = await (deps.getTimezone ?? getUserTimezone)(userId);
      return { message: null, reply: `${formatOutlookList(page.items, timezone, page.hasMore)}\nWhich one do you mean?` };
    }
    return { message: null, reply: "I couldn’t find a matching Outlook message." };
  }
  return { message: null, reply: `Which Outlook ${itemKind === "draft" ? "draft" : "message"} do you mean? Ask me to find it first.` };
}

function emails(value: string[] | null | undefined): string[] {
  return [...new Set((value ?? []).map((item) => item.toLowerCase()))];
}

function previewBody(body: string): string {
  const clean = body.replace(/\s+/g, " ").trim();
  return clean.length > 600 ? `${clean.slice(0, 597)}…` : clean;
}

async function safeMailboxAddress(userId: string, deps: OutlookConversationDeps): Promise<string | null> {
  try {
    const state = await (deps.getMicrosoftState ?? microsoftState)(userId);
    if (state.accountEmail) return state.accountEmail.toLowerCase();
    return await (deps.mailboxAddress ?? getOutlookMailboxAddress)(userId, deps);
  } catch {
    return null;
  }
}

async function runImmediate(
  userId: string,
  actionId: string,
  input: Record<string, unknown>,
  deps: OutlookConversationDeps,
): Promise<ActionExecutionResult> {
  return (deps.execute ?? executeAction)(userId, actionId, { input });
}

async function rememberReceipt(userId: string, result: ActionExecutionResult, deps: OutlookConversationDeps): Promise<void> {
  const id = result.receipt?.messageId ?? result.receipt?.draftId;
  if (!result.ok || !id) return;
  try {
    const message = await (deps.get ?? getOutlookMessage)(userId, id, deps);
    await recordOutlookEntity(userId, message, deps);
  } catch {
    // A provider mutation receipt remains authoritative even if optional context persistence fails.
  }
}

function completedNewMessageSubject(
  body: string,
  intentSubject: string | null | undefined,
  intentSubjectSource: OutlookIntent["draftSubjectSource"],
): CompletedOutlookSubject | null {
  return completeOutlookSubject({
    body,
    subject: intentSubject,
    subjectWasExplicit: intentSubjectSource === "explicit",
  });
}

async function handleWrite(
  userId: string,
  text: string,
  intent: OutlookIntent,
  deps: OutlookConversationDeps,
  boundRef: OutlookMessageRef | null = null,
): Promise<OutlookConversationResult> {
  const targetFor = async (
    itemKind: "message" | "draft" | "either",
    requiresFresh = false,
  ): Promise<{ message: OutlookMessage | null; reply?: string }> => {
    if (boundRef && (itemKind === "either" || boundRef.itemKind === itemKind)) {
      return { message: await authoritativeRef(userId, boundRef, deps) };
    }
    return resolveTarget(userId, text, intent, deps, itemKind, requiresFresh);
  };
  const operation = intent.operation;
  if (operation === "mark_read" || operation === "mark_unread") {
    const target = await targetFor("message");
    if (!target.message) return { handled: true, reply: target.reply };
    const result = await runImmediate(userId, "microsoft.mail.setReadState", {
      operation,
      messageId: target.message.id,
    }, deps);
    if (result.ok) {
      const verified = await (deps.get ?? getOutlookMessage)(userId, target.message.id, deps);
      await recordOutlookEntity(userId, verified, deps);
    }
    return { handled: true, reply: result.userMessage };
  }

  if (operation === "update_draft") {
    const target = await targetFor("draft", true);
    if (!target.message) return { handled: true, reply: target.reply };
    if (!intent.draftBody) return { handled: true, reply: "What should the updated Outlook draft say?" };
    const result = await runImmediate(userId, "microsoft.mail.updateDraft", {
      operation,
      draftId: target.message.id,
      body: intent.draftBody,
      ...(intent.draftSubject ? { subject: intent.draftSubject } : {}),
      ...(intent.to?.length ? { to: intent.to } : {}),
    }, deps);
    await rememberReceipt(userId, result, deps);
    return { handled: true, reply: result.userMessage };
  }

  if (operation === "delete_draft") {
    const target = await targetFor("draft", true);
    if (!target.message) return { handled: true, reply: target.reply };
    const preview = `Delete this unsent Outlook draft?\nTo: ${target.message.to.map((item) => item.address).join(", ") || "No recipient"}\nSubject: ${target.message.subject}`;
    const pending = await (deps.getActiveProposal ?? getActiveProposal)(userId);
    if (pending) return { handled: true, reply: `I’m already waiting for confirmation on another action:\n${pending.previewText}\nReply Yes to confirm or No to cancel.` };
    await (deps.propose ?? createActionProposal)(userId, {
      provider: "microsoft",
      actionId: "microsoft.mail.deleteDraft",
      riskLevel: "write",
      confirmationRequired: true,
      input: { operation, draftId: target.message.id },
      previewText: preview,
    });
    return { handled: true, reply: `${preview}\nReply Yes to confirm or No to cancel.` };
  }

  const draftOnly = new Set(["create_draft", "create_reply_draft", "create_reply_all_draft", "create_forward_draft"]);
  const replyLike = new Set(["create_reply_draft", "create_reply_all_draft", "reply", "reply_all"]);
  const forwardLike = new Set(["create_forward_draft", "forward"]);
  let source: OutlookMessage | null = null;
  if (replyLike.has(operation) || forwardLike.has(operation)) {
    const target = await targetFor("message");
    if (!target.message) return { handled: true, reply: target.reply };
    source = target.message;
  }
  let draft: OutlookMessage | null = null;
  if (operation === "send_draft") {
    const target = await targetFor("draft", true);
    if (!target.message) return { handled: true, reply: target.reply };
    draft = target.message;
  }
  const body = intent.draftBody ?? (draft?.body || (forwardLike.has(operation) ? "" : null));
  if (body === null) return { handled: true, reply: "What should the Outlook message say?" };

  let currentAddress = source ? await safeMailboxAddress(userId, deps) : null;
  if (source && operation.includes("reply_all") && !currentAddress) {
    return { handled: true, reply: "I couldn’t verify your Outlook mailbox address, so I haven’t prepared a reply-all that might include the wrong recipients." };
  }
  const authoritative = source && replyLike.has(operation)
    ? authoritativeReplyRecipients(source, currentAddress, operation.includes("reply_all"))
    : [];
  const to = authoritative.length
    ? authoritative.map((item) => item.address)
    : draft
      ? draft.to.map((item) => item.address)
      : emails(intent.to);
  if (!to.length) {
    return { handled: true, reply: "What is the recipient’s exact email address? I won’t guess an address from a name." };
  }
  if (!currentAddress && !draftOnly.has(operation)) {
    currentAddress = await safeMailboxAddress(userId, deps);
  }
  let subject = source?.subject ?? draft?.subject ?? intent.draftSubject ?? null;
  if (!source && !draft && (operation === "create_draft" || operation === "send")) {
    const completed = completedNewMessageSubject(body, subject, intent.draftSubjectSource);
    subject = completed?.subject ?? null;
    logger.info("outlook.mail subject completed", {
      source: completed?.source ?? "none",
      operation,
    });
  }
  const mutationInput: Record<string, unknown> = {
    operation,
    to,
    body,
    ...(subject ? { subject } : {}),
    ...(source ? { sourceMessageId: source.id } : {}),
    ...(draft ? { draftId: draft.id } : {}),
    ...(intent.cc?.length ? { cc: intent.cc } : {}),
    ...(intent.bcc?.length ? { bcc: intent.bcc } : {}),
  };

  if (draftOnly.has(operation)) {
    const result = await runImmediate(userId, "microsoft.mail.createDraft", mutationInput, deps);
    await rememberReceipt(userId, result, deps);
    return { handled: true, reply: result.userMessage };
  }

  const kind = operation === "reply_all" ? "Reply all" : operation === "reply" ? "Reply" : operation === "forward" ? "Forward" : "Send";
  const preview = [
    `${kind} from your Outlook account?`,
    `From: ${currentAddress ?? "your connected Outlook account"}`,
    `To: ${to.join(", ")}`,
    ...(subject ? [`Subject: ${subject}`] : []),
    `Message: ${previewBody(body)}`,
  ].join("\n");
  const pending = await (deps.getActiveProposal ?? getActiveProposal)(userId);
  if (pending) return { handled: true, reply: `I’m already waiting for confirmation on another action:\n${pending.previewText}\nReply Yes to confirm or No to cancel.` };
  await (deps.propose ?? createActionProposal)(userId, {
    provider: "microsoft",
    actionId: "microsoft.mail.send",
    riskLevel: "send",
    confirmationRequired: true,
    input: mutationInput,
    previewText: preview,
  });
  return { handled: true, reply: `${preview}\nReply Yes to confirm or No to cancel.` };
}

function revisionPreview(
  currentAddress: string | null,
  to: string[],
  subject: string,
  body: string,
): string {
  return [
    "Send from your Outlook account?",
    `From: ${currentAddress ?? "your connected Outlook account"}`,
    `To: ${to.join(", ")}`,
    `Subject: ${subject}`,
    `Message: ${previewBody(body)}`,
  ].join("\n");
}

function revisionMutationInput(
  pending: PendingMailProposalSlots,
  operation: NonNullable<ReturnType<typeof revisedOutlookOperation>>,
  subject: string,
): Record<string, unknown> {
  return {
    operation,
    to: pending.to,
    body: pending.body,
    subject,
    ...(pending.cc.length ? { cc: pending.cc } : {}),
    ...(pending.bcc.length ? { bcc: pending.bcc } : {}),
    ...(pending.sourceMessageId ? { sourceMessageId: pending.sourceMessageId } : {}),
    ...(pending.draftId ? { draftId: pending.draftId } : {}),
  };
}

function looksLikeSelfContainedMailRequest(text: string): boolean {
  return (
    /\b[^\s@]+@[^\s@]+\.[^\s@]+\b/i.test(text) ||
    /\b(?:draft|compose|prepare|write|email)\b[^.!?]{0,180}\b(?:saying|subject|message|body|tell(?:ing)?)\b/i.test(text)
  );
}

/**
 * Revision lane for a fresh confirmable mail proposal.
 *
 * It runs before normal yes/no confirmation. The old proposal is retired with an
 * atomic proposed→cancelled transition before any replacement draft/proposal can
 * be created, so a delayed Yes can never execute the old send.
 */
export async function handleOutlookMailProposalRevision(
  userId: string,
  text: string | undefined,
  deps: OutlookConversationDeps = {},
): Promise<OutlookConversationResult> {
  const value = (text ?? "").trim();
  if (!mayRevisePendingMailProposal(value)) return { handled: false };

  let active: ActionProposalView | null;
  try {
    active = await (deps.getActiveProposal ?? getActiveProposal)(userId);
  } catch {
    return { handled: false };
  }
  if (!active) return { handled: false };
  const pending = parsePendingMailProposal(active, deps.now);
  if (!pending) return { handled: false };

  const explicitProvider = explicitMailProvider(value);
  if (explicitProvider === "gmail") return { handled: false };
  if (pending.provider === "gmail" && explicitProvider !== "outlook") return { handled: false };

  let semantic: OutlookIntent | null;
  try {
    semantic = await (deps.extract ?? extractOutlookIntent)({
      text: value,
      now: deps.now,
      hasContext: true,
      pendingMailOperation: pending.operation,
      pendingMailProvider: pending.provider,
      generate: deps.generateIntent,
      onDiagnostic: logModelDiagnostic,
    });
  } catch {
    semantic = null;
  }
  if (!semantic || semantic.operation === "not_mail") {
    if (
      !looksLikeSelfContainedMailRequest(value) &&
      (/\b(?:draft|unsent)\b|\b(?:do\s+not|don[’']?t)\s+send\b/i.test(value))
    ) {
      semantic = OutlookIntentSchema.parse({
        provider: "outlook",
        operation: "create_draft",
        proposalRevision: true,
      });
    } else {
      return { handled: false };
    }
  }
  if (explicitProvider === "outlook") semantic = { ...semantic, provider: "outlook" };
  if (!isOutlookProposalRevision(value, semantic, pending)) return { handled: false };
  const operation = revisedOutlookOperation(pending, semantic);
  if (!operation) return { handled: false };

  const completed = completeOutlookSubject({
    body: pending.body,
    subject: pending.subject,
  });
  if (!completed) {
    return { handled: true, reply: "What subject should I use for the Outlook message?" };
  }

  const supersede = deps.supersedeProposal ?? supersedeProposal;
  const claimed = await supersede(userId, pending.proposalId);
  if (!claimed) {
    return { handled: true, reply: "That email proposal was already handled, so I haven’t created or sent anything else." };
  }
  logger.info("outlook.mail proposal superseded", {
    previousProvider: pending.provider,
    previousOperation: pending.operation,
    nextProvider: "outlook",
    nextOperation: operation,
  });
  logger.info("outlook.mail subject completed", {
    source: completed.source,
    operation,
  });

  const mutationInput = revisionMutationInput(pending, operation, completed.subject);
  if (operation !== "send") {
    const result = await runImmediate(userId, "microsoft.mail.createDraft", mutationInput, deps);
    await rememberReceipt(userId, result, deps);
    logger.info("outlook.mail operation revised", {
      previousOperation: pending.operation,
      nextOperation: operation,
      outcome: result.ok ? "draft_created" : "draft_failed",
    });
    return { handled: true, reply: result.userMessage };
  }

  const currentAddress = await safeMailboxAddress(userId, deps);
  const preview = revisionPreview(
    currentAddress,
    pending.to,
    completed.subject,
    pending.body,
  );
  await (deps.propose ?? createActionProposal)(userId, {
    provider: "microsoft",
    actionId: "microsoft.mail.send",
    riskLevel: "send",
    confirmationRequired: true,
    input: mutationInput,
    previewText: preview,
  });
  logger.info("outlook.mail operation revised", {
    previousOperation: pending.operation,
    nextOperation: operation,
    outcome: "proposal_replaced",
  });
  return { handled: true, reply: `${preview}\nReply Yes to confirm or No to cancel.` };
}

const WRITE_OPS = new Set<OutlookIntent["operation"]>([
  "create_draft", "create_reply_draft", "create_reply_all_draft", "create_forward_draft",
  "update_draft", "delete_draft", "send", "reply", "reply_all", "forward", "send_draft",
  "mark_read", "mark_unread",
]);

const NEW_MESSAGE_OPS = new Set<OutlookIntent["operation"]>(["create_draft", "send"]);
const TARGET_MESSAGE_OPS = new Set<OutlookIntent["operation"]>([
  "create_reply_draft", "create_reply_all_draft", "create_forward_draft",
  "reply", "reply_all", "forward", "mark_read", "mark_unread",
]);
const TARGET_DRAFT_OPS = new Set<OutlookIntent["operation"]>([
  "update_draft", "delete_draft", "send_draft",
]);

function explicitWriteOperation(text: string): OutlookIntent["operation"] | null {
  const value = text.toLowerCase();
  const doNotSend = /\b(?:do\s+not|don[’']?t|not\s+yet|without)\s+send(?:ing)?\b|\bleave\s+(?:it\s+)?(?:as\s+)?a?\s*draft\b|\b(?:save|keep)\s+(?:it\s+)?(?:as\s+)?a?\s*draft\b/.test(value);
  if (/\breply\s+all\b/.test(value)) return doNotSend || /\bdraft|compose|prepare\b/.test(value) ? "create_reply_all_draft" : "reply_all";
  if (/\b(?:reply|respond|write\s+back)\b/.test(value)) return doNotSend || /\bdraft|compose|prepare\b/.test(value) ? "create_reply_draft" : "reply";
  if (/\bforward\b|\bpass\s+(?:it|this|that)\s+(?:on|along)\b/.test(value)) return doNotSend || /\bdraft|compose|prepare\b/.test(value) ? "create_forward_draft" : "forward";
  if (/\b(?:mark|make|keep)\b[^.!?]{0,60}\bunread\b/.test(value)) return "mark_unread";
  if (/\b(?:mark|make|keep)\b[^.!?]{0,60}\bread\b|\bi(?:'ve| have)\s+(?:read|seen)\b/.test(value)) return "mark_read";
  if (/\b(?:delete|remove|discard)\b[^.!?]{0,80}\bdraft\b/.test(value)) return "delete_draft";
  if (/\b(?:edit|update|change)\b[^.!?]{0,80}\bdraft\b/.test(value)) return "update_draft";
  if (/\bsend\b[^.!?]{0,50}\b(?:the|that|this)\s+draft\b/.test(value)) return "send_draft";
  if (doNotSend || /\bdraft\b|\bcompose\b|\bprepare\b/.test(value)) return "create_draft";
  if (/\b(?:send|email|shoot|fire\s+off)\b/.test(value)) return "send";
  return null;
}

function literalEmails(text: string): string[] {
  const matches = text.match(/\b[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi) ?? [];
  return [...new Set(matches.map((value) => value.toLowerCase()))].slice(0, 50);
}

function hasTargetReference(intent: OutlookIntent, entityRef: OutlookMessageRef | null): boolean {
  return Boolean(entityRef || intent.ordinal || intent.sender || intent.subject || intent.query);
}

function missingWriteFields(
  intent: OutlookIntent,
  entityRef: OutlookMessageRef | null,
  requireOperation = false,
): OutlookMailMissingField[] {
  const missing: OutlookMailMissingField[] = [];
  if (intent.provider === "unknown") missing.push("provider");
  if (requireOperation) missing.push("operation");
  if (NEW_MESSAGE_OPS.has(intent.operation)) {
    if (!intent.to?.length) missing.push("to");
    if (!intent.draftBody) missing.push("body");
  } else if (intent.operation === "update_draft") {
    if (!intent.draftBody) missing.push("body");
    if (!hasTargetReference(intent, entityRef)) missing.push("target");
  } else if (intent.operation === "create_reply_draft" || intent.operation === "create_reply_all_draft" || intent.operation === "reply" || intent.operation === "reply_all") {
    if (!intent.draftBody) missing.push("body");
    if (!hasTargetReference(intent, entityRef)) missing.push("target");
  } else if (intent.operation === "create_forward_draft" || intent.operation === "forward") {
    if (!intent.to?.length) missing.push("to");
    if (!hasTargetReference(intent, entityRef)) missing.push("target");
  } else if ((TARGET_MESSAGE_OPS.has(intent.operation) || TARGET_DRAFT_OPS.has(intent.operation)) && !hasTargetReference(intent, entityRef)) {
    missing.push("target");
  }
  return [...new Set(missing)];
}

function clarificationPrompt(missing: readonly OutlookMailMissingField[]): string {
  if (missing.includes("provider") && missing.includes("operation")) {
    return "Should I use Gmail or Outlook, and should I leave it as a draft or prepare it to send?";
  }
  if (missing.includes("provider")) return "Should I use Gmail or Outlook?";
  if (missing.includes("operation")) return "Should I leave it as an Outlook draft or prepare it to send?";
  if (missing.includes("to")) return "What is the recipient’s exact email address? I won’t guess it from a name.";
  if (missing.includes("body")) return "What should the Outlook message say?";
  if (missing.includes("subject")) return "What subject should I use?";
  return "Which Outlook message or draft do you mean?";
}

function isStandaloneMailRequest(text: string): boolean {
  return Boolean(
    explicitWriteOperation(text) &&
    literalEmails(text).length &&
    /\b(?:saying|say|message|body|subject|tell(?:ing)?|that)\b|[“"][^”"]+[”"]/i.test(text),
  );
}

function isUnrelatedClarificationTurn(text: string): boolean {
  return /\b(?:calendar|meeting|event|one\s*drive|google\s+drive|slack|todoist|asana|notion|remind(?:er)?|memory)\b/i.test(text);
}

function shouldApplyPendingIntent(text: string, pending: PendingOutlookMailIntentData): boolean {
  if (!text.trim() || isStandaloneMailRequest(text) || isUnrelatedClarificationTurn(text)) return false;
  const explicitProvider = explicitMailProvider(text);
  const operation = explicitWriteOperation(text);
  if (pending.missingFields.includes("provider") && explicitProvider) return true;
  if (pending.missingFields.includes("operation") && operation) return true;
  if (pending.missingFields.includes("to") && literalEmails(text).length > 0) return true;
  if (pending.missingFields.includes("body") && !explicitProvider && !operation) return true;
  if (pending.missingFields.includes("subject") && !explicitProvider && !operation) return true;
  return Boolean(explicitProvider && operation);
}

function mergeIntentSlots(
  pending: PendingOutlookMailIntentData,
  clarification: OutlookIntent | null,
  text: string,
): OutlookIntent {
  const previous = pending.intent;
  const explicitProvider = explicitMailProvider(text);
  const explicitOperation = explicitWriteOperation(text);
  const clarifiedProvider = clarification?.provider === "outlook" || clarification?.provider === "gmail"
    ? clarification.provider
    : null;
  const clarifiedOperation = clarification && WRITE_OPS.has(clarification.operation)
    ? clarification.operation
    : null;
  const merged: OutlookIntent = {
    ...previous,
    provider: explicitProvider ?? clarifiedProvider ?? previous.provider,
    operation: explicitOperation ?? clarifiedOperation ?? previous.operation,
  };
  const fillUnresolvedSlot = <K extends keyof OutlookIntent>(key: K): void => {
    const existing = previous[key];
    const resolved = Array.isArray(existing) ? existing.length > 0 : existing !== null && existing !== undefined;
    if (resolved) return;
    const next = clarification?.[key];
    if (next !== null && next !== undefined) merged[key] = next as OutlookIntent[K];
  };
  for (const key of ["to", "cc", "bcc", "draftBody", "draftSubject", "ordinal", "query", "sender", "subject"] as const) {
    fillUnresolvedSlot(key);
  }
  if (pending.missingFields.includes("to") && !merged.to?.length) {
    const addresses = literalEmails(text);
    if (addresses.length) merged.to = addresses;
  }
  if (pending.missingFields.includes("body") && !merged.draftBody && !explicitProvider && !explicitOperation) {
    const body = text.trim();
    if (body) merged.draftBody = body;
  }
  if (pending.missingFields.includes("subject") && !merged.draftSubject && !explicitProvider && !explicitOperation) {
    const subject = text.trim();
    if (subject) merged.draftSubject = subject;
  }
  return OutlookIntentSchema.parse(merged);
}

async function savePendingIntent(
  userId: string,
  intent: OutlookIntent,
  missingFields: OutlookMailMissingField[],
  ambiguityReason: string,
  entityRef: OutlookMessageRef | null,
  deps: OutlookConversationDeps,
): Promise<void> {
  await (deps.createPendingIntent ?? createPendingOutlookMailIntent)(userId, {
    intent,
    missingFields,
    ambiguityReason,
    entityRef,
  });
}

async function resolvePendingIntent(
  userId: string,
  text: string,
  pending: PendingOutlookMailIntent,
  deps: OutlookConversationDeps,
): Promise<OutlookConversationResult> {
  const clarification = await (deps.extract ?? extractOutlookIntent)({
    text,
    now: deps.now,
    hasContext: Boolean(pending.data.entityRef),
    generate: deps.generateIntent,
    onDiagnostic: logModelDiagnostic,
  });
  const merged = mergeIntentSlots(pending.data, clarification, text);
  const missing = missingWriteFields(
    merged,
    pending.data.entityRef,
    pending.data.missingFields.includes("operation") && !explicitWriteOperation(text),
  );
  if (missing.length) {
    const nextData: PendingOutlookMailIntentData = {
      ...pending.data,
      intent: merged,
      missingFields: missing,
    };
    await (deps.updatePendingIntent ?? updatePendingOutlookMailIntent)(userId, pending.id, nextData);
    return { handled: true, reply: clarificationPrompt(missing) };
  }
  if (merged.provider !== "outlook") {
    return { handled: false };
  }
  const claimed = await (deps.consumePendingIntent ?? consumePendingOutlookMailIntent)(userId, pending.id);
  if (!claimed) return { handled: true, reply: "I’ve already handled that clarification." };
  return handleWrite(userId, text, merged, deps, pending.data.entityRef);
}

function isPotentialContextualWrite(text: string): boolean {
  const command = text.toLowerCase().trim()
    .replace(/^(?:please\s+|can you\s+|could you\s+|would you\s+|will you\s+)+/, "");
  return /^(?:reply(?:\s+all)?|respond|write(?:\s+back)?|tell\s+(?:him|her|them|the\s+sender)|draft|compose|prepare|send|email|shoot|forward|pass|mark|keep|make|delete|remove|discard|edit|update|change)\b/.test(command);
}

function requiresContextualIntentExtraction(text: string): boolean {
  if (isPotentialContextualWrite(text)) return true;
  if (/\b(?:read|unread|seen)\b/i.test(text)) return true;
  if (/\b(?:compare|folders?|inbox|sent\s+items|drafts?)\b/i.test(text)) return true;
  if (/\b(?:search|find|look\s+for|pull\s+up|list)\b/i.test(text)) return true;
  if (/\b(?:latest|recent|newest)\b[^.!?]{0,80}\b(?:emails?|mail|messages?)\b/i.test(text)) return true;
  if (/\b(?:anything|something)\s+from\b/i.test(text) || /\bwhat\s+(?:came|comes)\s+in\b/i.test(text)) return true;
  return false;
}

/**
 * Entity arbitration has already established Outlook ownership here. Recognize
 * the small set of operations that need deterministic/provider handling; all
 * other grounded follow-ups are read-only questions over the active evidence.
 */
function groundedContextualIntent(text: string): OutlookIntent | null {
  if (requiresContextualIntentExtraction(text)) return null;
  const ordinal = parseOutlookOrdinal(text);
  if (ordinal && /\b(?:open|show|view|read|switch|go\s+to)\b/i.test(text)) {
    return OutlookIntentSchema.parse({ provider: "outlook", operation: "get", ordinal });
  }
  if (/\b(?:refresh|re-?check|check\s+again|whether\s+(?:it|this|that|the\s+(?:email|message))\s+(?:has\s+)?changed|current\s+(?:state|version))\b/i.test(text)) {
    return OutlookIntentSchema.parse({
      provider: "outlook",
      operation: "question",
      question: text,
      requiresFresh: true,
    });
  }
  if (/\battachments?\b/i.test(text)) {
    return OutlookIntentSchema.parse({ provider: "outlook", operation: "attachments" });
  }
  if (/^(?:open|show|view|read)\b/i.test(text.trim())) {
    return OutlookIntentSchema.parse({ provider: "outlook", operation: "get" });
  }
  return OutlookIntentSchema.parse({
    provider: "outlook",
    operation: "question",
    question: text,
  });
}

function explicitlyReferencesSelection(text: string): boolean {
  return /\b(?:them|all\s+of\s+them)\b/i.test(text)
    || /\b(?:which\s+of|among|across)\s+(?:these|those|the)?\s*(?:emails?|messages?|results?|ones)\b/i.test(text)
    || /\b(?:these|those|all(?:\s+of)?(?:\s+the)?|shown|listed|above)\s+(?:emails?|messages?|results?|ones)\b/i.test(text)
    || /\b(?:emails?|messages?)\s+(?:shown|listed|above|need|require)\b/i.test(text)
    || /\binbox\s+(?:overview|summary)\b/i.test(text);
}

function shouldUseSelectionEvidence(
  text: string,
  intent: OutlookIntent,
  hasActiveEntity: boolean,
): boolean {
  if (explicitlyReferencesSelection(text)) return true;
  // A model-supplied useContext flag may recover a set-level request only when
  // there is no active entity. It may never silently broaden an active message.
  return !hasActiveEntity && intent.useContext === true;
}

function resolveComparisonRefs(
  refs: OutlookMessageRef[],
  intent: OutlookIntent,
  active: OutlookMessageRef | null,
  text: string,
): [OutlookMessageRef, OutlookMessageRef] | null {
  if (intent.ordinal && intent.secondOrdinal) {
    const first = refs[intent.ordinal - 1];
    const second = refs[intent.secondOrdinal - 1];
    return first && second && first.id !== second.id ? [first, second] : null;
  }
  const mentioned = intent.ordinal ?? intent.secondOrdinal ?? parseOutlookOrdinal(text);
  if (active && mentioned) {
    const other = refs[mentioned - 1];
    return other && other.id !== active.id ? [active, other] : null;
  }
  if (active) return null;
  const first = refs[(intent.ordinal ?? 1) - 1];
  const second = refs[1];
  return first && second && first.id !== second.id ? [first, second] : null;
}

function displayedOrdinal(position: number): string {
  const words = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"];
  return words[position - 1] ?? `number ${position}`;
}

function comparisonRole(
  ref: OutlookMessageRef,
  displayedRefs: OutlookMessageRef[],
  active: OutlookMessageRef | null,
): string {
  const position = displayedRefs.findIndex((candidate) => candidate.id === ref.id) + 1;
  const role = active?.id === ref.id
    ? position > 0
      ? `the email the user opened; it was the ${displayedOrdinal(position)} email in Hula’s displayed list`
      : "the email the user opened"
    : position > 0
      ? `the ${displayedOrdinal(position)} email in Hula’s displayed list`
      : "the other email the user asked to compare";
  return `COMPARISON ROLE — grounding instruction only; never repeat this line: ${role}.`;
}

function logModelDiagnostic(diagnostic: OutlookModelDiagnostic): void {
  logger.warn("outlook.mail model degraded", {
    stage: diagnostic.stage,
    classification: diagnostic.classification,
  });
}

export async function handleOutlookMailConversation(
  userId: string,
  text: string | undefined,
  deps: OutlookConversationDeps = {},
): Promise<OutlookConversationResult> {
  const value = (text ?? "").trim();
  const selection = await loadOutlookSelection(userId, deps);
  const groundedEntity = await loadGroundedOutlookEntity(userId, "either", deps);
  const entity = groundedEntity?.ref ?? await loadOutlookEntity(userId, "either", deps);
  const hasContext = selection.length > 0 || Boolean(entity);

  let pendingIntent: PendingOutlookMailIntent | null = null;
  try {
    pendingIntent = await (deps.loadPendingIntent ?? loadPendingOutlookMailIntent)(userId);
    if (pendingIntent?.expired) {
      await (deps.expirePendingIntent ?? expirePendingOutlookMailIntent)(userId, pendingIntent.id);
      pendingIntent = null;
    } else if (pendingIntent && isStandaloneMailRequest(value)) {
      // A new self-contained request supersedes an older clarification instead
      // of inheriting stale recipients/body from it.
      await (deps.expirePendingIntent ?? expirePendingOutlookMailIntent)(userId, pendingIntent.id);
      pendingIntent = null;
    }
  } catch {
    pendingIntent = null;
  }
  if (pendingIntent && shouldApplyPendingIntent(value, pendingIntent.data)) {
    return resolvePendingIntent(userId, value, pendingIntent, deps);
  }
  if (!shouldConsiderMail(value, hasContext) && !deps.arbitrated) return { handled: false };

  try {
    const explicit = explicitMailProvider(value);
    const owner = await resolveMailOwner(userId, value, deps);
    if (explicit === "outlook" && owner === "none") {
      return { handled: true, reply: "Your Outlook account isn’t available. Reconnect Microsoft 365 in Hula; I won’t silently use Gmail instead." };
    }
    if (owner === "gmail") return { handled: false };
    if (owner === "ambiguous") {
      let timezone: string | undefined;
      try { timezone = await (deps.getTimezone ?? getUserTimezone)(userId); } catch { timezone = undefined; }
      const semantic = await (deps.extract ?? extractOutlookIntent)({
        text: value,
        now: deps.now,
        timezone,
        hasContext,
        generate: deps.generateIntent,
        onDiagnostic: logModelDiagnostic,
      });
      if (semantic && WRITE_OPS.has(semantic.operation)) {
        const ambiguousIntent: OutlookIntent = { ...semantic, provider: "unknown" };
        const missing = missingWriteFields(
          ambiguousIntent,
          entity,
          explicitWriteOperation(value) === null,
        );
        await savePendingIntent(userId, ambiguousIntent, missing, "mail_provider_or_operation", entity, deps);
        return { handled: true, reply: clarificationPrompt(missing) };
      }
      return { handled: true, reply: "Do you want me to use Gmail or Outlook? Both are connected, and I don’t want to choose the wrong inbox." };
    }
    if (owner === "none") return { handled: false };

    let timezone: string | undefined;
    try { timezone = await (deps.getTimezone ?? getUserTimezone)(userId); } catch { timezone = undefined; }
    const contextual = deps.arbitrated && groundedEntity?.message
      ? groundedContextualIntent(value)
      : null;
    const semantic = contextual ?? await (deps.extract ?? extractOutlookIntent)({
      text: value,
      now: deps.now,
      timezone,
      hasContext,
      generate: deps.generateIntent,
      onDiagnostic: logModelDiagnostic,
    });
    const fallback = explicitOutlookIntent(value);
    let intent = semantic && semantic.operation !== "not_mail" ? semantic : fallback;
    if (!intent && deps.arbitrated && groundedEntity?.message && requiresContextualIntentExtraction(value)) {
      return {
        handled: true,
        reply: isPotentialContextualWrite(value)
          ? "I haven’t changed or sent anything. Tell me whether you want to draft, send, reply, forward, or change the email’s read state."
          : "What would you like to know or do with that Outlook email?",
      };
    }
    if (!intent && explicit === "outlook") {
      return { handled: true, reply: "What would you like me to do in Outlook—find an email, create a draft, or prepare something to send?" };
    }
    if (intent && explicit === "outlook") intent = { ...intent, provider: "outlook" };
    if (!intent || intent.operation === "not_mail" || intent.provider === "gmail" || intent.provider === "not_mail") {
      return { handled: false };
    }
    if (WRITE_OPS.has(intent.operation)) {
      const missing = missingWriteFields(intent, entity);
      if (missing.length) {
        await savePendingIntent(userId, intent, missing, "required_mail_fields", entity, deps);
        return { handled: true, reply: clarificationPrompt(missing) };
      }
      return handleWrite(userId, value, intent, deps);
    }

    if (intent.operation === "folders") {
      const page = await (deps.folders ?? listOutlookFolders)(userId, deps);
      const lines = page.items.map((folder, index) => `${index + 1}. ${folder.displayName} — ${folder.unreadItemCount} unread, ${folder.totalItemCount} total`);
      const suffix = page.hasMore ? "\nI’m showing the first 50 folders." : "";
      return { handled: true, reply: lines.length ? `Your Outlook folders:\n${lines.join("\n")}${suffix}` : "I couldn’t find any Outlook folders." };
    }

    if (intent.operation === "list" || intent.operation === "search") {
      const query = queryFromIntent(intent);
      if (intent.folder) query.folder = await (deps.resolveFolder ?? resolveOutlookFolder)(userId, intent.folder, deps);
      const page = await (deps.list ?? listOutlookMessages)(userId, query, deps);
      await recordOutlookSelection(userId, page.items, deps);
      return { handled: true, reply: formatOutlookList(page.items, timezone, page.hasMore) };
    }

    if (intent.operation === "compare") {
      const refs = await loadOutlookSelection(userId, deps);
      const comparison = resolveComparisonRefs(refs, intent, groundedEntity?.ref ?? null, value);
      if (!comparison) return { handled: true, reply: "Which two Outlook messages should I compare?" };
      const messages = await Promise.all([
        evidenceForRef(userId, comparison[0], deps, intent.requiresFresh === true),
        evidenceForRef(userId, comparison[1], deps, intent.requiresFresh === true),
      ]);
      const evidenceLabels = comparison.map((ref) =>
        comparisonRole(ref, refs, groundedEntity?.ref ?? null)
      );
      const analysis = await (deps.analyze ?? analyzeOutlookMessages)({
        question: value,
        messages,
        evidenceLabels,
        generate: deps.generateAnalysis,
        onDiagnostic: logModelDiagnostic,
      });
      return { handled: true, reply: formatOutlookAnalysis(analysis, value) };
    }

    if (
      (intent.operation === "summarize" || intent.operation === "question") &&
      shouldUseSelectionEvidence(value, intent, Boolean(groundedEntity?.message))
    ) {
      let refs = await loadOutlookSelection(userId, deps);
      if (!refs.length) {
        const page = await (deps.list ?? listOutlookMessages)(userId, {
          ...queryFromIntent(intent),
          maxResults: Math.min(intent.count ?? 5, 5),
        }, deps);
        await recordOutlookSelection(userId, page.items, deps);
        refs = page.items.map((message) => ({
          provider: "microsoft" as const,
          service: "outlook_mail" as const,
          itemKind: message.isDraft ? "draft" as const : "message" as const,
          id: message.id,
          conversationId: message.conversationId,
          parentFolderId: message.parentFolderId,
          senderAddress: (message.sender ?? message.from)?.address ?? null,
          senderName: (message.sender ?? message.from)?.name ?? null,
          subject: message.subject,
          receivedAt: message.receivedAt,
          isRead: message.isRead,
        }));
      }
      if (!refs.length) return { handled: true, reply: "I couldn’t find any Outlook messages to analyse." };
      const messages = await Promise.all(refs.slice(0, Math.min(intent.count ?? 5, 5)).map((ref) =>
        evidenceForRef(userId, ref, deps, intent.requiresFresh === true)
      ));
      const analysis = await (deps.analyze ?? analyzeOutlookMessages)({
        question: intent.question ?? value,
        messages,
        generate: deps.generateAnalysis,
        onDiagnostic: logModelDiagnostic,
      });
      return { handled: true, reply: formatOutlookAnalysis(analysis, intent.question ?? value) };
    }

    const target = await resolveTarget(userId, value, intent, deps, "either", intent.requiresFresh === true);
    if (!target.message) return { handled: true, reply: target.reply };
    await recordOutlookEntity(userId, target.message, deps);
    if (intent.operation === "get") return { handled: true, reply: formatDetail(target.message, timezone) };
    if (intent.operation === "attachments") {
      return {
        handled: true,
        reply: target.message.attachments.length
          ? `This Outlook message has ${target.message.attachments.length} attachment${target.message.attachments.length === 1 ? "" : "s"} (metadata only):\n${target.message.attachments.map((item) => `• ${item.name} — ${item.contentType ?? "unknown type"}, ${item.size} bytes`).join("\n")}\nI haven’t read the attachment contents.`
          : "This Outlook message has no attachments.",
      };
    }
    const analysis = await (deps.analyze ?? analyzeOutlookMessages)({
      question: intent.question ?? value,
      messages: [target.message],
      generate: deps.generateAnalysis,
      onDiagnostic: logModelDiagnostic,
    });
    return { handled: true, reply: formatOutlookAnalysis(analysis, intent.question ?? value) };
  } catch (error) {
    if (error instanceof MicrosoftGraphError) return { handled: true, reply: graphReply(error) };
    logger.error("outlook.mail conversation failed", {
      stage: "unknown",
      classification: "unknown",
    });
    return { handled: true, reply: "I couldn’t handle that Outlook request reliably just now." };
  }
}
