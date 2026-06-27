export const colors = {
  background: {
    primary:   '#0B1020',
    secondary: '#10172E',
    tertiary:  '#151D36',
  },
  surface: {
    primary:  '#1A2140',
    elevated: '#202946',
    glass:    'rgba(26, 33, 64, 0.72)',
  },
  border: {
    soft: '#2A3350',
    glow: '#6F5BFF',
  },
  text: {
    primary:  '#F6F8FF',
    secondary: '#C2CAE0',
    tertiary: '#8B93AA',
    disabled: '#5B637C',
  },
  brand: {
    purple: '#8A6CFF',
    iris:   '#6F5BFF',
    sky:    '#5CA8FF',
    mint:   '#3FD0A8',
  },
  semantic: {
    success: '#2ECC71',
    warning: '#F6C445',
    streak:  '#FF9F43',
    error:   '#FF5D73',
    info:    '#5CA8FF',
  },
} as const;

export type ColorToken = typeof colors;
