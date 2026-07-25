/**
 * Scoring tunables (K4). One file so a rehearsal can be re-tuned without hunting
 * through modules, and so a diff to the demo's behaviour is visible in one place.
 *
 * `KFLOOR` is deliberately NOT here — it lives in `cohorts.ts` with the code that
 * enforces it, because it is a privacy invariant from design v0.8 §7 rather than a knob
 * (task DAG §4, K4's note). Import it from there.
 */

/** plan v1.0 §3.4: score(p) = 0.40·pool + 0.25·usual + 0.20·rotation + 0.15·context. */
export const SCORE_WEIGHTS = {
  pool: 0.4,
  usual: 0.25,
  rotation: 0.2,
  context: 0.15,
} as const;

/**
 * `min(1, k / POOL_K_SATURATION)` in §3.4's pool term: a cohort's influence grows with
 * its size until it saturates, so a cohort of 40 does not outweigh one of 8 eightfold.
 */
export const POOL_K_SATURATION = 8;

/** §3.4: rotation(p) is 1 when every signature dish is recommendable, else this. */
export const ROTATION_SUPPRESSED_SCORE = 0.3;

/**
 * §3.4's hard budget constraint is `priceBand > budgetBand + 1`, i.e. a diner tolerates
 * exactly one band above their own and nothing beyond it.
 */
export const BUDGET_TOLERANCE_BANDS = 1;

/** A place one band above budget is affordable but not comfortable. */
export const PRICE_STRETCH_FIT = 0.5;

/** Returned by a sub-fit that has nothing to go on, so absence of evidence stays neutral. */
export const NEUTRAL_FIT = 0.5;

/**
 * Top-k for M2's per-driver counting query — roughly 20x the largest seeded cohort of 9,
 * affordable because the query is scoped to one driver at a time (design v0.8 §8, [E22]).
 * G4 fails if this is ever sized below the largest real cohort.
 */
export const COUNTING_K = 200;
