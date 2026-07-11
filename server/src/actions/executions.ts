import type { Prisma } from "@prisma/client";

import { getPrisma } from "../db/prisma";

/**
 * Action execution ledger (Section 12).
 *
 * A durable, audit-style record of every action Hula attempts on the user's
 * behalf — including ones that are BLOCKED by policy. Only sanitised summaries
 * are stored: never a token, never a raw provider payload. This is the ledger the
 * inspection endpoints read back and future write actions append to.
 */

export type ActionExecutionStatusValue =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "blocked";

/** A safe, app-facing view of one execution. Contains NO token material. */
export interface ActionExecutionView {
  id: string;
  proposalId: string | null;
  provider: string | null;
  actionId: string;
  status: ActionExecutionStatusValue;
  requestSummary: Record<string, unknown> | null;
  resultSummary: Record<string, unknown> | null;
  errorMessage: string | null;
  createdAt: string;
}

const EXECUTION_SELECT = {
  id: true,
  proposalId: true,
  provider: true,
  actionId: true,
  status: true,
  requestSummaryJson: true,
  resultSummaryJson: true,
  errorMessage: true,
  createdAt: true,
} as const;

interface ExecutionRow {
  id: string;
  proposalId: string | null;
  provider: string | null;
  actionId: string;
  status: ActionExecutionStatusValue;
  requestSummaryJson: unknown;
  resultSummaryJson: unknown;
  errorMessage: string | null;
  createdAt: Date;
}

function toObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function toView(row: ExecutionRow): ActionExecutionView {
  return {
    id: row.id,
    proposalId: row.proposalId,
    provider: row.provider,
    actionId: row.actionId,
    status: row.status,
    requestSummary: toObject(row.requestSummaryJson),
    resultSummary: toObject(row.resultSummaryJson),
    errorMessage: row.errorMessage,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Fields needed to append an execution row. Summaries must be pre-redacted. */
export interface RecordExecutionInput {
  proposalId?: string | null;
  provider?: string | null;
  actionId: string;
  status: ActionExecutionStatusValue;
  requestSummary?: Record<string, unknown> | null;
  resultSummary?: Record<string, unknown> | null;
  errorMessage?: string | null;
}

/** Append one execution record. Returns the new row id. */
export async function recordActionExecution(
  userId: string,
  input: RecordExecutionInput,
): Promise<string> {
  const row = await getPrisma().actionExecution.create({
    data: {
      userId,
      proposalId: input.proposalId ?? null,
      provider: input.provider ?? null,
      actionId: input.actionId,
      status: input.status,
      requestSummaryJson: (input.requestSummary ?? undefined) as
        | Prisma.InputJsonValue
        | undefined,
      resultSummaryJson: (input.resultSummary ?? undefined) as
        | Prisma.InputJsonValue
        | undefined,
      errorMessage: input.errorMessage ?? null,
    },
    select: { id: true },
  });
  return row.id;
}

/** List a user's executions (newest first), for inspection endpoints. */
export async function listExecutionsForUser(
  userId: string,
  limit = 25,
): Promise<ActionExecutionView[]> {
  const rows = await getPrisma().actionExecution.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(1, limit), 100),
    select: EXECUTION_SELECT,
  });
  return rows.map((r) => toView(r as ExecutionRow));
}
