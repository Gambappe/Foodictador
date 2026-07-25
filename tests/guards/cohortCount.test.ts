/**
 * G4 — the [E22] cross-check: per-driver counted totals must equal S2's manifest.
 *
 * The failure mode this guard was built for has changed shape. It used to be
 * top-k truncation: M2 counted with a `COUNTING_K` sized for the seed but not
 * seed-plus-live, and an undercount renders a qualifying cohort as a cohort-miss
 * on stage. Under DAG §4 D-7 counting reads the relay, whose `GET /reads` takes
 * no limit and no cursor, so there is no k to size wrong — and `COUNTING_K` is
 * gone rather than left lying around as a knob that no longer connects to
 * anything.
 *
 * What survives is the property, not the arithmetic: the committed seed must
 * count to exactly its manifest, and the counting path must not silently cap.
 * Both are asserted below, the second against the real store rather than a model
 * of it — a guard that mirrors the implementation's own logic cannot catch the
 * implementation being wrong.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { DRIVERS, type Driver, type Read } from '../../src/contracts/types.js';
import { DEFAULT_FLAGS } from '../../src/contracts/flags.js';
import { StubRelay } from '../../src/contracts/stubs/index.js';
import { createFlagStore } from '../../src/config/flagStore.js';
import { createLogger } from '../../src/config/logger.js';
import { createPoolView } from '../../src/memory/poolView.js';
import { census } from '../../src/kernel/cohorts.js';
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

/** The real counting path over a real store, seeded with `all`. */
async function countThroughView(all: Read[], driver: Driver): Promise<number> {
  const logger = createLogger(() => undefined);
  const relay = new StubRelay(() => new Date('2026-07-25T19:00:00.000Z'));
  await relay.seed(all);
  const view = createPoolView({ relay, flags: createFlagStore(DEFAULT_FLAGS, logger), logger });
  const { reads: counted } = await view.readsForDriver(driver);
  return census(counted).find((stat) => stat.driver === driver)?.k ?? 0;
}

describe('G4 cohort-count cross-check ([E22])', () => {
  it('the committed seed counts to exactly its manifest, through the real path', async () => {
    for (const entry of manifest) {
      expect(await countThroughView(reads, entry.driver), entry.driver).toBe(entry.k);
    }
  });

  it('the manifest matches a full census — no stale artifact', () => {
    const full = census(reads);
    for (const entry of manifest) {
      expect(full.find((stat) => stat.driver === entry.driver)?.k, entry.driver).toBe(entry.k);
    }
  });

  it('a live confession joins the fattest cohort and is counted exactly once', async () => {
    // v0.8 §12's named failure mode, restated for D-7: the seed counts fine and
    // the seed-plus-live case is the one that breaks. It cannot break by
    // truncation any more, so what is checked is that adding a read adds one.
    const fattest = [...manifest]
      .filter((entry) => (DRIVERS as readonly string[]).includes(entry.driver))
      .sort((a, b) => b.k - a.k)[0];
    expect(fattest).toBeDefined();
    if (!fattest) return;
    const withLive = [...reads, judgeRead(fattest.driver, 'tortoise_tea')];
    expect(await countThroughView(withLive, fattest.driver)).toBe(fattest.k + 1);
  });

  it('the counting path does not cap: a cohort far larger than any seed counts whole', async () => {
    // The guard that replaces the COUNTING_K sizing tests. If a limit or a
    // default page size is ever introduced anywhere on the read path, this is
    // where it surfaces — as a number, before a demo renders a cohort-miss.
    const driver: Driver = 'solo_comfort';
    const many = Array.from({ length: 500 }, (_, i) => ({
      ...reads[0],
      read_id: `bulk-0000-4000-8000-${String(i).padStart(12, '0')}`,
      driver,
    })) as Read[];
    expect(await countThroughView(many, driver)).toBe(500);
  });
});
