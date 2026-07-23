import { AnthropicClientError } from "../../../ai/anthropicClient";

export type OutlookModelStage =
  | "intent_generation"
  | "intent_parse"
  | "analysis_generation"
  | "analysis_parse";

export type OutlookModelFailureClassification =
  | "timeout"
  | "provider_error"
  | "malformed"
  | "empty_response"
  | "unknown";

export interface OutlookModelDiagnostic {
  stage: OutlookModelStage;
  classification: OutlookModelFailureClassification;
}

export interface ClassifiedOutlookModelFailure extends OutlookModelDiagnostic {
  retryable: boolean;
}

function numericStatus(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const candidate = error as { status?: unknown; statusCode?: unknown };
  const value = typeof candidate.status === "number" ? candidate.status : candidate.statusCode;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function classifyOutlookModelFailure(
  error: unknown,
  stage: OutlookModelStage,
): ClassifiedOutlookModelFailure {
  if (error instanceof AnthropicClientError) {
    if (error.reason === "timeout") return { stage, classification: "timeout", retryable: true };
    if (error.reason === "empty_response") return { stage, classification: "empty_response", retryable: false };
    if (error.reason === "rate_limited" || error.reason === "network_error") {
      return { stage, classification: "provider_error", retryable: true };
    }
    if (error.reason === "provider_error") {
      return {
        stage,
        classification: "provider_error",
        retryable: error.status === undefined || error.status === 429 || error.status >= 500,
      };
    }
    if (error.reason === "malformed_response") {
      return { stage, classification: "malformed", retryable: true };
    }
    return { stage, classification: "provider_error", retryable: false };
  }

  const status = numericStatus(error);
  if (status === 429 || (status !== null && status >= 500)) {
    return { stage, classification: "provider_error", retryable: true };
  }
  if (error instanceof Error) {
    if (/timeout|timed out|abort/i.test(`${error.name} ${error.message}`)) {
      return { stage, classification: "timeout", retryable: true };
    }
    if (/empty response|empty reply/i.test(error.message)) {
      return { stage, classification: "empty_response", retryable: false };
    }
    if (/network|fetch failed|socket|econn|enotfound/i.test(error.message)) {
      return { stage, classification: "provider_error", retryable: true };
    }
  }
  return { stage, classification: "unknown", retryable: false };
}
