/**
 * Cohort counting (K6). Pure kernel: no I/O, no clock.
 *
 * A cohort is the set of reads sharing a driver. Two things make this module
 * load-bearing rather than arithmetic:
 *
 *  1. **Dedup on `read_id` before counting** (design v0.8 [E20]). A read exists in both
 *     the XTrace pool and the relay for the whole settle window, so counting the union
 *     naively double-counts it — and `k >= KFLOOR` could then be satisfied by four reads
 *     plus a duplicate. Field equality cannot substitute for the id: two people with
 *     identical five-field reads are two legitimate cohort members and must stay two,
 *     while one read arriving from two stores must collapse to one.
 *
 *  2. **A sub-floor cohort is never citable** (design v0.8 §7, [C4]). `matched` returns
 *     only cohorts at or above the floor; `missed` returns the relevant-but-too-small
 *     ones so the card can render the first-teller line instead of a citation.
 */

import {
  DRIVERS,
  type CohortStat,
  type Driver,
  type Read,
  type UsualProfile,
} from '../contracts/types.js';

/**
 * The k>=5 privacy floor (design v0.8 §7 / [C4], [E10]).
 *
 * It lives here, with the code that enforces it, rather than in `constants.ts` with the
 * scoring tunables: this is a privacy invariant, not a knob to tune. K4 imports it for
 * the `min(1, k/8)` term — it must not declare a second copy.
 */
export const KFLOOR = 5;

/**
 * Drivers whose personal relevance can be read off a `UsualProfile`.
 *
 * A pool citation claims something about *this* user ("people who under-report their
 * spice tolerance regret them"), so a cohort only qualifies if its driver is evidenced
 * in their Usual. See UNMATCHABLE_DRIVERS for the gap this leaves.
 */
const DRIVER_RELEVANCE: Partial<Record<Driver, (usual: UsualProfile) => boolean>> = {
  spice_tolerance_low: (usual) => usual.spiceTolerance <= 1,
  budget_ceiling: (usual) => usual.budgetBand <= 2,
  portion_small: (usual) => usual.portionPref === 'small',
  solo_comfort: (usual) => usual.soloComfort,
  gi_constraint: (usual) => usual.giConstraint,
};

/**
 * Drivers with no corresponding field on `UsualProfile`, so no cohort of theirs can ever
 * be matched to a user and none of them can reach a card.
 *
 * This is a contract gap, not a decision: `UsualProfile` (frozen at P0.2) carries spice,
 * budget, portion, solo and gi, and nothing for allergies, sensory shift, companions,
 * emotional exclusion, acclaim scepticism or crowd aversion. Six of eleven drivers are
 * therefore inert — including `companion_constraint`, which design v0.8 §7 uses as its
 * own worked example of a pooled read. Resolving it means either extending `UsualProfile`
 * or deriving relevance from the user's own reads; both are integrator calls.
 */
export const UNMATCHABLE_DRIVERS: readonly Driver[] = DRIVERS.filter(
  (driver) => DRIVER_RELEVANCE[driver] === undefined,
);

/**
 * First occurrence of each `read_id` wins.
 *
 * A `read_id` is expected to map to exactly one read, so order only matters if that
 * invariant is already broken. Callers unioning two stores (M6) should pass the settled,
 * canonical copy first — the pool — so a divergent relay copy loses.
 */
function dedupeByReadId(reads: readonly Read[]): Read[] {
  const seen = new Set<string>();
  const unique: Read[] = [];
  for (const read of reads) {
    if (seen.has(read.read_id)) continue;
    seen.add(read.read_id);
    unique.push(read);
  }
  return unique;
}

/**
 * Per-driver counts over the deduped reads.
 *
 * Only drivers with at least one read appear: a driver absent from the census has no
 * reads, and inventing a `k: 0` row would force a meaningless `meanWeight`. Callers that
 * want a complete table (X6's `confit pass census`) zip this against `DRIVERS`.
 *
 * A `CohortStat` is a summary, not a substitute for the reads. K4's `pool(p)` needs
 * `polarity(signal) · weight` per read at a given place, which this shape deliberately
 * does not carry — call `matched` to learn which drivers qualify, then filter the raw
 * reads by those drivers and the place under scoring.
 */
export function census(reads: readonly Read[]): CohortStat[] {
  const byDriver = new Map<Driver, Read[]>();
  for (const read of dedupeByReadId(reads)) {
    const group = byDriver.get(read.driver);
    if (group === undefined) byDriver.set(read.driver, [read]);
    else group.push(read);
  }

  const stats: CohortStat[] = [];
  for (const [driver, group] of byDriver) {
    const totalWeight = group.reduce((sum, read) => sum + read.weight, 0);
    stats.push({
      driver,
      k: group.length,
      meanWeight: totalWeight / group.length,
      placeIds: [...new Set(group.map((read) => read.place))].sort(),
    });
  }

  // Canonical vocabulary order, so output is reproducible across runs. `Driver` is a
  // closed union, so indexOf never misses and needs no fallback branch.
  return stats.sort((left, right) => DRIVERS.indexOf(left.driver) - DRIVERS.indexOf(right.driver));
}

/** Is this driver evidenced in the user's Usual? */
function isRelevant(driver: Driver, usual: UsualProfile): boolean {
  return DRIVER_RELEVANCE[driver]?.(usual) ?? false;
}

/**
 * A floor below 1 would make every cohort citable, including a cohort of one — the exact
 * re-identification this module exists to prevent. Callers pass `kFloor` from config in
 * places (X6's `--k-floor`, G4's invariants), so a bad value is reachable; refuse it
 * loudly rather than quietly widening a privacy guarantee.
 */
function assertUsableFloor(kFloor: number): void {
  if (!Number.isInteger(kFloor) || kFloor < 1) {
    throw new Error(`kFloor must be an integer >= 1, got ${JSON.stringify(kFloor)}`);
  }
}

/** Cohorts whose driver this user's Usual evidences, at any size. */
function relevantCohorts(usual: UsualProfile, reads: readonly Read[]): CohortStat[] {
  return census(reads).filter((stat) => isRelevant(stat.driver, usual));
}

/**
 * Cohorts that are relevant to this user **and** citable: `k >= kFloor`.
 *
 * Nothing below the floor comes out of here, so a caller cannot cite a thin cohort by
 * accident — that is the whole protection against a distinctive read in a thin pool
 * identifying its author.
 */
export function matched(
  usual: UsualProfile,
  reads: readonly Read[],
  kFloor: number = KFLOOR,
): CohortStat[] {
  assertUsableFloor(kFloor);
  return relevantCohorts(usual, reads).filter((stat) => stat.k >= kFloor);
}

/**
 * Cohorts relevant to this user but **below** the floor — the cohort-miss candidates.
 *
 * The card renders "you're the first person to tell us this" from these instead of a
 * citation. Separate from `matched` on purpose: one function that returned both would
 * make it possible to cite a miss by reaching for the wrong field.
 */
export function missed(
  usual: UsualProfile,
  reads: readonly Read[],
  kFloor: number = KFLOOR,
): CohortStat[] {
  assertUsableFloor(kFloor);
  return relevantCohorts(usual, reads).filter((stat) => stat.k < kFloor);
}
