/** Plain text safe for iMessage/SMS. Provider strings never control formatting. */
export function asanaPlainText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/\r/g, "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(?:nbsp|#160);/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\[([^\]]+)]\([^\s)]+\)/g, "$1")
    .replace(/`{1,3}/g, "")
    .replace(/\*\*|__/g, "")
    .split("\n")
    .map((line) => line.replace(/^\s{0,3}#{1,6}\s+/, "").replace(/^\s*[-*+]\s+/, "").replace(/\s*\|\s*/g, " · ").trim())
    .filter(Boolean)
    .join("; ")
    .replace(/\s+/g, " ")
    .trim();
}

export function hasMarkdownSyntax(value: string): boolean {
  return /\*\*|__|`|(?:^|\n)\s{0,3}#{1,6}\s|(?:^|\n)\s*[-*+]\s|\|/.test(value);
}
