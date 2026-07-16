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
import { ASANA_PROVIDER, GMAIL_PROVIDER, GOOGLE_CALENDAR_PROVIDER, TODOIST_PROVIDER } from '@/lib/hulaApi';

/** A display category grouping on the Integrations screen. */
export type IntegrationCategoryId = 'ORGANIZATION';

/** Everything the UI needs to render one integration end-to-end. */
export interface IntegrationProviderConfig {
  /** Backend provider slug (must match the catalog, e.g. "google_calendar"). */
  id: string;
  displayName: string;
  category: IntegrationCategoryId;
  /** Real product icon (PNG) shown in the card and details sheet. */
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
  /** Primary connect button label. */
  connectLabel: string;
  /** Brand named in the OAuth redirect disclosure. Required to prevent provider-copy drift. */
  authorizationProviderLabel: string;
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
    summary: 'Reads your schedule to answer calendar questions.',
    sheetHeading: 'Google Calendar',
    connectedHeading: 'Google Calendar',
    sheetBody:
      'Connect your Google Calendar to answer scheduling questions right from iMessage. Read-only — Hula never changes your calendar.',
    connectedBody:
      'Hula can read your schedule and answer calendar questions from iMessage. Read-only — it never changes your calendar.',
    connectLabel: 'Connect Google',
    authorizationProviderLabel: 'Google',
    disconnectLabel: 'Disconnect Google Calendar',
  },
  {
    id: GMAIL_PROVIDER,
    displayName: 'Gmail',
    category: 'ORGANIZATION',
    iconImage: integrationIcons.gmail,
    accent: '#EA4335',
    summary: 'Reads your inbox to answer email questions.',
    sheetHeading: 'Gmail',
    connectedHeading: 'Gmail',
    sheetBody:
      'Connect Gmail to answer email questions right from iMessage. Read-only — Hula never sends, deletes or changes your email.',
    connectedBody:
      'Hula can read and search your inbox to answer email questions from iMessage. Read-only — it never sends, deletes or changes your email.',
    connectLabel: 'Connect Gmail',
    authorizationProviderLabel: 'Google',
    disconnectLabel: 'Disconnect Gmail',
  },
  {
    id: TODOIST_PROVIDER,
    displayName: 'Todoist',
    category: 'ORGANIZATION',
    iconImage: integrationIcons.todoist,
    // Todoist's own brand red, from the official icon.
    accent: '#E44332',
    // Copy describes REAL, shipped capability. Todoist is the first integration
    // where Hula both reads and writes, so — unlike the read-only Calendar/Gmail
    // copy — it says so plainly, including the parts that ask first.
    summary: 'Reads and manages your tasks from iMessage.',
    sheetHeading: 'Todoist',
    connectedHeading: 'Todoist',
    sheetBody:
      'Connect Todoist to run your task list from iMessage. Hula can tell you what’s due, overdue or coming up, and add, reschedule, re-prioritise, complete and reopen tasks. Deleting a task, or changing several at once, always asks you first.',
    connectedBody:
      'Hula can read your tasks and add, edit, reschedule, move, complete and reopen them from iMessage. Deleting a task, or changing several at once, always asks you first.',
    connectLabel: 'Connect Todoist',
    authorizationProviderLabel: 'Todoist',
    disconnectLabel: 'Disconnect Todoist',
  },
  {
    id: ASANA_PROVIDER,
    displayName: 'Asana',
    category: 'ORGANIZATION',
    iconImage: integrationIcons.asana,
    accent: '#F06A6A',
    summary: 'Reads and safely manages your team’s work from iMessage.',
    sheetHeading: 'Asana',
    connectedHeading: 'Asana',
    sheetBody: 'Connect Asana to find your work and safely manage tasks, projects and portfolios from iMessage. Hula asks before changes that notify people or can’t be undone.',
    connectedBody: 'Hula can find and manage authorised Asana work from iMessage. Goals and logged time are view-only, and Hula asks before shared or permanent changes.',
    connectLabel: 'Connect Asana',
    authorizationProviderLabel: 'Asana',
    disconnectLabel: 'Disconnect Asana',
  },
] as const;

/** Fast lookup of a provider config by id. */
export function getIntegrationProvider(
  id: string,
): IntegrationProviderConfig | undefined {
  return INTEGRATION_PROVIDERS.find((p) => p.id === id);
}

/** Provider-owned OAuth disclosure; never hardcode one provider in the shared sheet. */
export const authorizationRedirectCopy = (provider: IntegrationProviderConfig): string =>
  `You’ll be redirected to ${provider.authorizationProviderLabel} to authorize access.`;

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
