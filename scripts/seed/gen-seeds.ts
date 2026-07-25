/**
 * Seed generator (S2) — the demo's engineered climax, generated deterministically.
 *
 * 220 reads such that, evaluated with K4's real scoring against profile B under
 * DEMO_CONTEXT:
 *   - every matchable demo driver holds a cohort of k ∈ [5,9] across ≥5 places
 *     (a judge's read must JOIN a cohort, never create one — design v0.8 §7);
 *   - B's ranking sits near-tied: score(top1) − score(top3) ≤ 0.04;
 *   - a judge read (weight ≥ 0.7) on any B-matched driver shifts the runner-up
 *     by ≥ 0.05 — the weight that tips the ranking on stage.
 *
 * Deterministic from a fixed PRNG seed (mulberry32) — no unseeded randomness —
 * then refined by a bounded tuning loop that nudges read weights against the
 * actual K4 ranking until the invariants hold, and THROWS if they cannot: a
 * seed that fails its own invariants must never be written.
 *
 * Artifacts: data/seeds/reads.json (canonical), data/seeds/manifest.json
 * (per-driver counts + places, consumed by X6/G4's cross-check), and
 * data/seeds/induction-set.json (all seed reads — the relay-only pool M6
 * serves; the full set so a relay-only census still matches the manifest).
 */

import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import type { Driver, Place, Read, Signal, UsualProfile } from '../../src/contracts/types.js';
import { DEMO_CONTEXT } from '../../src/contracts/types.js';
import { matched } from '../../src/kernel/cohorts.js';
import { parseRead } from '../../src/kernel/read.js';
import { scorePlaces, type ScoreInput } from '../../src/kernel/score.js';
import { loadCorpus } from './validate-corpus.js';
import { loadProfiles, type DemoProfile } from './validate-profiles.js';

export const SEED_COUNT = 220;
export const PRNG_SEED = 0xc04f17;
export const DEMO_NOW = '2026-07-25T19:00:00.000Z';
export const NEAR_TIE_GAP_MAX = 0.04;
export const JUDGE_SHIFT_MIN = 0.05;
export const JUDGE_WEIGHT = 0.75;
const TUNE_GAP_TARGET = 0.035; // margin under the asserted bound
const TUNE_SHIFT_TARGET = 0.055;
const MAX_TUNING_PASSES = 600;

const POSITIVE: Signal[] = ['secret_default', 'trusted_safe_place', 'returns_despite_incident'];
const NEGATIVE: Signal[] = ['regret_after_order', 'never_ordered_again', 'wanted_something_else'];

/** Deterministic PRNG — the only randomness source in this module. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stable uuid-shaped ids derived from the PRNG — deterministic across runs. */
function seededReadId(rand: () => number): string {
  const hex = (n: number): string => Math.floor(rand() * 16 ** n).toString(16).padStart(n, '0');
  return `${hex(8)}-${hex(4)}-4${hex(3)}-8${hex(3)}-${hex(12)}`;
}

const round2 = (n: number): number => Number(n.toFixed(2));

interface CohortPlan {
  driver: Driver;
  k: number;
  lean: 'positive' | 'negative' | 'mixed';
  places: (corpus: Place[]) => string[];
}

const byBand = (corpus: Place[], min: number, max: number): string[] =>
  corpus.filter((p) => p.priceBand >= min && p.priceBand <= max).map((p) => p.id);
const byTag = (corpus: Place[], tag: Place['tags'][number]): string[] =>
  corpus.filter((p) => p.tags.includes(tag)).map((p) => p.id);
const spicyPlaces = (corpus: Place[]): string[] =>
  corpus.filter((p) => p.signatureDishes.some((d) => d.spiceLevel >= 2)).map((p) => p.id);

/**
 * The demo story is encoded here: low-spice-tolerance regret drags the loudly
 * spicy places down for B; solo comfort and quiet budget gems get lifted.
 * Matchable drivers stay inside k ∈ [5,9]; the six unmatchable drivers carry
 * the pool's bulk as texture.
 */
const MATCHABLE_PLANS: CohortPlan[] = [
  { driver: 'spice_tolerance_low', k: 7, lean: 'negative', places: spicyPlaces },
  { driver: 'budget_ceiling', k: 6, lean: 'mixed', places: (c) => byBand(c, 2, 3) },
  { driver: 'solo_comfort', k: 7, lean: 'positive', places: (c) => byTag(c, 'solo_friendly') },
  { driver: 'portion_small', k: 5, lean: 'positive', places: (c) => byTag(c, 'small_plates') },
  { driver: 'gi_constraint', k: 5, lean: 'mixed', places: (c) => byTag(c, 'gi_safe_options') },
];

