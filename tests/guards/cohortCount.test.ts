/**
 * G4 — the [E22] cross-check: per-driver counted totals must equal S2's
 * manifest. The counting query is top-k, so a COUNTING_K sized for the seed
 * but not for seed-plus-live reads undercounts — and an undercount renders a
 * qualifying cohort as a cohort-miss on stage. This guard fails in CI instead.
 *
 * `countThroughTopK` mirrors M2's counting-path semantics (scoped to one
 * driver, truncated at k, then deduped by K6's census) without a live
 * substrate: the truncation is the thing being guarded, and it is the same
 * arithmetic here as there.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { DRIVERS, type Driver, type Read } from '../../src/contracts/types.js';
import { census } from '../../src/kernel/cohorts.js';
import { COUNTING_K } from '../../src/kernel/constants.js';
import { judgeRead } from '../../scripts/seed/gen-seeds.js';

interface ManifestEntry {
  driver: Driver;
  k: number;
  places: string[];
}

const reads = (
  JSON.parse(
    readFileSync(new URL('../../data/seeds/reads.json', import.meta.url), 'utf8'),
  ) as { reads: Read[] }
).reads;
const manifest = (
  JSON.parse(
    readFileSync(new URL('../../data/seeds/manifest.json', import.meta.url), 'utf8'),
  ) as { manifest: ManifestEntry[] }
).manifest;

/** The counting path in miniature: one driver, top-k truncation, census dedup. */
function countThroughTopK(all: Read[], driver: Driver, k: number): number {
  const scoped = all.filter((read) => read.driver === driver).slice(0, k);
  return census(scoped).find((stat) => stat.driver === driver)?.k ?? 0;
}

describe('G4 cohort-count cross-check ([E22])', () => {
  it('at COUNTING_K, every counted total equals the manifest', () => {
    for (const entry of manifest) {
      expect(countThroughTopK(reads, entry.driver, COUNTING_K), entry.driver).toBe(entry.k);
    }
    // and the manifest itself matches a full census — no stale artifact
    const full = census(reads);
    for (const entry of manifest) {
      expect(full.find((stat) => stat.driver === entry.driver)?.k, entry.driver).toBe(entry.k);
    }
  });

  it('lowering COUNTING_K below the largest cohort makes the cross-check fail', () => {
    const largest = Math.max(...manifest.map((entry) => entry.k));
    const tooSmall = 4; // below every matchable cohort's k
    expect(tooSmall).toBeLessThan(largest);
    const mismatches = manifest.filter(
      (entry) => countThroughTopK(reads, entry.driver, tooSmall) !== entry.k,
    );
    expect(mismatches.length).toBeGreaterThan(0); // the guard actually guards
  });

  it('COUNTING_K carries headroom for seed-plus-live reads, not just the seed', () => {
    const largest = Math.max(...manifest.map((entry) => entry.k));
    // v0.8 §12's named failure mode: k sized for the seed but not the seed plus
    // live confessions. Require at least 2× headroom over the largest cohort.
    expect(COUNTING_K).toBeGreaterThanOrEqual(2 * largest);
    // and a live judge read on the fattest matchable cohort still counts exactly
    const fattest = [...manifest]
      .filter((entry) => (DRIVERS as readonly string[]).includes(entry.driver))
      .sort((a, b) => b.k - a.k)[0];
    expect(fattest).toBeDefined();
    if (!fattest) return;
    const withLive = [...reads, judgeRead(fattest.driver, 'tortoise_tea')];
    expect(countThroughTopK(withLive, fattest.driver, COUNTING_K)).toBe(fattest.k + 1);
  });
});
