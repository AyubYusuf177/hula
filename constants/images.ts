import hulaLogo from '@/assets/images/hula-logo.png';
import hulaLogoTransparent from '@/assets/images/hula-logo-transparent.png';
import icon from '@/assets/images/icon.png';
import splashIcon from '@/assets/images/splash-icon.png';
import favicon from '@/assets/images/favicon.png';
import googleCalendar from '@/assets/images/integrations/google-calendar.png';

export const images = {
  hulaLogo,
  // Derived transparent Hula mark (surrounding white background removed) for use
  // on dark glass — no white square wrapper.
  hulaLogoTransparent,
  icon,
  splashIcon,
  favicon,
} as const;

/** Integration provider product icons, keyed by backend provider slug. */
export const integrationIcons = {
  google_calendar: googleCalendar,
} as const;
