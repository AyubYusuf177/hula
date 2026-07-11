/**
 * Static, typed configuration for the Integrations screen (Section 13).
 *
 * This is the reusable shape every future integration plugs into: supply a
 * provider id, display metadata, an icon + accent, and the copy for the card and
 * details sheet. The screen renders entirely from this data + the backend status
 * — nothing is hardcoded around Google Calendar beyond this entry.
 *
 * IMPORTANT: copy here must stay honest about current READ-ONLY capability. Do
 * not claim create/edit/delete for Google Calendar.
 */

import type { ImageSourcePropType } from 'react-native';

import { integrationIcons } from '@/constants/images';
import { GOOGLE_CALENDAR_PROVIDER } from '@/lib/hulaApi';

/** A display category grouping on the Integrations screen. */
export type IntegrationCategoryId = 'ORGANIZATION';

/** Everything the UI needs to render one integration end-to-end. */
export interface IntegrationProviderConfig {
  /** Backend provider slug (must match the catalog, e.g. "google_calendar"). */
  id: string;
  displayName: string;
  category: IntegrationCategoryId;
  /** Real product icon (PNG) shown in the card, hero orbit, and details sheet. */
  iconImage: ImageSourcePropType;
  /** Accent color used for the connected glow/border and the icon badge. */
  accent: string;
  /** One-line capability summary shown on the card. */
  summary: string;
  /** Details sheet heading while DISCONNECTED. */
  sheetHeading: string;
  /** Details sheet heading once CONNECTED (honest, backend-confirmed). */
  connectedHeading: string;
  /** Details sheet body paragraph while disconnected. */
  sheetBody: string;
  /** Details sheet body once connected — describes what is enabled today. */
  connectedBody: string;
  /** Short privacy reassurance shown in the sheet. */
  privacyNote: string;
  /** Capabilities available today (read-only). */
  capabilities: string[];
  /** Capabilities planned for later (clearly not enabled yet). */
  comingLater: string[];
  /** Honest limitation line for the sheet. */
  limitation: string;
  /** Primary connect button label. */
  connectLabel: string;
  /** Label once connected. */
  disconnectLabel: string;
}

export const INTEGRATION_CATEGORY_LABELS: Record<IntegrationCategoryId, string> = {
  ORGANIZATION: 'Organization',
};

export const INTEGRATION_PROVIDERS: readonly IntegrationProviderConfig[] = [
  {
    id: GOOGLE_CALENDAR_PROVIDER,
    displayName: 'Google Calendar',
    category: 'ORGANIZATION',
    iconImage: integrationIcons.google_calendar,
    accent: '#5CA8FF',
    summary: 'Read your upcoming events and answer calendar questions from iMessage.',
    sheetHeading: 'Connect Google Calendar',
    connectedHeading: 'Google Calendar connected',
    sheetBody:
      'Connect your Google Calendar so Hula can read your schedule and answer calendar questions directly from iMessage.',
    connectedBody:
      'Hula can now read your upcoming events and answer calendar questions right from iMessage. Read-only for now — it never changes your calendar.',
    privacyNote:
      'Your Google tokens stay encrypted on Hula’s server and are never stored in the mobile app.',
    capabilities: [
      'Read your upcoming events',
      'Answer calendar questions from iMessage',
      'Find your next meeting',
    ],
    comingLater: [
      'Create events after confirmation',
      'Reschedule meetings',
      'Meeting preparation',
    ],
    limitation: 'Calendar creation and editing are not enabled yet.',
    connectLabel: 'Connect Google',
    disconnectLabel: 'Disconnect Google Calendar',
  },
] as const;

/** Fast lookup of a provider config by id. */
export function getIntegrationProvider(
  id: string,
): IntegrationProviderConfig | undefined {
  return INTEGRATION_PROVIDERS.find((p) => p.id === id);
}

/** Providers grouped by category, preserving catalog order. */
export function integrationsByCategory(): {
  category: IntegrationCategoryId;
  label: string;
  providers: IntegrationProviderConfig[];
}[] {
  const groups: IntegrationCategoryId[] = ['ORGANIZATION'];
  return groups.map((category) => ({
    category,
    label: INTEGRATION_CATEGORY_LABELS[category],
    providers: INTEGRATION_PROVIDERS.filter((p) => p.category === category),
  }));
}
