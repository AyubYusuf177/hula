import { logger } from "../../../utils/logger";
import type { OneDriveItem } from "./oneDriveTypes";

const KNOWN_EXTENSIONS = new Set([
  "txt", "md", "markdown", "csv", "json",
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
  "rtf", "odt", "ods", "odp",
  "jpg", "jpeg", "png", "gif", "webp", "heic", "svg",
]);

const MIN_WEAK_MATCH_SCORE = 60;
const STRONG_MATCH_SCORE = 90;

export type OneDriveMatchStrategy =
  | "exact_filename"
  | "exact_basename"
  | "normalized_name"
  | "strong_tokens";

export interface OneDriveRankedCandidate {
  item: OneDriveItem;
  score: number;
  strategy: OneDriveMatchStrategy;
}

export interface OneDriveNamedDiscovery {
  item: OneDriveItem | null;
  ambiguous: OneDriveItem[];
  source: "search" | "root_listing" | "folder_listing" | "none";
  matchStrategy: OneDriveMatchStrategy | "none";
  searchResultCount: number;
  fallbackResultCount: number;
}

interface OneDriveListResult {
  items: OneDriveItem[];
  hasMore: boolean;
}

function canonical(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function literal(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function trimKnownExtension(value: string): string | null {
  const match = /\.([a-z0-9]{1,12})$/i.exec(value.trim());
  if (!match || !KNOWN_EXTENSIONS.has(match[1]!.toLowerCase())) return null;
  return value.slice(0, match.index).trim();
}

function nameVariants(value: string): string[] {
  const variants: string[] = [];
  let current = value.trim();
  for (let index = 0; index < 3 && current; index += 1) {
    const normalized = literal(current);
    if (normalized && !variants.includes(normalized)) variants.push(normalized);
    const trimmed = trimKnownExtension(current);
    if (!trimmed || trimmed === current) break;
    current = trimmed;
  }
  return variants;
}

/**
 * Remove only boundary language introduced by a natural file request. Words in
 * the middle of a real filename are preserved.
 */
export function normalizeOneDriveRequestedName(value: string): string {
  let name = value
    .normalize("NFKC")
    .trim()
    .replace(/^[\s"'“”‘’]+|[\s"'“”‘’?!.,:;]+$/g, "");
  name = name
    .replace(/^(?:(?:please\s+)?(?:find|search(?:\s+for)?|show(?:\s+me)?|open|pull\s+up|locate|where(?:['’]s| is))\s+)+/i, "")
    .replace(/^(?:my|the|a|an)\s+/i, "")
    .replace(/^(?:one\s*drive|microsoft(?:\s+365)?)\s+(?:(?:file|folder|document|doc)\s+|for\s+)?/i, "")
    .replace(/^(?:file|folder|document|doc)\s+(?:called|named|titled)\s+/i, "")
    .replace(/^(?:called|named|titled)\s+/i, "")
    .replace(/\s+(?:from|in|on)\s+(?:my\s+)?one\s*drive$/i, "")
    .replace(/\s+in\s+(?:(?:this|that|the)\s+folder|it)$/i, "")
    .replace(/\s+(?:file|folder|document|doc)$/i, "")
    .trim();
  return name || value.trim();
}

function tokenScore(query: string, candidate: string): number {
  const queryTokens = canonical(query).split(" ").filter(Boolean);
  const candidateTokens = new Set(canonical(candidate).split(" ").filter(Boolean));
  if (queryTokens.length < 2) return 0;
  const matched = queryTokens.filter((token) => candidateTokens.has(token)).length;
  if (matched !== queryTokens.length) return 0;
  return candidateTokens.size <= queryTokens.length + 3 ? MIN_WEAK_MATCH_SCORE : 0;
}

export function rankOneDriveCandidate(query: string, item: OneDriveItem): OneDriveRankedCandidate | null {
  const requested = normalizeOneDriveRequestedName(query);
  const queryVariants = nameVariants(requested);
  const itemVariants = nameVariants(item.name);
  if (!queryVariants[0] || !itemVariants[0]) return null;
  if (queryVariants[0] === itemVariants[0]) {
    return { item, score: 100, strategy: "exact_filename" };
  }
  if (queryVariants.some((variant) => itemVariants.includes(variant))) {
    return { item, score: STRONG_MATCH_SCORE, strategy: "exact_basename" };
  }
  if (canonical(requested) === canonical(item.name)) {
    return { item, score: 80, strategy: "normalized_name" };
  }
  const score = tokenScore(requested, item.name);
  return score ? { item, score, strategy: "strong_tokens" } : null;
}

export function rankOneDriveCandidates(
  query: string,
  items: OneDriveItem[],
): { item: OneDriveItem | null; ambiguous: OneDriveItem[]; strategy: OneDriveMatchStrategy | "none"; score: number } {
  const deduplicated = new Map<string, OneDriveItem>();
  for (const item of items) deduplicated.set(`${item.driveId}:${item.itemId}`, item);
  const ranked = [...deduplicated.values()]
    .flatMap((item) => rankOneDriveCandidate(query, item) ?? [])
    .sort((left, right) =>
      right.score - left.score ||
      (Date.parse(right.item.modifiedAt ?? "") || 0) - (Date.parse(left.item.modifiedAt ?? "") || 0) ||
      left.item.name.localeCompare(right.item.name),
    );
  const top = ranked[0];
  if (!top || top.score < MIN_WEAK_MATCH_SCORE) {
    return { item: null, ambiguous: [], strategy: "none", score: 0 };
  }
  const tied = ranked.filter((candidate) => candidate.score === top.score);
  if (tied.length > 1) {
    return {
      item: null,
      ambiguous: tied.map((candidate) => candidate.item),
      strategy: top.strategy,
      score: top.score,
    };
  }
  return { item: top.item, ambiguous: [], strategy: top.strategy, score: top.score };
}

export async function discoverOneDriveNamedItem(input: {
  userId: string;
  query: string;
  search: () => Promise<OneDriveListResult>;
  fallback: () => Promise<OneDriveListResult>;
  fallbackSource: "root_listing" | "folder_listing";
}): Promise<OneDriveNamedDiscovery> {
  const requestedName = normalizeOneDriveRequestedName(input.query);
  logger.info("onedrive.discovery started", {
    operation: "named_item",
    hasExtension: Boolean(trimKnownExtension(requestedName)),
  });
  const search = await input.search();
  const rankedSearch = rankOneDriveCandidates(requestedName, search.items);
  logger.info("onedrive.search outcome", {
    resultCount: search.items.length,
    matchStrategy: rankedSearch.strategy,
    strongMatch: rankedSearch.score >= STRONG_MATCH_SCORE,
  });
  if (rankedSearch.score >= STRONG_MATCH_SCORE) {
    logger.info("onedrive.candidate ranked", {
      source: "search",
      resultCount: rankedSearch.item ? 1 : rankedSearch.ambiguous.length,
      matchStrategy: rankedSearch.strategy,
    });
    return {
      item: rankedSearch.item,
      ambiguous: rankedSearch.ambiguous,
      source: "search",
      matchStrategy: rankedSearch.strategy,
      searchResultCount: search.items.length,
      fallbackResultCount: 0,
    };
  }

  const fallback = await input.fallback();
  logger.info("onedrive.fallback listing", {
    source: input.fallbackSource,
    resultCount: fallback.items.length,
  });
  const combined = [...search.items, ...fallback.items];
  const ranked = rankOneDriveCandidates(requestedName, combined);
  logger.info("onedrive.candidate ranked", {
    source: input.fallbackSource,
    resultCount: ranked.item ? 1 : ranked.ambiguous.length,
    matchStrategy: ranked.strategy,
  });
  return {
    item: ranked.item,
    ambiguous: ranked.ambiguous,
    source: ranked.item || ranked.ambiguous.length ? input.fallbackSource : "none",
    matchStrategy: ranked.strategy,
    searchResultCount: search.items.length,
    fallbackResultCount: fallback.items.length,
  };
}
