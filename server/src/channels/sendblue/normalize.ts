import type { InboundMessage, ProviderEvent } from "../types";
import type { SendblueInboundWebhook } from "./types";

/**
 * Sendblue normalization placeholders.
 *
 * These functions define the boundary where Sendblue's payloads become
 * channel-agnostic Hula types. Section 1 intentionally leaves the bodies
 * unimplemented — signatures only — so no real Sendblue logic runs yet.
 */

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function normalizeSendblueInbound(
  _payload: SendblueInboundWebhook,
): InboundMessage {
  throw new Error("normalizeSendblueInbound not implemented (Section 1)");
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function normalizeSendblueEvent(
  _payload: SendblueInboundWebhook,
): ProviderEvent {
  throw new Error("normalizeSendblueEvent not implemented (Section 1)");
}
