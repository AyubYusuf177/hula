import { z } from "zod";

import type { ActionProposalView } from "../../../actions/proposals";
import type { OutlookIntent } from "./mailIntent";

const EmailSchema = z.string().trim().email().transform((value) => value.toLowerCase());
const OptionalTextSchema = z.string().trim().min(1).max(20_000).nullable().optional();

const OutlookSendInputSchema = z.object({
  operation: z.enum(["send", "reply", "reply_all", "forward", "send_draft"]),
  to: z.array(EmailSchema).min(1).max(50),
  body: z.string().trim().min(1).max(20_000),
  subject: OptionalTextSchema,
  cc: z.array(EmailSchema).max(50).nullable().optional(),
  bcc: z.array(EmailSchema).max(50).nullable().optional(),
  sourceMessageId: OptionalTextSchema,
  draftId: OptionalTextSchema,
});

const GmailSendInputSchema = z.object({
  to: EmailSchema,
  body: z.string().trim().min(1).max(20_000),
  subject: OptionalTextSchema,
  isReply: z.boolean().optional(),
  threadId: OptionalTextSchema,
  inReplyTo: OptionalTextSchema,
  references: OptionalTextSchema,
});

export interface PendingMailProposalSlots {
  proposalId: string;
  provider: "outlook" | "gmail";
  operation: "send" | "reply" | "reply_all" | "forward" | "send_draft";
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string | null;
  body: string;
  sourceMessageId: string | null;
  draftId: string | null;
  expiresAt: string;
}

export function parsePendingMailProposal(
  proposal: ActionProposalView,
  now = new Date(),
): PendingMailProposalSlots | null {
  if (
    proposal.status !== "proposed" ||
    proposal.confirmationRequired !== true ||
    Date.parse(proposal.expiresAt) <= now.getTime()
  ) {
    return null;
  }
  if (proposal.actionId === "microsoft.mail.send" && proposal.provider === "microsoft") {
    const parsed = OutlookSendInputSchema.safeParse(proposal.input);
    if (!parsed.success) return null;
    return {
      proposalId: proposal.id,
      provider: "outlook",
      operation: parsed.data.operation,
      to: parsed.data.to,
      cc: parsed.data.cc ?? [],
      bcc: parsed.data.bcc ?? [],
      subject: parsed.data.subject ?? null,
      body: parsed.data.body,
      sourceMessageId: parsed.data.sourceMessageId ?? null,
      draftId: parsed.data.draftId ?? null,
      expiresAt: proposal.expiresAt,
    };
  }
  if (proposal.actionId === "email.sendDraft" && proposal.provider === "gmail") {
    const parsed = GmailSendInputSchema.safeParse(proposal.input);
    if (!parsed.success) return null;
    return {
      proposalId: proposal.id,
      provider: "gmail",
      operation: parsed.data.isReply ? "reply" : "send",
      to: [parsed.data.to],
      cc: [],
      bcc: [],
      subject: parsed.data.subject ?? null,
      body: parsed.data.body,
      sourceMessageId: null,
      draftId: null,
      expiresAt: proposal.expiresAt,
    };
  }
  return null;
}

/**
 * Cheap semantic gate before touching the proposal store or model. It recognizes
 * operation/provider correction language, not particular recipients or bodies.
 */
export function mayRevisePendingMailProposal(text: string): boolean {
  const value = text.trim();
  if (!value || value.length > 300) return false;
  const draftDirection =
    /\b(?:draft|unsent)\b/i.test(value) ||
    /\b(?:save|leave|keep|make)\b[^.!?]{0,80}\b(?:draft|unsent)\b/i.test(value) ||
    /\b(?:do\s+not|don[’']?t)\s+send\b/i.test(value);
  const providerDirection =
    /\b(?:actually|instead|rather|switch|change|use)\b[^.!?]{0,80}\b(?:outlook|gmail)\b/i.test(value);
  if (providerDirection) return true;
  if (!draftDirection) return false;
  const correctionCue = /\b(?:actually|instead|rather|change|make|save|leave|keep|do\s+not|don[’']?t)\b/i.test(value);
  return correctionCue || value.split(/\s+/).length <= 8;
}

export function isOutlookProposalRevision(
  text: string,
  intent: OutlookIntent,
  pending: PendingMailProposalSlots,
): boolean {
  if (!mayRevisePendingMailProposal(text)) return false;
  if (intent.proposalRevision === true) return true;
  if (intent.proposalRevision === false) return false;
  const suppliesIndependentMailSlots = Boolean(
    intent.to?.length ||
    intent.draftBody ||
    intent.draftSubject,
  );
  if (intent.operation === "create_draft" && !suppliesIndependentMailSlots) return true;
  return pending.provider === "gmail" && intent.provider === "outlook" && intent.operation === "send";
}

export function revisedOutlookOperation(
  pending: PendingMailProposalSlots,
  intent: OutlookIntent,
): "create_draft" | "create_reply_draft" | "create_reply_all_draft" | "create_forward_draft" | "send" | null {
  if (intent.operation === "send" && intent.provider === "outlook") return "send";
  if (intent.operation !== "create_draft") return null;
  if (pending.provider !== "outlook") return "create_draft";
  if (pending.operation === "reply") return "create_reply_draft";
  if (pending.operation === "reply_all") return "create_reply_all_draft";
  if (pending.operation === "forward") return "create_forward_draft";
  if (pending.operation === "send_draft") return null;
  return "create_draft";
}
