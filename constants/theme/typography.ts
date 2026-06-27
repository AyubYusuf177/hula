export const fontFamily = {
  regular:  'Poppins_400Regular',
  medium:   'Poppins_500Medium',
  semiBold: 'Poppins_600SemiBold',
  bold:     'Poppins_700Bold',
} as const;

export const typography = {
  h1:         { fontSize: 32, lineHeight: 38, fontWeight: '700' as const },
  h2:         { fontSize: 24, lineHeight: 31, fontWeight: '600' as const },
  h3:         { fontSize: 20, lineHeight: 26, fontWeight: '600' as const },
  h4:         { fontSize: 16, lineHeight: 22, fontWeight: '500' as const },
  bodyLarge:  { fontSize: 16, lineHeight: 26, fontWeight: '400' as const },
  bodyMedium: { fontSize: 14, lineHeight: 22, fontWeight: '400' as const },
  bodySmall:  { fontSize: 13, lineHeight: 21, fontWeight: '400' as const },
  caption:    { fontSize: 11, lineHeight: 15, fontWeight: '400' as const },
} as const;

export const fontSize = {
  h1:         typography.h1.fontSize,
  h2:         typography.h2.fontSize,
  h3:         typography.h3.fontSize,
  h4:         typography.h4.fontSize,
  bodyLarge:  typography.bodyLarge.fontSize,
  bodyMedium: typography.bodyMedium.fontSize,
  bodySmall:  typography.bodySmall.fontSize,
  caption:    typography.caption.fontSize,
} as const;

export const lineHeight = {
  h1:         typography.h1.lineHeight,
  h2:         typography.h2.lineHeight,
  h3:         typography.h3.lineHeight,
  h4:         typography.h4.lineHeight,
  bodyLarge:  typography.bodyLarge.lineHeight,
  bodyMedium: typography.bodyMedium.lineHeight,
  bodySmall:  typography.bodySmall.lineHeight,
  caption:    typography.caption.lineHeight,
} as const;

export const fontWeight = {
  h1:         typography.h1.fontWeight,
  h2:         typography.h2.fontWeight,
  h3:         typography.h3.fontWeight,
  h4:         typography.h4.fontWeight,
  bodyLarge:  typography.bodyLarge.fontWeight,
  bodyMedium: typography.bodyMedium.fontWeight,
  bodySmall:  typography.bodySmall.fontWeight,
  caption:    typography.caption.fontWeight,
} as const;
