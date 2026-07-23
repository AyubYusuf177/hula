export const OUTLOOK_BODY_MAX = 12_000;

const ENTITIES: Record<string, string> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: '"',
};

function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower.startsWith("#x")) {
      const code = Number.parseInt(lower.slice(2), 16);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    }
    if (lower.startsWith("#")) {
      const code = Number.parseInt(lower.slice(1), 10);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    }
    return ENTITIES[lower] ?? match;
  });
}

/** Convert provider HTML/text to bounded readable text without executable markup. */
export function normalizeOutlookBody(
  content: string | null | undefined,
  contentType: string | null | undefined,
): string {
  if (!content) return "";
  let value = content.replace(/\u0000/g, "");
  if ((contentType ?? "").toLowerCase() === "html" || /<\/?[a-z][\s\S]*>/i.test(value)) {
    value = value
      .replace(/<!--([\s\S]*?)-->/g, " ")
      .replace(/<(script|style|noscript|template|svg|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
      .replace(/<img\b[^>]*>/gi, " ")
      .replace(/<(?:br|\/p|\/div|\/li|\/tr|\/h[1-6])\s*\/?>/gi, "\n")
      .replace(/<li\b[^>]*>/gi, "• ")
      .replace(/<[^>]*>/g, " ");
  }
  return decodeEntities(value)
    .replace(/[\t\f\v ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, OUTLOOK_BODY_MAX);
}
