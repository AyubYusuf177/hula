export type OutlookSubjectSource = "explicit" | "model" | "fallback";

export interface CompletedOutlookSubject {
  subject: string;
  source: OutlookSubjectSource;
}

const MAX_SUBJECT_LENGTH = 72;
const MAX_SUBJECT_WORDS = 9;

function cleanSubject(value: string): string {
  return value
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 998);
}

/**
 * Deterministic, extractive fallback for when semantic intent extraction did not
 * supply a subject. It only reuses words from the user's requested body, so it
 * cannot fabricate a person, date, commitment, or topic.
 */
export function fallbackOutlookSubject(body: string): string {
  const normalized = body
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/\b[^\s@]+@[^\s@]+\.[^\s@]+\b/gi, "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return "";

  const firstThought = normalized.split(/(?<=[.!?])\s+/u)[0] ?? normalized;
  const words = firstThought
    .replace(/^[“"'([{]+|[”"')\]}]+$/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, MAX_SUBJECT_WORDS);
  let subject = words.join(" ").replace(/[.!?,;:—-]+$/g, "").trim();
  if (subject.length > MAX_SUBJECT_LENGTH) {
    subject = subject.slice(0, MAX_SUBJECT_LENGTH).replace(/\s+\S*$/, "").trim();
  }
  return subject;
}

/**
 * Composition boundary for NEW Outlook mail only.
 *
 * An explicit subject is preserved exactly (apart from transport-safe whitespace
 * and Graph's documented length bound). A model-inferred subject is accepted only
 * when non-empty. If intent generation omitted one or failed, the fallback is
 * extractive and grounded in the body.
 */
export function completeOutlookSubject(input: {
  body: string;
  subject?: string | null;
  subjectWasExplicit?: boolean;
}): CompletedOutlookSubject | null {
  const supplied = cleanSubject(input.subject ?? "");
  if (supplied) {
    return {
      subject: supplied,
      source: input.subjectWasExplicit === true ? "explicit" : "model",
    };
  }
  const fallback = cleanSubject(fallbackOutlookSubject(input.body));
  return fallback ? { subject: fallback, source: "fallback" } : null;
}
