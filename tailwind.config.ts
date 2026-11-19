import type { Config } from 'tailwindcss';

// Colours are CSS variables (see globals.css) so dark (the default) and light share one set of utility classes.
const v = (name: string) => `rgb(var(--${name}) / <alpha-value>)`;

const config: Config = {
  darkMode: ['class', '[data-theme="dark"]'],
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        canvas: v('canvas'),
        surface: v('surface'),
        raised: v('raised'),
        line: v('line'),
        ink: v('ink'),
        muted: v('muted'),
        faint: v('faint'),
        brand: { DEFAULT: v('brand'), strong: v('brand-strong'), soft: v('brand-soft'), ink: v('brand-ink') },
        ok: { DEFAULT: v('ok'), soft: v('ok-soft') },
        warn: { DEFAULT: v('warn'), soft: v('warn-soft') },
        bad: { DEFAULT: v('bad'), soft: v('bad-soft') },
        info: { DEFAULT: v('info'), soft: v('info-soft') },
        // Night Desk additions: the always-dark navigation rail, the "today" line, and the AI mark.
        'line-strong': v('line-strong'),
        rail: { DEFAULT: v('rail'), line: v('rail-line'), ink: v('rail-ink'), muted: v('rail-muted'), active: v('rail-active') },
        now: v('now'),
        ai: { DEFAULT: v('ai'), soft: v('ai-soft') },
      },
      fontFamily: {
        sans: ['var(--font-sans)'],
        display: ['var(--font-display)'],
        mono: ['var(--font-mono)'],
      },
      // 6px chips (md), 8px small buttons (lg), 10px buttons and inputs (xl), 16px panels (2xl).
      borderRadius: { md: 'var(--radius-sm)', xl: 'var(--radius-md)', '2xl': 'var(--radius-lg)' },
      // Depth comes from surface steps, not blur. `card` is the panel shadow; `glow` is reserved for the "today" line.
      boxShadow: { card: 'var(--shadow-panel)', panel: 'var(--shadow-panel)', pop: 'var(--shadow-pop)', glow: 'var(--shadow-glow)' },
      keyframes: {
        rise: { from: { opacity: '0', transform: 'translateY(6px)' }, to: { opacity: '1', transform: 'none' } },
        shimmer: { '100%': { transform: 'translateX(100%)' } },
      },
      animation: { rise: 'rise .28s ease-out both', shimmer: 'shimmer 1.4s infinite' },
    },
  },
  plugins: [],
};

export default config;
