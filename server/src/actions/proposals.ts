import type { Prisma } from "@prisma/client";

import { getPrisma } from "../db/prisma";
import type { ActionRisk } from "../integrations/policy";

/**
 * Action proposal store (Section 12).
 *
 * A proposal is a pending, user-scoped intent to run a confirmable action (e.g.
 * "create this calendar event"). It carries a human `previewText` and expires
 * quickly. A natural-language "yes" in iMessage only ever confirms the single
 * ACTIVE proposal for that user — confirmation never becomes standing consent.
 *
 * Every value returned here is SAFE for inspection endpoints: action metadata,
 * status, and a redacted input summary only — never a token or a raw provider
 * payload.
 */

/** How long a proposal stays confirmable before it expires. */
export const PROPOSAL_TTL_MS = 10 * 60 * 1000;

export type ActionProposalStatusValue =
  | "proposed"
  | "confirmed"
  | "rejected"
  | "expired"
  | "executed"
  | "failed"
  | "cancelled";

/** A safe, app-facing view of one proposal. Contains NO token material. */
export interface ActionProposalView {
  id: string;
  provider: string | null;
  actionId: string;
  status: ActionProposalStatusValue;
  riskLevel: string;
  confirmationRequired: boolean;
  previewText: string;
  input: Record<string, unknown> | null;
  expiresAt: string;
  confirmedAt: string | null;
  rejectedAt: string | null;
  executedAt: string | null;
  createdAt: string;
}

const PROPOSAL_SELECT = {
  id: true,
  provider: true,
  actionId: true,
  status: true,
  riskLevel: true,
  confirmationRequired: true,
  previewText: true,
  inputJson: true,
  expiresAt: true,
  confirmedAt: true,
  rejectedAt: true,
  executedAt: true,
  createdAt: true,
} as const;

interface ProposalRow {
  id: string;
  provider: string | null;
  actionId: string;
  status: ActionProposalStatusValue;
  riskLevel: string;
  confirmationRequired: boolean;
  previewText: string;
  inputJson: unknown;
  expiresAt: Date;
  confirmedAt: Date | null;
  rejectedAt: Date | null;
  executedAt: Date | null;
  createdAt: Date;
}

function toView(row: ProposalRow): ActionProposalView {
  return {
    id: row.id,
    provider: row.provider,
    actionId: row.actionId,
    status: row.status,
    riskLevel: row.riskLevel,
    confirmationRequired: row.confirmationRequired,
    previewText: row.previewText,
    input:
      row.inputJson && typeof row.inputJson === "object"
        ? (row.inputJson as Record<string, unknown>)
        : null,
    expiresAt: row.expiresAt.toISOString(),
    confirmedAt: row.confirmedAt ? row.confirmedAt.toISOString() : null,
    rejectedAt: row.rejectedAt ? row.rejectedAt.toISOString() : null,
    executedAt: row.executedAt ? row.executedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Fields needed to create a proposal. */
export interface CreateProposalInput {
  provider?: string | null;
  actionId: string;
  riskLevel: ActionRisk;
  confirmationRequired?: boolean;
  input?: Record<string, unknown> | null;
  previewText: string;
  ttlMs?: number;
}

/** Create a new `proposed` action proposal for a user. */
export async function createActionProposal(
  userId: string,
  input: CreateProposalInput,
): Promise<ActionProposalView> {
  const row = await getPrisma().actionProposal.create({
    data: {
      userId,
      provider: input.provider ?? null,
      actionId: input.actionId,
      status: "proposed",
      riskLevel: input.riskLevel,
      confirmationRequired: input.confirmationRequired ?? true,
      inputJson: (input.input ?? undefined) as Prisma.InputJsonValue | undefined,
      previewText: input.previewText,
      expiresAt: new Date(Date.now() + (input.ttlMs ?? PROPOSAL_TTL_MS)),
    },
    select: PROPOSAL_SELECT,
  });
  return toView(row as ProposalRow);
}

/**
 * Return the user's single ACTIVE proposal — the most recent `proposed` row that
 * has not expired — or null. Expired-but-still-`proposed` rows are lazily flipped
 * to `expired` here so a stale "yes" can never confirm them.
 */
export async function getActiveProposal(
  userId: string,
): Promise<ActionProposalView | null> {
  const prisma = getPrisma();
  const row = await prisma.actionProposal.findFirst({
    where: { userId, status: "proposed" },
    orderBy: { createdAt: "desc" },
    select: PROPOSAL_SELECT,
  });
  if (!row) return null;

  if (row.expiresAt.getTime() <= Date.now()) {
    await prisma.actionProposal.update({
      where: { id: row.id },
      data: { status: "expired" },
    });
    return null;
  }
  return toView(row as ProposalRow);
}

/** Get one proposal owned by the user, or null. Never returns others' rows. */
export async function getProposalForUser(
  userId: string,
  proposalId: string,
): Promise<ActionProposalView | null> {
  const row = await getPrisma().actionProposal.findFirst({
    where: { id: proposalId, userId },
    select: PROPOSAL_SELECT,
  });
  return row ? toView(row as ProposalRow) : null;
}

/** List a user's proposals (newest first), for inspection endpoints. */
export async function listProposalsForUser(
  userId: string,
  limit = 25,
): Promise<ActionProposalView[]> {
  const rows = await getPrisma().actionProposal.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(1, limit), 100),
    select: PROPOSAL_SELECT,
  });
  return rows.map((r) => toView(r as ProposalRow));
}

/**
 * Transition a proposal to a terminal/confirmed state, but ONLY when it is still
 * `proposed` and owned by the user. Returns the updated view, or null if it was
 * already resolved / not found (so a double "yes" is a no-op).
 */
async function transition(
  userId: string,
  proposalId: string,
  status: ActionProposalStatusValue,
  stamp: Partial<Record<"confirmedAt" | "rejectedAt" | "executedAt", Date>>,
): Promise<ActionProposalView | null> {
  const result = await getPrisma().actionProposal.updateMany({
    where: { id: proposalId, userId, status: "proposed" },
    data: { status, ...stamp },
  });
  if (result.count === 0) return null;
  return getProposalForUser(userId, proposalId);
}

/** Mark a proposal `confirmed` (only if currently `proposed`). */
export function confirmProposal(userId: string, proposalId: string) {
  return transition(userId, proposalId, "confirmed", { confirmedAt: new Date() });
}

/** Mark a proposal `rejected`/`cancelled` (only if currently `proposed`). */
export function rejectProposal(userId: string, proposalId: string) {
  return transition(userId, proposalId, "rejected", { rejectedAt: new Date() });
}

/** Mark an already-confirmed proposal as `executed`/`failed` after running it. */
export async function finalizeProposal(
  userId: string,
  proposalId: string,
  outcome: "executed" | "failed",
): Promise<void> {
  await getPrisma().actionProposal.updateMany({
    where: { id: proposalId, userId, status: "confirmed" },
    data: {
      status: outcome,
      ...(outcome === "executed" ? { executedAt: new Date() } : {}),
    },
  });
}
