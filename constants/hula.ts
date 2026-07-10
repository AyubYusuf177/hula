/**
 * Hula's dedicated iMessage line.
 *
 * The "Text hula" flow gets the number back from the backend link-session
 * response, so it never hardcodes it. This constant is the fallback used by the
 * "Add hula to Contacts" flow, which has no backend round trip.
 */
export const HULA_NUMBER = '+16465480761';

/** Human-friendly form shown in the contact card. */
export const HULA_NUMBER_DISPLAY = '+1 (646) 548-0761';

/** Display name used when adding Hula to the user's contacts. */
export const HULA_CONTACT_NAME = 'Hula';
