import { randomUUID } from "node:crypto";

import type {
  Channel,
  InboundMessage,
  MediaAttachment,
  MessageContent,
  MessageContentType,
  ProviderEvent,
  ProviderEventType,
} from "../types";
import type { SendblueInboundWebhook } from "./types";

/**
 * Sendblue normalization.
 *
 * This is the boundary where Sendblue's raw webhook payloads become
 * channel-agnostic Hula types. Everything is defensive: fields may be missing,
 * mistyped, or of a different shape than documented, and normalization must
 * never throw. Media/audio URLs are preserved as attachments (no download or
 * transcription happens here — that arrives in a later section).
 */

const IMAGE_EXTENSIONS = ["jpg", "jpeg", "png", "gif", "webp", "heic", "heif", "bmp"];
const AUDIO_EXTENSIONS = ["mp3", "m4a", "caf", "amr", "wav", "aac", "ogg", "opus"];

/** Best-effort guess of an attachment kind from its URL extension. */
function guessAttachmentType(url: string): MediaAttachment["type"] {
  const clean = url.split("?")[0]?.toLowerCase() ?? "";
  const ext = clean.includes(".") ? clean.slice(clean.lastIndexOf(".") + 1) : "";
  if (AUDIO_EXTENSIONS.includes(ext)) return "audio";
  if (IMAGE_EXTENSIONS.includes(ext)) return "image";
  return "file";
}

/**
 * Collect every media URL the payload might carry, across the various shapes
 * Sendblue (and providers generally) use: `media_url`, `media_urls`, `media`,
 * or `attachments`. Returns a de-duplicated list of non-empty strings.
 */
function collectMediaUrls(payload: SendblueInboundWebhook): string[] {
  const urls: string[] = [];

  const pushIfUrl = (value: unknown): void => {
    if (typeof value === "string" && value.trim().length > 0) {
      urls.push(value.trim());
    } else if (value && typeof value === "object") {
      // Handle `{ url: "..." }` style attachment objects.
      const maybe = (value as { url?: unknown }).url;
      if (typeof maybe === "string" && maybe.trim().length > 0) {
        urls.push(maybe.trim());
      }
    }
  };

  pushIfUrl(payload.media_url);

  if (Array.isArray(payload.media_urls)) {
    payload.media_urls.forEach(pushIfUrl);
  }
  if (Array.isArray(payload.media)) {
    payload.media.forEach(pushIfUrl);
  } else {
    pushIfUrl(payload.media);
  }
  if (Array.isArray(payload.attachments)) {
    payload.attachments.forEach(pushIfUrl);
  }

  return Array.from(new Set(urls));
}

/** Safely read a dotted path (e.g. "data.from_number") from an unknown value. */
function readPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc && typeof acc === "object") {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}

