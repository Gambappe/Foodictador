import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { DEMO_CONTEXT, type Read } from '../../src/contracts/types.js';
import { census } from '../../src/kernel/cohorts.js';
import { parseRead } from '../../src/kernel/read.js';
import { scorePlaces } from '../../src/kernel/score.js';
import {
  DEMO_NOW,
  JUDGE_SHIFT_MIN,
  NEAR_TIE_GAP_MAX,
  SEED_COUNT,
  generateSeeds,
  judgeRead,
  judgeShifts,
} from './gen-seeds.js';
import { loadCorpus } from './validate-corpus.js';
import { loadProfiles } from './validate-profiles.js';

const MATCHABLE = [
  'spice_tolerance_low',
  'budget_ceiling',
  'solo_comfort',
  'portion_small',
  'gi_constraint',
] as const;

function committed(name: string): { reads: Read[] } {
  return JSON.parse(
    readFileSync(new URL(`../../data/seeds/${name}`, import.meta.url), 'utf8'),
  ) as { reads: Read[] };
}

const corpus = loadCorpus();
const { b } = loadProfiles();

describe('S2 seed generator', () => {
  it('is deterministic: regenerating equals the committed artifacts byte-for-byte', () => {
    const { reads, inductionSet } = generateSeeds();
    expect(reads).toEqual(committed('reads.json').reads);
    expect(inductionSet).toEqual(committed('induction-set.json').reads);
  });

  it('emits exactly 220 schema-valid reads with unique ids at real corpus places', () => {
    const { reads } = committed('reads.json');
    expect(reads).toHaveLength(SEED_COUNT);
    const slugs = new Set(corpus.map((p) => p.id));
    for (const read of reads) {
      expect(() => parseRead(read)).not.toThrow();
      expect(slugs).toContain(read.place);
    }
    expect(new Set(reads.map((r) => r.read_id)).size).toBe(SEED_COUNT);
  });

  it('every matchable demo driver holds k ∈ [5,9] across ≥5 distinct places', () => {
    const { reads } = committed('reads.json');
    const stats = census(reads);
    for (const driver of MATCHABLE) {
      const stat = stats.find((s) => s.driver === driver);
      expect(stat, driver).toBeDefined();
      if (!stat) continue;
      expect(stat.k, driver).toBeGreaterThanOrEqual(5);
      expect(stat.k, driver).toBeLessThanOrEqual(9);
      expect(stat.placeIds.length, driver).toBeGreaterThanOrEqual(5);
    }
  });

  it("the manifest matches a census of the reads — X6/G4's cross-check source", () => {
    const { manifest } = generateSeeds();
    const stats = census(committed('reads.json').reads);
    for (const entry of manifest) {
      const stat = stats.find((s) => s.driver === entry.driver);
      expect(stat?.k, entry.driver).toBe(entry.k);
      expect([...(stat?.placeIds ?? [])].sort(), entry.driver).toEqual(entry.places);
    }
  });

  it("THE PEAK: B's ranking sits near-tied — score(top1) − score(top3) ≤ 0.04", () => {
    const { reads } = committed('reads.json');
    const ranked = scorePlaces({
      reads,
      usual: b.usual,
      log: b.mealLog,
      corpus,
      context: DEMO_CONTEXT,
      now: DEMO_NOW,
    });
    const [top1, , top3] = ranked;
    expect(top1).toBeDefined();
    expect(top3).toBeDefined();
    if (top1 && top3) {
      expect(top1.score - top3.score).toBeLessThanOrEqual(NEAR_TIE_GAP_MAX);
    }
  });

  it('a judge read on any B-matched driver shifts the runner-up ≥ 0.05 AND reorders top-1', () => {
    const { reads } = committed('reads.json');
    const shifts = judgeShifts(reads, b, corpus);
    expect(shifts.length).toBeGreaterThanOrEqual(3);
    const base = scorePlaces({
      reads,
      usual: b.usual,
      log: b.mealLog,
      corpus,
      context: DEMO_CONTEXT,
      now: DEMO_NOW,
    });
    for (const report of shifts) {
      expect(report.shift, report.driver).toBeGreaterThanOrEqual(JUDGE_SHIFT_MIN);
      // The reorder itself: with the judge's read, the old runner-up overtakes.
      const withJudge = scorePlaces({
        reads: [...reads, judgeRead(report.driver, report.targetPlace)],
        usual: b.usual,
        log: b.mealLog,
        corpus,
        context: DEMO_CONTEXT,
        now: DEMO_NOW,
      });
      expect(withJudge[0]?.place.id, `${report.driver} reorders`).toBe(report.targetPlace);
      expect(withJudge[0]?.place.id).not.toBe(base[0]?.place.id);
    }
  });

  it('the judge read joins an existing citable cohort, never creates one', () => {
    const { reads } = committed('reads.json');
    const stats = census(reads);
    for (const report of judgeShifts(reads, b, corpus)) {
      const k = stats.find((s) => s.driver === report.driver)?.k ?? 0;
      expect(k, report.driver).toBeGreaterThanOrEqual(5); // cohort already at the floor pre-join
    }
  });
});
