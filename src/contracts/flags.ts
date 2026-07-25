/**
 * Degrade flags — design v0.8 §6, frozen at P0.2.
 *
 * Every flag names a fallback that keeps the product demo-able when a dependency
 * has a bad minute. P0.3 owns reading the environment and deciding the starting
 * values (notably: no ANTHROPIC_API_KEY → extraction 'seeded' + narrator 'template');
 * this file owns only the shape and the all-live default.
 */

export interface Flags {
  extraction: 'live' | 'seeded'; // seeded = pre-computed chips
  narrator: 'live' | 'template'; // template = deterministic copy (L1)
  pool: 'live' | 'relay-only'; // relay-only = XTrace unavailable or not settling
  demoMode: boolean; // pins context (DEMO_CONTEXT), makes Ask deterministic
}

export const DEFAULT_FLAGS: Flags = {
  extraction: 'live',
  narrator: 'live',
  pool: 'live',
  demoMode: false,
};