/** Return the first non-empty string found across the given candidate paths. */
function firstString(obj: unknown, paths: string[]): string | undefined {
  for (const path of paths) {
    const value = readPath(obj, path);
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

/**
 * Candidate paths for the inbound sender (the end user we must reply TO).
 * `number` is intentionally last: on Sendblue inbound payloads `number` is the
 * Hula line, so it is only a last resort if no explicit "from" field exists.
 */
const SENDER_PATHS = [
  "from_number",
  "from",
  "sender",
  "phone_number",
  "message.from_number",
  "message.from",
  "data.from_number",
  "data.from",
  "contact.phone_number",
  "number",
];

/** Candidate paths for the recipient/Hula line the message was sent to. */
const RECIPIENT_PATHS = [
  "to_number",
  "to",
  "recipient",
  "line",
  "data.to_number",
  "data.to",
  "number",
];

/** Reduce a handle to bare digits for comparison/validation. */
export function digitsOf(handle: string): string {
  return handle.replace(/[^0-9]/g, "");
}

/**
 * True when a handle is missing, empty, "unknown", or an obvious
 * placeholder/test number (e.g. +10000000000). Used to avoid ever calling
 * Sendblue for a recipient that clearly isn't a real user.
 */
export function isPlaceholderHandle(handle: string | undefined | null): boolean {
  if (!handle) return true;
  const trimmed = handle.trim();
  if (trimmed.length === 0 || trimmed.toLowerCase() === "unknown") return true;

  const digits = digitsOf(trimmed);
  if (digits.length < 7) return true; // too short to be a real phone number
  if (/^0+$/.test(digits)) return true; // all zeros
  if (/0{7,}/.test(digits)) return true; // long zero run, e.g. +10000000000
  if (/^(\d)\1+$/.test(digits)) return true; // all identical digits
  return false;
}

/** Extract the inbound sender handle from the payload, if present. */
export function extractSenderHandle(
  payload: SendblueInboundWebhook,
): string | undefined {
  return firstString(payload, SENDER_PATHS);
}

/** Extract the recipient/Hula line handle from the payload, if present. */
export function extractRecipientHandle(
  payload: SendblueInboundWebhook,
): string | undefined {
  return firstString(payload, RECIPIENT_PATHS);
}

/** Map Sendblue's `service` string onto Hula's logical channel. */
function toChannel(payload: SendblueInboundWebhook): Channel {
  return payload.service === "SMS" ? "sms" : "imessage";
}

/** Build the neutral MessageContent from text + any media attachments. */
function toContent(
  text: string | undefined,
  attachments: MediaAttachment[],
): MessageContent {
  const trimmed = typeof text === "string" ? text.trim() : "";

  let type: MessageContentType = "text";
  if (trimmed.length === 0 && attachments.length > 0) {
    // Lead with the first attachment's kind when there's no text.
    type = attachments[0]!.type;
  }

  return {
    type,
    ...(trimmed.length > 0 ? { text: trimmed } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
  };
}

/**
 * Normalize a raw Sendblue inbound webhook into Hula's InboundMessage. Never
 * throws — missing fields are filled with safe fallbacks.
 */
export function normalizeSendblueInbound(
  payload: SendblueInboundWebhook,
): InboundMessage {
  const mediaUrls = collectMediaUrls(payload);
  const attachments: MediaAttachment[] = mediaUrls.map((url) => ({
    type: guessAttachmentType(url),
    url,
  }));

  const providerMessageId =
    typeof payload.message_handle === "string" && payload.message_handle.length > 0
      ? payload.message_handle
      : `sb_${randomUUID()}`;

  const senderHandle = extractSenderHandle(payload) ?? "unknown";
  const recipientHandle = extractRecipientHandle(payload) ?? "";

  return {
    providerMessageId,
    channel: toChannel(payload),
    provider: "sendblue",
    senderHandle,
    recipientHandle,
    content: toContent(payload.content, attachments),
    isIMessage: payload.service === "iMessage",
    receivedAt:
      typeof payload.date_sent === "string" && payload.date_sent.length > 0
        ? payload.date_sent
        : new Date().toISOString(),
  };
}

/**
 * Decide whether a webhook payload represents a genuine inbound user message
 * (as opposed to an outbound delivery/read status callback for a message Hula
 * itself sent).
 */
export function isInboundUserMessage(payload: SendblueInboundWebhook): boolean {
  if (payload.is_outbound === true) return false;
  const hasText =
    typeof payload.content === "string" && payload.content.trim().length > 0;
  const hasMedia = collectMediaUrls(payload).length > 0;
  return hasText || hasMedia;
}

/** Classify a Sendblue payload into a Hula ProviderEventType. */
function classifyEvent(payload: SendblueInboundWebhook): ProviderEventType {
  if (isInboundUserMessage(payload)) return "inbound_message";
  if (payload.is_outbound === true) {
    return payload.status === "READ" ? "read_status" : "delivery_status";
  }
  return "unknown";
}

/**
 * Normalize a raw Sendblue webhook into a channel-agnostic ProviderEvent. For
 * inbound user messages the `inbound` field is populated; other event kinds are
 * classified but left minimal (Section 2 only reacts to inbound messages).
 */
export function normalizeSendblueEvent(
  payload: SendblueInboundWebhook,
): ProviderEvent {
  const type = classifyEvent(payload);

  return {
    type,
    provider: "sendblue",
    channel: toChannel(payload),
    receivedAt: new Date().toISOString(),
    ...(type === "inbound_message"
      ? { inbound: normalizeSendblueInbound(payload) }
      : {}),
  };
}
