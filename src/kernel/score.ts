/**
 * Deterministic place scoring (K4). Pure kernel: no I/O, and `now` is a parameter.
 *
 * plan v1.0 §3.4 is the specification:
 *
 *   candidates = corpus minus hard-constraint violations (gi, budget > band+1)
 *   pool(p)    = squash( Σ over reads in cohorts matched to Usual, at place p:
 *                          polarity(signal) · weight · min(1, k/8) )
 *   usual(p)   = fit of tags/priceBand/spice vs UsualProfile
 *   rotation(p)= 1 if all signature dishes clear appetite ≥ 60, else 0.3
 *   context(p) = tag match vs the demo context
 *   score(p)   = 0.40·pool + 0.25·usual + 0.20·rotation + 0.15·context
 *
 * §3.4 states `squash`, `usual(p)` and `context(p)` as prose rather than formulas, so
 * their definitions below are this module's, chosen to be monotone, bounded in [0,1] and
 * neutral in the absence of evidence. Each is documented at its function, and every
 * constant is in `constants.ts` so a rehearsal can retune without editing logic.
 *
 * The model never chooses a place: it receives this ranking and writes copy for it
 * (plan v1.0 §2b). That is what makes the choose-from-corpus contract structural.
 */

import { matched } from './cohorts.js';
import {
  BUDGET_TOLERANCE_BANDS,
  NEUTRAL_FIT,
  POOL_K_SATURATION,
  PRICE_STRETCH_FIT,
  ROTATION_SUPPRESSED_SCORE,
  SCORE_WEIGHTS,
} from './constants.js';
import { APPETITE_RECOMMEND_THRESHOLD, appetite, suppressions } from './rotation.js';
import type {
  AskContext,
  Driver,
  MealLogEntry,
  Place,
  RankedPlace,
  Read,
  Signal,
  UsualProfile,
} from '../contracts/types.js';

/**
 * §3.4's polarity table. `pretends_preference` is deliberately 0: it informs which
 * driver a read belongs to, not whether the place is good.
 */
export const SIGNAL_POLARITY: Record<Signal, -1 | 0 | 1> = {
  returns_despite_incident: 1,
  secret_default: 1,
  trusted_safe_place: 1,
  regret_after_order: -1,
  never_ordered_again: -1,
  wanted_something_else: -1,
  pretends_preference: 0,
};

export interface ScoreInput {
  reads: Read[];
  usual: UsualProfile;
  log: MealLogEntry[];
  corpus: Place[];
  context: AskContext;
  now: string;
}

/** Why a place was excluded outright. Reason keys, not prose — copy is L1's job. */
export type ExclusionReason = 'gi_unsafe' | 'over_budget';

export interface Exclusion {
  placeId: string;
  reason: ExclusionReason;
}

/**
 * §3.4's hard constraints, as far as the contract allows.
 *
 * `gi` and `budget` are implemented. **`allergy` is not, and cannot be:** §3.4 lists it,
 * but `UsualProfile` (frozen at P0.2) has no allergy field — the same missing-fields gap
 * recorded as task DAG §4 D-5, which also makes `allergy_constraint` an unmatchable
 * driver. Adding an allergy hard-constraint needs a contract change, not a code change,
 * so this returns only what it can actually check rather than pretending.
 */
export function exclusionsFor(place: Place, usual: UsualProfile): Exclusion[] {
  const found: Exclusion[] = [];
  if (usual.giConstraint && !place.tags.includes('gi_safe_options')) {
    found.push({ placeId: place.id, reason: 'gi_unsafe' });
  }
  if (place.priceBand > usual.budgetBand + BUDGET_TOLERANCE_BANDS) {
    found.push({ placeId: place.id, reason: 'over_budget' });
  }
  return found;
}

/** The corpus minus hard-constraint violations. */
export function candidates(corpus: Place[], usual: UsualProfile): Place[] {
  return corpus.filter((place) => exclusionsFor(place, usual).length === 0);
}

/**
 * §3.4's `squash`, unspecified there, defined here as the logistic function.
 *
 * The pool sum is signed and unbounded: positive signals push up, regret pushes down.
 * The logistic maps that to (0,1) monotonically and — the property that matters — sends
 * a sum of exactly 0 to 0.5. A place with no pool evidence therefore scores neutral, not
 * badly: absence of evidence must not read as evidence against.
 */
function squash(sum: number): number {
  return 1 / (1 + Math.exp(-sum));
}

/**
 * §3.4's pool term for one place.
 *
 * Only reads whose driver is in a cohort `matched` to this Usual contribute, and only
 * reads at this place. `CohortStat` carries no per-read signal, so the k-saturation
 * factor comes from the cohort while polarity and weight come from the raw reads.
 */
export function poolScore(place: Place, reads: Read[], usual: UsualProfile): number {
  return poolScoreWith(place, reads, citableCohortSizes(usual, reads));
}

/** Cohort sizes keyed by driver, for the drivers this Usual can actually cite. */
function citableCohortSizes(usual: UsualProfile, reads: Read[]): Map<Driver, number> {
  return new Map(matched(usual, reads).map((stat) => [stat.driver, stat.k]));
}

/**
 * The pool sum for one place given a pre-computed cohort map.
 *
 * Split out so `scorePlaces` runs the census once for the whole corpus rather than once
 * per place — the census is O(reads) and the corpus is scored in a loop.
 */
function poolScoreWith(place: Place, reads: Read[], kByDriver: Map<Driver, number>): number {
  let sum = 0;
  for (const read of reads) {
    if (read.place !== place.id) continue;
    const k = kByDriver.get(read.driver);
    if (k === undefined) continue; // driver not citable for this user
    sum += SIGNAL_POLARITY[read.signal] * read.weight * Math.min(1, k / POOL_K_SATURATION);
  }
  return squash(sum);
}

