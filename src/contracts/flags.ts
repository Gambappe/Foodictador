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
  /**
   * `kernel` = the deterministic K4 ranking alone; `live` = K4 plus a model-scored affinity
   * over the places K4 already allowed (D-14).
   *
   * The fallback is not a lesser version of the same answer, it IS the answer the product
   * gave before affinity existed — affinity multiplies a kernel score, and with no model it
   * is `1` for every candidate, which is arithmetically today's ranking. That is why this
   * degrades further than `narrator` does: template copy is a worse sentence, `kernel`
   * scoring is simply the old behaviour.
   */
  scoring: 'live' | 'kernel';
  pool: 'live' | 'relay-only'; // relay-only = XTrace unavailable or not settling
  demoMode: boolean; // pins context (DEMO_CONTEXT), makes Ask deterministic
}

export const DEFAULT_FLAGS: Flags = {
  extraction: 'live',
  narrator: 'live',
  scoring: 'live',
  pool: 'live',
  demoMode: false,
};
