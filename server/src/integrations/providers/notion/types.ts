export const NOTION_PROVIDER = "notion" as const;
export const NOTION_API_BASE = "https://api.notion.com/v1";
export const NOTION_API_VERSION = "2026-03-11";

export type NotionObject = Record<string, unknown> & { object?: string; id?: string };
export interface NotionList<T extends NotionObject = NotionObject> {
  object: "list";
  results: T[];
  has_more: boolean;
  next_cursor: string | null;
}
export type NotionCapability =
  | "content.read" | "content.write" | "users.read"
  | "comments.read" | "comments.write" | "files.read" | "files.write";

