/**
 * G4 — the near-tie invariant, asserted against the ACTUAL committed seed and
 * S4's profile B, not a fixture. The demo's climax is CI-protected: if a seed
 * regeneration, a scoring tweak, or a profile edit widens the gap or blunts
 * the judge's read, this fails here instead of on stage.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { DEMO_CONTEXT, type Read } from '../../src/contracts/types.js';
import { scorePlaces } from '../../src/kernel/score.js';
import {
  DEMO_NOW,
  JUDGE_SHIFT_MIN,
  JUDGE_WEIGHT,
  NEAR_TIE_GAP_MAX,
  judgeRead,
  judgeShifts,
} from '../../scripts/seed/gen-seeds.js';
import { loadCorpus } from '../../scripts/seed/validate-corpus.js';
import { loadProfiles } from '../../scripts/seed/validate-profiles.js';

const reads = (
  JSON.parse(
    readFileSync(new URL('../../data/seeds/reads.json', import.meta.url), 'utf8'),
  ) as { reads: Read[] }
).reads;
const corpus = loadCorpus();
const { b } = loadProfiles();

const rank = (withReads: Read[]) =>
  scorePlaces({
    reads: withReads,
    usual: b.usual,
    log: b.mealLog,
    corpus,
    context: DEMO_CONTEXT,
    now: DEMO_NOW,
  });

describe('G4 near-tie invariant (committed seed × profile B)', () => {
  it('score(top1) − score(top3) ≤ 0.04', () => {
    const ranked = rank(reads);
    const top1 = ranked[0];
    const top3 = ranked[2];
    expect(top1).toBeDefined();
    expect(top3).toBeDefined();
    if (top1 && top3) expect(top1.score - top3.score).toBeLessThanOrEqual(NEAR_TIE_GAP_MAX);
  });

  it(`a judge read (weight ${JUDGE_WEIGHT}) on every B-matched driver shifts the runner-up ≥ ${JUDGE_SHIFT_MIN} and reorders top-1`, () => {
    const base = rank(reads);
    const shifts = judgeShifts(reads, b, corpus);
    expect(shifts.length).toBeGreaterThanOrEqual(3);
    for (const report of shifts) {
      expect(report.shift, report.driver).toBeGreaterThanOrEqual(JUDGE_SHIFT_MIN);
      const withJudge = rank([...reads, judgeRead(report.driver, report.targetPlace)]);
      expect(withJudge[0]?.place.id, `${report.driver} must reorder`).toBe(report.targetPlace);
      expect(withJudge[0]?.place.id).not.toBe(base[0]?.place.id);
    }
  });

  it('the ranking is deterministic: two evaluations are identical', () => {
    const first = rank(reads).map((r) => `${r.place.id}:${r.score}`);
    const second = rank(reads).map((r) => `${r.place.id}:${r.score}`);
    expect(first).toEqual(second);
  });
});
