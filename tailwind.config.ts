import type { Config } from 'tailwindcss';

/**
 * Tailwind config for the UI shell (U1).
 *
 * The palette is deliberately small and warm — the demo reads at projector distance
 * (plan v1.0 §7 Lane E), so the screens need few colours with high separation rather
 * than a full scale. Semantic names, not hues: `pot` is what the pool writes into and
 * `refusal` is the blocked-topic state, so a re-theme cannot accidentally make a
 * refusal look like a success.
 */
export default {
  content: ['./index.html', './src/ui/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ground: 'rgb(var(--confit-ground) / <alpha-value>)',
        ink: 'rgb(var(--confit-ink) / <alpha-value>)',
        muted: 'rgb(var(--confit-muted) / <alpha-value>)',
        pot: 'rgb(var(--confit-pot) / <alpha-value>)',
        refusal: 'rgb(var(--confit-refusal) / <alpha-value>)',
      },
      fontFamily: {
        sans: ['ui-sans-serif', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
} satisfies Config;
