import { notionPlainText, notionTitle } from "./display";
import { notionOps } from "./operations";
import type { NotionObject } from "./types";

export type ResolvedNotionResource = {
  ref: { id: string; type: "page" | "database" | "data_source"; title: string; parentTitle?: string };
  object: NotionObject;
};

export interface NotionResourceResolverDeps {
  search?: typeof notionOps.search;
  children?: typeof notionOps.children;
  database?: typeof notionOps.database;
  dataSource?: typeof notionOps.dataSource;
}

export type NotionResourceResolution =
  | { kind: "resolved"; resource: ResolvedNotionResource }
  | { kind: "ambiguous"; candidates: ResolvedNotionResource[] }
  | { kind: "missing" };

const RESOURCE_LIMIT = 30;
const CHILD_LIMIT = 100;

/** Normalize user-created titles without baking in any workspace-specific names. */
export function normalizeNotionResourceName(value: string): string {
  return notionPlainText(value, 500)
    .normalize("NFKD")
    .toLocaleLowerCase("en")
    .replace(/[’']/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function singularTokens(value: string): string {
  return normalizeNotionResourceName(value)
    .split(" ")
    .map((token) => {
      if (token.endsWith("ies") && token.length > 4) return `${token.slice(0, -3)}y`;
      if (token.endsWith("ses") && token.length > 4) return token.slice(0, -2);
      if (token.endsWith("s") && !token.endsWith("ss") && token.length > 3) return token.slice(0, -1);
      return token;
    })
    .join(" ");
}

function distance(a: string, b: string): number {
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = previous[0]!;
    previous[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const above = previous[j]!;
      previous[j] = Math.min(previous[j]! + 1, previous[j - 1]! + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return previous[b.length]!;
}

function scoreTitle(query: string, title: string): number | null {
  const q = normalizeNotionResourceName(query);
  const t = normalizeNotionResourceName(title);
  if (!q || !t) return null;
  if (q === t) return 0;
  if (singularTokens(q) === singularTokens(t)) return 1;
  if ((t.includes(q) || q.includes(t)) && Math.min(q.length, t.length) >= 4) return 2 + Math.abs(q.length - t.length) / 100;
  const editDistance = distance(q, t);
  if (editDistance <= Math.min(3, Math.floor(Math.max(q.length, t.length) * 0.2))) return 5 + editDistance;
  return null;
}

function resourceFromObject(object: NotionObject, parentTitle?: string): ResolvedNotionResource | null {
  if (typeof object.id !== "string") return null;
  const type = object.object === "data_source" ? "data_source" : object.object === "database" ? "database" : object.object === "page" ? "page" : null;
  if (!type) return null;
  return { ref: { id: object.id, type, title: notionTitle(object), ...(parentTitle ? { parentTitle } : {}) }, object };
}

function explicitNotionId(value: string): string | null {
  const match = value.match(/(?:notion\.(?:so|site)\/[^\s?#]*?|^)([0-9a-f]{32}|[0-9a-f-]{36})(?:[?#\s]|$)/i);
  return match?.[1]?.replace(/-/g, "") ?? null;
}

function databaseDataSources(database: NotionObject, parentTitle?: string): ResolvedNotionResource[] {
  const rows = Array.isArray(database.data_sources) ? database.data_sources : [];
  return rows.flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const object = { object: "data_source", ...(row as Record<string, unknown>) } as NotionObject;
    const resource = resourceFromObject(object, parentTitle ?? notionTitle(database));
    return resource ? [resource] : [];
  });
}

async function childrenAsResources(userId: string, page: ResolvedNotionResource, deps: NotionResourceResolverDeps): Promise<ResolvedNotionResource[]> {
  const children = (await (deps.children ?? notionOps.children)(userId, page.ref.id)).slice(0, CHILD_LIMIT);
  const resources: ResolvedNotionResource[] = [];
  for (const child of children) {
    if (typeof child.id !== "string") continue;
    if (child.type === "child_data_source") {
      const body = child.child_data_source && typeof child.child_data_source === "object" ? child.child_data_source as Record<string, unknown> : {};
      const title = typeof body.title === "string" ? body.title : "Untitled data source";
      resources.push({ ref: { id: child.id, type: "data_source", title, parentTitle: page.ref.title }, object: { object: "data_source", id: child.id, title: [{ plain_text: title }] } });
    }
    if (child.type === "child_database") {
      const database = await (deps.database ?? notionOps.database)(userId, child.id);
      const resource = resourceFromObject(database, page.ref.title);
      if (resource) resources.push(resource, ...databaseDataSources(database, page.ref.title));
    }
  }
  return resources;
}

function bestMatches(query: string, resources: ResolvedNotionResource[]): ResolvedNotionResource[] {
  const ranked = resources
    .map((resource) => ({ resource, score: scoreTitle(query, resource.ref.title) }))
    .filter((candidate): candidate is { resource: ResolvedNotionResource; score: number } => candidate.score !== null)
    .sort((a, b) => a.score - b.score);
  if (!ranked.length) return [];
  const best = ranked[0]!.score;
  return ranked.filter((candidate) => candidate.score === best).map((candidate) => candidate.resource);
}

/** Resolve only content returned by authorised Notion endpoints. */
export async function resolveNotionResource(
  userId: string,
  target: string,
  deps: NotionResourceResolverDeps = {},
): Promise<NotionResourceResolution> {
  const explicitId = explicitNotionId(target);
  if (explicitId) {
    for (const load of [deps.dataSource ?? notionOps.dataSource, deps.database ?? notionOps.database]) {
      try {
        const object = await load(userId, explicitId);
        const resource = resourceFromObject(object);
        if (resource) return { kind: "resolved", resource };
      } catch {
        // Try the next accessible object type. Provider errors are surfaced if title search also fails.
      }
    }
  }

  const searched = await (deps.search ?? notionOps.search)(userId, { query: target, page_size: RESOURCE_LIMIT });
  const direct = searched.flatMap((object) => {
    const resource = resourceFromObject(object);
    return resource ? [resource] : [];
  });
  let matches = bestMatches(target, direct);
  if (matches.length === 1) return { kind: "resolved", resource: matches[0]! };
  if (matches.length > 1) return { kind: "ambiguous", candidates: matches.slice(0, 5) };

  const pages = direct.filter((resource) => resource.ref.type === "page");
  const nested = (await Promise.all(pages.slice(0, 10).map((page) => childrenAsResources(userId, page, deps)))).flat();
  matches = bestMatches(target, nested);
  if (matches.length === 1) return { kind: "resolved", resource: matches[0]! };
  if (matches.length > 1) return { kind: "ambiguous", candidates: matches.slice(0, 5) };
  return { kind: "missing" };
}

/** Convert a database or containing page into the current queryable data source. */
export async function resolveQueryableDataSource(
  userId: string,
  resource: ResolvedNotionResource,
  deps: NotionResourceResolverDeps = {},
): Promise<NotionResourceResolution> {
  if (resource.ref.type === "data_source") return { kind: "resolved", resource };
  let candidates: ResolvedNotionResource[] = [];
  if (resource.ref.type === "database") {
    const database = resource.object.data_sources ? resource.object : await (deps.database ?? notionOps.database)(userId, resource.ref.id);
    candidates = databaseDataSources(database, resource.ref.title);
  } else {
    candidates = (await childrenAsResources(userId, resource, deps)).filter((candidate) => candidate.ref.type === "data_source");
    if (!candidates.length) {
      const databases = (await childrenAsResources(userId, resource, deps)).filter((candidate) => candidate.ref.type === "database");
      for (const databaseResource of databases) {
        const database = databaseResource.object.data_sources ? databaseResource.object : await (deps.database ?? notionOps.database)(userId, databaseResource.ref.id);
        candidates.push(...databaseDataSources(database, resource.ref.title));
      }
    }
  }
  if (candidates.length === 1) return { kind: "resolved", resource: candidates[0]! };
  if (candidates.length > 1) return { kind: "ambiguous", candidates: candidates.slice(0, 5) };
  return { kind: "missing" };
}