const TEXTURE_DRIVERS: Driver[] = [
  'companion_constraint',
  'emotional_exclusion',
  'acclaim_skeptic',
  'crowd_aversion',
  'sensory_shift',
  'allergy_constraint',
];

const CADENCE_WHEEL = ['weekly', 'monthly', 'rarely', 'daily', 'once'] as const;

function structuralReads(corpus: Place[], rand: () => number): Read[] {
  const reads: Read[] = [];
  const pick = <T>(list: T[]): T => {
    const item = list[Math.floor(rand() * list.length)];
    if (item === undefined) throw new Error('gen-seeds: picked from an empty list');
    return item;
  };
  const signalFor = (lean: CohortPlan['lean'], index: number): Signal => {
    if (lean === 'positive') return pick(POSITIVE);
    if (lean === 'negative') return index === 0 ? 'pretends_preference' : pick(NEGATIVE);
    return index % 2 === 0 ? pick(POSITIVE) : pick(NEGATIVE);
  };

  for (const plan of MATCHABLE_PLANS) {
    const pool = plan.places(corpus);
    if (pool.length < 5) throw new Error(`gen-seeds: <5 eligible places for ${plan.driver}`);
    for (let i = 0; i < plan.k; i++) {
      reads.push({
        read_id: seededReadId(rand),
        place: pool[i % pool.length] ?? pool[0]!,
        signal: signalFor(plan.lean, i),
        driver: plan.driver,
        cadence: CADENCE_WHEEL[i % CADENCE_WHEEL.length] ?? 'weekly',
        weight: round2(0.55 + rand() * 0.35),
      });
    }
  }

  const remaining = SEED_COUNT - reads.length;
  const allPlaces = corpus.map((p) => p.id);
  for (let i = 0; i < remaining; i++) {
    const driver = TEXTURE_DRIVERS[i % TEXTURE_DRIVERS.length] ?? 'companion_constraint';
    reads.push({
      read_id: seededReadId(rand),
      place: pick(allPlaces),
      signal: pick([...POSITIVE, ...NEGATIVE, 'pretends_preference' as Signal]),
      driver,
      cadence: CADENCE_WHEEL[i % CADENCE_WHEEL.length] ?? 'monthly',
      weight: round2(0.4 + rand() * 0.5),
    });
  }
  return reads;
}

function scoreWith(reads: Read[], profile: DemoProfile, corpus: Place[]): ScoreInput {
  return {
    reads,
    usual: profile.usual,
    log: profile.mealLog,
    corpus,
    context: DEMO_CONTEXT,
    now: DEMO_NOW,
  };
}

/** A judge read on `driver` at `place`, the confession the demo stages. */
export function judgeRead(driver: Driver, place: string): Read {
  return {
    read_id: 'judge-0000-0000-4000-8000-000000000001',
    place,
    signal: 'secret_default',
    driver,
    cadence: 'weekly',
    weight: JUDGE_WEIGHT,
  };
}

export interface JudgeShiftReport {
  driver: Driver;
  targetPlace: string;
  shift: number;
}

/**
 * For each driver B's Usual matches: drop the judge's read on the current
 * runner-up and measure how far its score moves. This is the number that must
 * clear JUDGE_SHIFT_MIN for the on-stage reorder to be a weight, not a wish.
 */
export function judgeShifts(reads: Read[], profile: DemoProfile, corpus: Place[]): JudgeShiftReport[] {
  const base = scorePlaces(scoreWith(reads, profile, corpus));
  const runnerUp = base[1];
  if (runnerUp === undefined) throw new Error('gen-seeds: ranking has no runner-up');
  const baseScore = runnerUp.score;
  return matched(profile.usual, reads).map((stat) => {
    const withJudge = scorePlaces(
      scoreWith([...reads, judgeRead(stat.driver, runnerUp.place.id)], profile, corpus),
    );
    const after = withJudge.find((r) => r.place.id === runnerUp.place.id);
    return {
      driver: stat.driver,
      targetPlace: runnerUp.place.id,
      shift: (after?.score ?? baseScore) - baseScore,
    };
  });
}

