/**
 * Hula app-wide visual design language.
 *
 * This is NOT onboarding-only — it defines the ambient dark/glassy Hula look
 * (colors, glow, glass, buttons, motion) used across the whole app. Onboarding
 * layout values live under `hula.onboarding`.
 */

export const hula = {
  /* ── Core palette ─────────────────────────────────────────── */
  colors: {
    // Deep space background is never one flat color — these are layered.
    voidBlack: '#04050B',
    baseNavy: '#080A16',
    deepNavy: '#0B1020',
    purpleUndertone: '#170D33',
    blueUndertone: '#0A1636',

    ink: '#02030A', // darkest, used for orb core + vignette edges

    text: {
      primary: '#F6F8FF',
      secondary: '#C2CAE0',
      tertiary: '#8B93AA',
      faint: '#5B637C',
      hint: '#9A8CFF', // muted purple "swipe up to enter"
    },
  },

  /* ── Glow / bloom colors (soft, blurred, layered) ─────────── */
  glow: {
    purple: '#7B4DFF',
    purpleBright: '#A98BFF',
    iris: '#6F5BFF',
    blue: '#3E7BFF',
    blueBright: '#6FB4FF',
    sky: '#5CA8FF',
    white: '#FFFFFF',
    silver: '#DDE4FF',
  },

  /* ── Orb material ─────────────────────────────────────────── */
  orb: {
    coreOuter: '#0A0C18',
    coreInner: '#05060E',
    rimLeft: '#B48CFF', // lower-left purple rim light
    rimRight: '#67AEFF', // lower-right blue rim light
    highlight: '#EAF0FF', // upper-left glossy specular
  },

  /* ── Glass surfaces ───────────────────────────────────────── */
  glass: {
    card: 'rgba(18, 22, 44, 0.55)',
    cardBorder: 'rgba(150, 160, 210, 0.16)',
    tile: 'rgba(20, 24, 48, 0.6)',
    tileBorder: 'rgba(150, 160, 210, 0.18)',
    blurIntensity: 24,
  },

  /* ── Status treatments (connection state) ─────────────────────
     A restrained, enterprise-grade success treatment (soft emerald —
     never red) plus a warm amber for "needs attention". Used by the
     integration cards + details sheet so connection state reads
     premium and consistent, independent of a provider's brand color. */
  status: {
    success: '#4BD6A6', // soft emerald "Connected" text / icon
    successDot: '#3FD0A8',
    successBg: 'rgba(63, 208, 168, 0.12)',
    successBorder: 'rgba(63, 208, 168, 0.32)',
    successGlow: 'rgba(63, 208, 168, 0.22)',
    attention: '#F0A868', // amber: expired / retry
    attentionBg: 'rgba(240, 168, 104, 0.10)',
    attentionBorder: 'rgba(240, 168, 104, 0.42)',
  },

  /* ── Buttons ──────────────────────────────────────────────── */
  button: {
    height: 60,
    radius: 30,
    solidBg: '#FFFFFF',
    solidText: '#0A0A0F',
    outlineText: '#F6F8FF',
    gradientBorder: ['#B06BFF', '#5C8CFF'] as const,
  },

  /* ── Radii ────────────────────────────────────────────────── */
  radius: {
    tile: 30,
    card: 34,
    button: 30,
    pill: 999,
  },

  /* ── Spacing (onboarding rhythm) ─────────────────────────── */
  spacing: {
    xs: 4,
    sm: 8,
    md: 12,
    lg: 16,
    xl: 24,
    '2xl': 32,
    '3xl': 44,
  },

  /* ── Typography ───────────────────────────────────────────── */
  typography: {
    fontFamily: {
      regular: 'Poppins_400Regular',
      medium: 'Poppins_500Medium',
      semiBold: 'Poppins_600SemiBold',
      bold: 'Poppins_700Bold',
    },
    hero: { fontSize: 40, lineHeight: 46 },
    title: { fontSize: 42, lineHeight: 48 },
    button: { fontSize: 17, lineHeight: 22 },
    hint: { fontSize: 16, lineHeight: 22 },
    legal: { fontSize: 13, lineHeight: 20 },
  },

  /* ── Onboarding layout (fractions of screen W/H) ──────────── */
  onboarding: {
    // Orb geometry per progress stop: [hero(0), transition(0.5), auth(1)]
    orb: {
      centerYFrac: [0.9, 0.4, 0.205] as const,
      radiusWFrac: [0.86, 0.4, 0.135] as const,
      // orb stays fully opaque until the logo tile takes over, then fades
      opacityStops: [0, 0.5, 0.78, 1] as const,
      opacityValues: [1, 1, 0.9, 0] as const,
    },
    logo: {
      centerYFrac: 0.205,
      tileSizeWFrac: 0.31,
      // tile/ring only appear late in the swipe, around the shrinking orb
      opacityStops: [0.62, 0.86, 1] as const,
      opacityValues: [0, 0.55, 1] as const,
    },
    hero: {
      headlineTopFrac: 0.2,
      hintTopFrac: 0.42,
    },
    content: {
      titleTopFrac: 0.31,
      cardTopFrac: 0.47,
    },
  },

  /* ── Motion ───────────────────────────────────────────────── */
  motion: {
    // Fraction of screen height a full 0→1 swipe travels.
    swipeDistanceFrac: 0.55,
    // Progress past which a released swipe completes to auth.
    completeThreshold: 0.35,
    velocityThreshold: 650,
    spring: {
      damping: 18,
      stiffness: 120,
      mass: 0.9,
    },
  },
} as const;

export type Hula = typeof hula;
