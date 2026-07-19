import { createActionProposal, listRecentProposalsByAction } from "../../../actions/proposals";
import type { SlackEntity, SlackEntityType } from "./types";
import type { SlackMutationReceipt } from "./actions";
import { getSlackInstallation } from "./operations";

export const SLACK_SELECTION_ACTION_ID = "slack.lastSelection";
export const SLACK_DERIVED_SELECTION_ACTION_ID = "slack.derivedSelection";
export const SLACK_ENTITY_ACTION_ID = "slack.entityContext";
const CONTEXT_TTL_MS = 30 * 60 * 1_000;
let lastEstablishedAt = 0;

export interface SlackContextDeps {
  listRecent?: typeof listRecentProposalsByAction;
  now?: Date;
}

function nextEstablishedAt(): number {
  lastEstablishedAt = Math.max(Date.now(), lastEstablishedAt + 1);
  return lastEstablishedAt;
}

function validEntity(value: unknown): value is SlackEntity {
  if (!value || typeof value !== "object") return false;
  const entity = value as Partial<SlackEntity>;
  return typeof entity.id === "string" && typeof entity.type === "string" &&
    typeof entity.label === "string" && typeof entity.workspaceName === "string";
}

export async function rememberSlackSelection(userId: string, entities: SlackEntity[]): Promise<void> {
  if (!entities.some(validEntity)) return;
  // A new primary result set starts a new referential frame. Keep the prior
  // primary rows for ordinal history, but explicitly close any derived thread
  // projection so an old reply cannot answer follow-ups about the new result.
  await rememberSlackDerivedSelection(userId, []);
  await rememberSlackEntityList(userId, SLACK_SELECTION_ACTION_ID, entities, "slack_selection", false);
}

/**
 * Persist a collection projected from the active entity (for example a thread's
 * replies) without replacing the user's primary search/history result set.
 */
export async function rememberSlackDerivedSelection(userId: string, entities: SlackEntity[]): Promise<void> {
  await rememberSlackEntityList(userId, SLACK_DERIVED_SELECTION_ACTION_ID, entities, "slack_derived_selection", true);
}

async function rememberSlackEntityList(
  userId: string,
  actionId: typeof SLACK_SELECTION_ACTION_ID | typeof SLACK_DERIVED_SELECTION_ACTION_ID,
  entities: SlackEntity[],
  kind: "slack_selection" | "slack_derived_selection",
  allowEmpty: boolean,
): Promise<void> {
  const safe = entities.filter(validEntity).slice(0, 20);
  if (!allowEmpty && safe.length === 0) return;
  await createActionProposal(userId, {
    provider: "slack",
    actionId,
    riskLevel: "read",
    confirmationRequired: false,
    input: {
      kind,
      entities: safe,
      contextEstablishedAt: nextEstablishedAt(),
    },
    previewText: "Slack selection context",
    ttlMs: CONTEXT_TTL_MS,
  });
}

export async function rememberSlackEntity(userId: string, entity: SlackEntity): Promise<void> {
  if (!validEntity(entity)) return;
  await createActionProposal(userId, {
    provider: "slack",
    actionId: SLACK_ENTITY_ACTION_ID,
    riskLevel: "read",
    confirmationRequired: false,
    input: {
      kind: "slack_entity",
      entity,
      contextEstablishedAt: nextEstablishedAt(),
    },
    previewText: "Slack entity context",
    ttlMs: CONTEXT_TTL_MS,
  });
}

