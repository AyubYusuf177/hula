/**
 * Media / audio placeholder types.
 *
 * Sendblue supports inbound and outbound voice notes, images, and files. These
 * types describe how Hula references and (later) processes that media. Section
 * 1: types only — no download, transcription, or storage is implemented.
 */
export type MediaKind = "audio" | "image" | "file";

export interface StoredMedia {
  id: string;
  kind: MediaKind;
  /** Source URL (provider-hosted). Later mirrored to Hula storage. */
  sourceUrl: string;
  mimeType?: string;
  sizeBytes?: number;
  createdAt: string; // ISO 8601
}

/** Inbound voice note placeholder, including transcription slot. */
export interface VoiceNote extends StoredMedia {
  kind: "audio";
  durationSeconds?: number;
  /** Filled in later by a transcription step. */
  transcript?: string;
}
