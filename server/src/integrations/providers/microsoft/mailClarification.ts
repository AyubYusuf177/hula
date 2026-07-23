import { z } from "zod";

import { getPrisma } from "../../../db/prisma";
import {
  createActionProposal,
  expireProposal,
  getLatestProposalByAction,
  updateProposalInput,
  type ActionProposalView,
  type CreateProposalInput,
} from "../../../actions/proposals";
import { OutlookIntentSchema, type OutlookIntent } from "./mailIntent";
import type { OutlookMessageRef } from "./mailContext";

export const OUTLOOK_MAIL_CLARIFICATION_ACTION_ID = "microsoft.mail.pendingIntent" as const;
export const OUTLOOK_MAIL_CLARIFICATION_TTL_MS = 10 * 60 * 1_000;

export const OutlookMailMissingFieldSchema = z.enum([
  "provider",
  "operation",
  "to",
  "body",
  "subject",
  "target",
]);
export type OutlookMailMissingField = z.infer<typeof OutlookMailMissingFieldSchema>;

const OutlookMessageRefSchema = z.object({
  provider: z.literal("microsoft"),
  service: z.literal("outlook_mail"),
  itemKind: z.enum(["message", "draft"]),
  id: z.string().min(1).max(1_000),
  conversationId: z.string().max(1_000).nullable(),
  parentFolderId: z.string().max(1_000).nullable(),
  senderAddress: z.string().max(320).nullable(),
  senderName: z.string().max(300).nullable(),
  subject: z.string().max(998),
  receivedAt: z.string().max(64).nullable(),
  isRead: z.boolean(),
});

export const PendingOutlookMailIntentDataSchema = z.object({
  kind: z.literal("outlook_mail_pending_intent"),
  intent: OutlookIntentSchema,
  missingFields: z.array(OutlookMailMissingFieldSchema).min(1).max(6),
  ambiguityReason: z.string().trim().min(1).max(200),
  entityRef: OutlookMessageRefSchema.nullable(),
  contextEstablishedAt: z.number().int().nonnegative(),
});

export type PendingOutlookMailIntentData = z.infer<typeof PendingOutlookMailIntentDataSchema>;

export interface PendingOutlookMailIntent {
  id: string;
  data: PendingOutlookMailIntentData;
  expired: boolean;
}

export interface OutlookMailClarificationStore {
  create?: (userId: string, input: CreateProposalInput) => Promise<{ id: string }>;
  getLatest?: (userId: string, actionId: string) => Promise<ActionProposalView | null>;
  updateInput?: (userId: string, id: string, input: Record<string, unknown>) => Promise<void>;
  expire?: (userId: string, id: string) => Promise<void>;
  supersede?: (userId: string) => Promise<void>;
  claim?: (userId: string, id: string) => Promise<boolean>;
  now?: Date;
}

export function parsePendingOutlookMailIntentData(
  input: Record<string, unknown> | null,
): PendingOutlookMailIntentData | null {
  const parsed = PendingOutlookMailIntentDataSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}

async function supersedePendingOutlookMailIntents(userId: string): Promise<void> {
  await getPrisma().actionProposal.updateMany({
    where: {
      userId,
      actionId: OUTLOOK_MAIL_CLARIFICATION_ACTION_ID,
      status: "proposed",
    },
    data: { status: "expired" },
  });
}

async function claimPendingOutlookMailIntent(userId: string, id: string): Promise<boolean> {
  const result = await getPrisma().actionProposal.updateMany({
    where: {
      id,
      userId,
      actionId: OUTLOOK_MAIL_CLARIFICATION_ACTION_ID,
      status: "proposed",
      expiresAt: { gt: new Date() },
    },
    data: { status: "confirmed", confirmedAt: new Date() },
  });
  return result.count === 1;
}

export async function createPendingOutlookMailIntent(
  userId: string,
  input: {
    intent: OutlookIntent;
    missingFields: OutlookMailMissingField[];
    ambiguityReason: string;
    entityRef?: OutlookMessageRef | null;
  },
  store: OutlookMailClarificationStore = {},
): Promise<{ id: string }> {
  const data = PendingOutlookMailIntentDataSchema.parse({
    kind: "outlook_mail_pending_intent",
    intent: input.intent,
    missingFields: [...new Set(input.missingFields)],
    ambiguityReason: input.ambiguityReason,
    entityRef: input.entityRef ?? null,
    contextEstablishedAt: (store.now ?? new Date()).getTime(),
  });
  await (store.supersede ?? supersedePendingOutlookMailIntents)(userId);
  return (store.create ?? createActionProposal)(userId, {
    provider: "microsoft",
    actionId: OUTLOOK_MAIL_CLARIFICATION_ACTION_ID,
    riskLevel: "read",
    confirmationRequired: false,
    input: data as unknown as Record<string, unknown>,
    previewText: `Outlook mail clarification: ${data.missingFields.join(", ")}.`,
    ttlMs: OUTLOOK_MAIL_CLARIFICATION_TTL_MS,
  });
}

export async function loadPendingOutlookMailIntent(
  userId: string,
  store: OutlookMailClarificationStore = {},
): Promise<PendingOutlookMailIntent | null> {
  const view = await (store.getLatest ?? getLatestProposalByAction)(
    userId,
    OUTLOOK_MAIL_CLARIFICATION_ACTION_ID,
  );
  if (!view) return null;
  const data = parsePendingOutlookMailIntentData(view.input);
  if (!data) return null;
  return {
    id: view.id,
    data,
    expired: Date.parse(view.expiresAt) <= (store.now ?? new Date()).getTime(),
  };
}

export async function updatePendingOutlookMailIntent(
  userId: string,
  id: string,
  data: PendingOutlookMailIntentData,
  store: OutlookMailClarificationStore = {},
): Promise<void> {
  const parsed = PendingOutlookMailIntentDataSchema.parse(data);
  await (store.updateInput ?? updateProposalInput)(
    userId,
    id,
    parsed as unknown as Record<string, unknown>,
  );
}

export async function consumePendingOutlookMailIntent(
  userId: string,
  id: string,
  store: OutlookMailClarificationStore = {},
): Promise<boolean> {
  return (store.claim ?? claimPendingOutlookMailIntent)(userId, id);
}

export async function expirePendingOutlookMailIntent(
  userId: string,
  id: string,
  store: OutlookMailClarificationStore = {},
): Promise<void> {
  await (store.expire ?? expireProposal)(userId, id);
}
