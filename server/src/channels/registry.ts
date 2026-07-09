import type {
  Channel,
  OutboundMessage,
  Provider,
  ProviderEvent,
} from "./types";

/**
 * Channel adapter contract.
 *
 * Every provider (Sendblue first) implements this interface so the Hula brain
 * can send/receive without knowing the vendor. Section 1 defines the contract
 * and an empty registry only — no adapter is implemented yet.
 */
export interface ChannelAdapter {
  provider: Provider;
  channels: Channel[];
  /** Turn a raw provider webhook body into normalized events. */
  parseWebhook(rawBody: unknown): ProviderEvent[];
  /** Serialize and deliver an outbound message via the provider API. */
  send(message: OutboundMessage): Promise<void>;
}

/**
 * In-memory registry of channel adapters. Real adapters register here at boot
 * once implemented. Empty for Section 1.
 */
const adapters = new Map<Provider, ChannelAdapter>();

export function registerChannelAdapter(adapter: ChannelAdapter): void {
  adapters.set(adapter.provider, adapter);
}

export function getChannelAdapter(
  provider: Provider,
): ChannelAdapter | undefined {
  return adapters.get(provider);
}

export function listChannelAdapters(): ChannelAdapter[] {
  return Array.from(adapters.values());
}
