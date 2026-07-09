/**
 * Legal / consent placeholder types.
 *
 * Tracks the user's acceptance of legal documents and messaging consent
 * (important for proactive outreach and STOP handling). Section 1: types only —
 * no enforcement, no storage.
 */
export type LegalDocumentType =
  | "terms_of_service"
  | "privacy_policy"
  | "messaging_consent";

export type ConsentStatus = "granted" | "revoked";

export interface LegalConsent {
  id: string;
  clerkUserId: string;
  document: LegalDocumentType;
  /** Version of the document consented to (e.g. "2026-01-01"). */
  documentVersion: string;
  status: ConsentStatus;
  createdAt: string; // ISO 8601
}