/**
 * Bounded deterministic refinement. Three moves, applied against the live
 * ranking each pass: soften a positive matched read at top-1 (close the gap
 * from above), strengthen a positive matched read at top-3 (close it from
 * below), and pull the runner-up's matched pool sum toward zero, where the
 * logistic is steepest, so the judge's read buys the most movement.
 */
function tune(reads: Read[], profile: DemoProfile, corpus: Place[]): Read[] {
  const tuned = reads.map((read) => ({ ...read }));
  const matchedDrivers = new Set(matched(profile.usual, tuned).map((s) => s.driver));
  const polarity = (signal: Signal): number =>
    POSITIVE.includes(signal) ? 1 : NEGATIVE.includes(signal) ? -1 : 0;

  for (let pass = 0; pass < MAX_TUNING_PASSES; pass++) {
    const ranking = scorePlaces(scoreWith(tuned, profile, corpus));
    const [top1, top2, top3] = [ranking[0], ranking[1], ranking[2]];
    if (!top1 || !top2 || !top3) throw new Error('gen-seeds: fewer than three candidates');
    const gap = top1.score - top3.score;
    const shifts = judgeShifts(tuned, profile, corpus);
    const worstShift = Math.min(...shifts.map((s) => s.shift));
    if (gap <= TUNE_GAP_TARGET && worstShift >= TUNE_SHIFT_TARGET) return tuned;

    const adjust = (placeId: string, direction: 1 | -1): boolean => {
      // Deterministic pick: first matched-driver read at the place whose weight
      // can still move in `direction` (positive reads only — polarity 0 is inert).
      for (const read of tuned) {
        if (read.place !== placeId || !matchedDrivers.has(read.driver)) continue;
        if (polarity(read.signal) !== 1) continue;
        const next = round2(read.weight + 0.02 * direction);
        if (next < 0.35 || next > 0.95) continue;
        read.weight = next;
        return true;
      }
      return false;
    };

    let moved = false;
    if (gap > TUNE_GAP_TARGET) {
      moved = adjust(top1.place.id, -1) || adjust(top3.place.id, 1);
    }
    if (worstShift < TUNE_SHIFT_TARGET) {
      // Flatten the runner-up's matched pool sum toward zero: soften its
      // strongest positive matched read so the logistic sits on its steep part.
      moved = adjust(top2.place.id, -1) || moved;
    }
    if (!moved) break; // no legal move left — fall through to the failure throw
  }

  const final = scorePlaces(scoreWith(tuned, profile, corpus));
  const gap = (final[0]?.score ?? 0) - (final[2]?.score ?? 0);
  const worst = Math.min(...judgeShifts(tuned, profile, corpus).map((s) => s.shift));
  throw new Error(
    `gen-seeds: tuning did not converge (gap=${gap.toFixed(4)}, worst shift=${worst.toFixed(4)}) — restructure MATCHABLE_PLANS`,
  );
}

export interface ManifestEntry {
  driver: Driver;
  k: number;
  places: string[];
}

export interface SeedArtifacts {
  reads: Read[];
  manifest: ManifestEntry[];
  inductionSet: Read[];
}

export function generateSeeds(): SeedArtifacts {
  const corpus = loadCorpus();
  const { b } = loadProfiles();
  const rand = mulberry32(PRNG_SEED);
  const reads = tune(structuralReads(corpus, rand), b, corpus).map((read) => parseRead(read));

  const byDriver = new Map<Driver, Read[]>();
  for (const read of reads) {
    byDriver.set(read.driver, [...(byDriver.get(read.driver) ?? []), read]);
  }
  const manifest: ManifestEntry[] = [...byDriver.entries()]
    .map(([driver, group]) => ({
      driver,
      k: group.length,
      places: [...new Set(group.map((r) => r.place))].sort(),
    }))
    .sort((a, b2) => a.driver.localeCompare(b2.driver));

  return { reads, manifest, inductionSet: reads };
}

function main(): void {
  const { reads, manifest, inductionSet } = generateSeeds();
  const write = (name: string, payload: unknown): void => {
    writeFileSync(
      new URL(`../../data/seeds/${name}`, import.meta.url),
      JSON.stringify(payload, null, 2) + '\n',
    );
  };
  write('reads.json', { reads });
  write('manifest.json', { generatedFrom: `prng ${PRNG_SEED}`, demoNow: DEMO_NOW, manifest });
  write('induction-set.json', { reads: inductionSet });
  process.stderr.write(
    `seeds OK: ${reads.length} reads, ${manifest.length} drivers — artifacts written to data/seeds/\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

export { type UsualProfile };
