import hulaLogo from '@/assets/images/hula-logo.png';
import hulaLogoTransparent from '@/assets/images/hula-logo-transparent.png';
import icon from '@/assets/images/icon.png';
import splashIcon from '@/assets/images/splash-icon.png';
import favicon from '@/assets/images/favicon.png';
import googleCalendar from '@/assets/images/integrations/google-calendar.png';
import gmail from '@/assets/images/integrations/gmail.png';
import todoist from '@/assets/images/integrations/todoist.png';

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
  gmail,
  // Official Todoist icon from Doist's own brand kit (doist.com/brand-assets/
  // todoist-logo.zip → Icon/Color.png), resampled 1000px → 512px to match the
  // other product icons. Not redrawn or recoloured.
  todoist,
} as const;