export async function rememberVerifiedSlackMutation(
  userId: string,
  receipt: SlackMutationReceipt,
  params: Record<string, unknown>,
): Promise<void> {
  const id = receipt.scheduledMessageId ?? receipt.timestamp ?? receipt.entityId;
  if (!id) return;
  const type: SlackEntityType = receipt.scheduledMessageId
    ? "scheduled_message"
    : receipt.timestamp
      ? "message"
      : receipt.method.startsWith("bookmarks.")
        ? "bookmark"
        : receipt.method.startsWith("usergroups.")
          ? "user_group"
          : "channel";
  const label = typeof params.text === "string"
    ? params.text
    : typeof params.name === "string"
      ? params.name
      : receipt.method;
  const installation = receipt.timestamp
    ? await getSlackInstallation(userId).catch(() => null)
    : null;
  await rememberSlackEntity(userId, {
    type,
    id,
    label: label.slice(0, 500),
    workspaceName: "Slack workspace",
    channelId: receipt.channelId,
    ts: receipt.timestamp,
    threadTs: typeof params.thread_ts === "string" ? params.thread_ts : receipt.timestamp,
    userId: installation?.botUserId,
    authoredByHula: Boolean(receipt.timestamp),
    expiresAt: new Date(Date.now() + CONTEXT_TTL_MS).toISOString(),
  });
}

export async function resolveSlackEntity(
  userId: string,
  options: {
    position?: number | null;
    type?: SlackEntityType;
    preferActed?: boolean;
    selectionKind?: "primary" | "derived";
  } = {},
  deps: SlackContextDeps = {},
): Promise<SlackEntity | null> {
  const now = (deps.now ?? new Date()).getTime();
  const listRecent = deps.listRecent ?? listRecentProposalsByAction;
  const hasPosition = options.position !== undefined && options.position !== null;
  const collectionOnly = options.selectionKind === "derived" || hasPosition;
  const actionIds = options.selectionKind === "derived"
    ? [SLACK_DERIVED_SELECTION_ACTION_ID]
    : hasPosition
      ? [SLACK_SELECTION_ACTION_ID]
    : options.preferActed === false
      ? [SLACK_SELECTION_ACTION_ID, SLACK_ENTITY_ACTION_ID]
      : [SLACK_ENTITY_ACTION_ID, SLACK_SELECTION_ACTION_ID];
  const candidates: Array<{ entity: SlackEntity; at: number; priority: number }> = [];
  for (const actionId of actionIds) {
    const rows = await listRecent(userId, actionId, 20);
    for (const row of rows) {
      if (Date.parse(row.expiresAt) <= now || !row.input) continue;
      const establishedAt = typeof row.input.contextEstablishedAt === "number"
        ? row.input.contextEstablishedAt
        : Date.parse(row.createdAt);
      let candidate: SlackEntity | undefined;
      if (actionId === SLACK_ENTITY_ACTION_ID) {
        const active = row.input.entity;
        if (validEntity(active) && (!options.type || active.type === options.type)) candidate = active;
      } else {
        const entities = Array.isArray(row.input.entities)
          ? row.input.entities.filter(validEntity)
          : [];
        const filtered = options.type ? entities.filter((item) => item.type === options.type) : entities;
        const index = options.position === -1
          ? filtered.length - 1
          : Math.max((options.position ?? 1) - 1, 0);
        candidate = filtered[index];
      }
      // A derived collection is a complete projection of the most recently
      // inspected source (for example, the replies in one thread). An empty or
      // shorter new projection must not fall through to replies from an older
      // thread.
      if (actionId === SLACK_DERIVED_SELECTION_ACTION_ID && collectionOnly) {
        return candidate ?? null;
      }
      if (!candidate) continue;
      if (collectionOnly) return candidate;
      candidates.push({ entity: candidate, at: establishedAt, priority: actionIds.indexOf(actionId) });
    }
  }
  candidates.sort((left, right) => right.at - left.at || left.priority - right.priority);
  return candidates[0]?.entity ?? null;
}

export async function resolveSlackSelection(
  userId: string,
  type?: SlackEntityType,
  deps: SlackContextDeps = {},
): Promise<SlackEntity[]> {
  const now = (deps.now ?? new Date()).getTime();
  const rows = await (deps.listRecent ?? listRecentProposalsByAction)(userId, SLACK_SELECTION_ACTION_ID, 20);
  for (const row of rows) {
    if (Date.parse(row.expiresAt) <= now || !row.input || !Array.isArray(row.input.entities)) continue;
    const entities = row.input.entities.filter(validEntity);
    const matching = type ? entities.filter((item) => item.type === type) : entities;
    if (matching.length > 0) return matching;
  }
  return [];
}