/**
 * §3.4's `usual(p)` — "fit of tags/priceBand/spice vs UsualProfile" — as the mean of four
 * equally weighted sub-fits, each in [0,1]:
 *
 *  - **spice**: the share of signature dishes at or below the diner's tolerance.
 *  - **price**: 1 at or under budget, `PRICE_STRETCH_FIT` for the one tolerated band above.
 *  - **portion**: only meaningful for a small-portion preference, which `small_plates` serves.
 *  - **solo**: only meaningful for a solo-comfortable diner, served by `solo_friendly`
 *    or `counter_seating`.
 *
 * A sub-fit with nothing to go on returns `NEUTRAL_FIT` rather than 0 or 1, so a
 * preference the diner does not hold neither rewards nor punishes a place.
 *
 * When a preference *is* held and the tag is absent, the sub-fit is 0 rather than neutral:
 * the corpus is hand-curated and S1 assigns tags deliberately, so a missing tag is a
 * statement about the place, not missing data. That is only true while the corpus is
 * curated — it would need revisiting against the [prod] Places-API corpus.
 */
export function usualScore(place: Place, usual: UsualProfile): number {
  const dishes = place.signatureDishes;
  const spiceFit =
    dishes.length === 0
      ? NEUTRAL_FIT
      : dishes.filter((dish) => dish.spiceLevel <= usual.spiceTolerance).length / dishes.length;

  const priceFit = place.priceBand <= usual.budgetBand ? 1 : PRICE_STRETCH_FIT;

  const portionFit =
    usual.portionPref === 'small' ? (place.tags.includes('small_plates') ? 1 : 0) : NEUTRAL_FIT;

  const soloFit = usual.soloComfort
    ? place.tags.includes('solo_friendly') || place.tags.includes('counter_seating')
      ? 1
      : 0
    : NEUTRAL_FIT;

  return (spiceFit + priceFit + portionFit + soloFit) / 4;
}

/**
 * §3.4's `rotation(p)`: 1 when every signature dish is recommendable, else 0.3.
 *
 * A dish is recommendable when its appetite clears K3's threshold **and** it is not
 * suppressed — a dish eaten twice this week is exactly what the diner will turn on, so a
 * place built on it should not lead. A place with no signature dishes scores 1 vacuously;
 * S1's corpus validator is what guarantees that does not happen with real data.
 */
export function rotationScore(place: Place, log: MealLogEntry[], now: string): number {
  return rotationScoreWith(place, log, now, suppressedDishes(log, now));
}

/** Dish ids currently suppressed, computed once per ranking rather than per place. */
function suppressedDishes(log: MealLogEntry[], now: string): Set<string> {
  return new Set(suppressions(log, now).map((entry) => entry.dishId));
}

function rotationScoreWith(
  place: Place,
  log: MealLogEntry[],
  now: string,
  suppressed: Set<string>,
): number {
  const allClear = place.signatureDishes.every(
    (dish) =>
      !suppressed.has(dish.dishId) &&
      appetite(dish.dishId, log, now) >= APPETITE_RECOMMEND_THRESHOLD,
  );
  return allClear ? 1 : ROTATION_SUPPRESSED_SCORE;
}

/**
 * §3.4's `context(p)` — "tag match vs demo context (time bucket, solo, weather)" — as the
 * share of *applicable* cues a place satisfies. A cue only applies when the context
 * raises it, so a place is never marked down for lacking `late_night` at lunchtime.
 * With no cue applicable the term is neutral, for the same reason `pool` is.
 */
export function contextScore(place: Place, context: AskContext): number {
  const cues: boolean[] = [];
  if (context.hour >= 22) cues.push(place.tags.includes('late_night'));
  if (context.solo)
    cues.push(place.tags.includes('solo_friendly') || place.tags.includes('counter_seating'));
  if (context.weather === 'rain') cues.push(place.tags.includes('quiet'));

  if (cues.length === 0) return NEUTRAL_FIT;
  return cues.filter(Boolean).length / cues.length;
}

/**
 * The ranking. Candidates only, highest score first, ties broken by place slug ascending
 * so a run is reproducible and a rehearsal repeatable.
 *
 * `parts` is the unweighted term-by-term breakdown, which The Pass shows and the
 * near-tie inspector reads; `score` is the weighted sum of it.
 */
export function scorePlaces(input: ScoreInput): RankedPlace[] {
  // Both of these are O(reads) / O(log) and identical for every place, so they are
  // computed once for the ranking instead of once per candidate.
  const kByDriver = citableCohortSizes(input.usual, input.reads);
  const suppressed = suppressedDishes(input.log, input.now);

  const ranked = candidates(input.corpus, input.usual).map((place) => {
    const parts = {
      pool: poolScoreWith(place, input.reads, kByDriver),
      usual: usualScore(place, input.usual),
      rotation: rotationScoreWith(place, input.log, input.now, suppressed),
      context: contextScore(place, input.context),
    };
    const score =
      SCORE_WEIGHTS.pool * parts.pool +
      SCORE_WEIGHTS.usual * parts.usual +
      SCORE_WEIGHTS.rotation * parts.rotation +
      SCORE_WEIGHTS.context * parts.context;
    return { place, score, parts };
  });

  return ranked.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    // Codepoint order, not localeCompare: the latter depends on the runtime's ICU locale,
    // so the same seed could rank differently on another machine — and a rehearsal that
    // is not byte-reproducible is not a rehearsal.
    if (left.place.id < right.place.id) return -1;
    return left.place.id > right.place.id ? 1 : 0;
  });
}
