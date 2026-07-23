const MAX_STRUCTURED_REPLY_CHARS = 30_000;

export function structuredRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** Normalize model enum spellings without interpreting the user's prose. */
export function structuredToken(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  return normalized || null;
}

export function structuredBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  const token = structuredToken(value);
  if (token === "true" || token === "yes") return true;
  if (token === "false" || token === "no") return false;
  return null;
}

export function structuredInteger(value: unknown, min: number, max: number): number | null {
  const numeric = typeof value === "number"
    ? value
    : typeof value === "string" && /^\d+$/.test(value.trim())
      ? Number(value.trim())
      : NaN;
  if (!Number.isInteger(numeric) || numeric < min || numeric > max) return null;
  return numeric;
}

/** Accept a model's safe single-value/list representation; schema validation follows. */
export function structuredStringList(value: unknown): unknown[] | null {
  if (value === null || value === undefined) return null;
  const source = Array.isArray(value) ? value : [value];
  return source.map((item) => {
    if (typeof item === "string") return item.trim();
    const record = structuredRecord(item);
    const nested = structuredRecord(record?.emailAddress);
    return record?.address ?? record?.email ?? nested?.address ?? item;
  });
}

/**
 * Return balanced JSON-object candidates from bounded model text.
 *
 * Models sometimes wrap valid JSON in prose or a Markdown fence. Scanning balanced
 * objects is stricter than taking everything between the first and last brace and
 * still leaves schema validation to the caller.
 */
export function structuredJsonObjectCandidates(raw: string): unknown[] {
  const value = raw.slice(0, MAX_STRUCTURED_REPLY_CHARS);
  const candidates: unknown[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") {
      if (depth === 0) start = index;
      depth += 1;
      continue;
    }
    if (char !== "}" || depth === 0) continue;
    depth -= 1;
    if (depth !== 0 || start < 0) continue;
    try {
      candidates.push(JSON.parse(value.slice(start, index + 1)) as unknown);
    } catch {
      // Keep scanning: a later fenced object may still be valid.
    }
    start = -1;
  }

  return candidates;
}
