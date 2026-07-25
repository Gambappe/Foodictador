import { describe, expect, it } from 'vitest';

import type { PoolStore, Relay } from '../../src/contracts/modules.js';
import type { Read, RelayEntry } from '../../src/contracts/types.js';
import { createLogger } from '../../src/config/logger.js';
import { census } from '../../src/kernel/cohorts.js';
import { loadSeeds, readSeedArtifact } from './load-seeds.js';

const NOW = new Date('2026-07-25T10:00:00.000Z');

function fakes(init?: { failPoolFor?: Set<string> }) {
  const poolReads: Read[] = [];
  const relayEntries: RelayEntry[] = [];
  const log: string[] = [];
  let jobSeq = 0;

  const pool: PoolStore = {
    writeRead(read) {
      if (init?.failPoolFor?.has(read.read_id)) {
        return Promise.reject(new Error('ingest 503'));
      }
      poolReads.push(read);
      jobSeq += 1;
      return Promise.resolve({ jobId: `job-${jobSeq}` });
    },
    readsForDriver: (driver) => Promise.resolve(poolReads.filter((r) => r.driver === driver)),
    inducedClaim: () => Promise.reject(new Error('unused')),
  };
  const relay: Relay = {
    put: () => Promise.reject(new Error('unused')),
    setJob: () => Promise.reject(new Error('unused')),
    list: () => Promise.resolve(relayEntries.map((e) => ({ ...e }))),
    drop: () => Promise.reject(new Error('unused')),
    stats: () => Promise.resolve({ count: relayEntries.length, oldest_entry_age_seconds: 0 }),
    seed(reads) {
      for (const read of reads) {
        if (!relayEntries.some((e) => e.read.read_id === read.read_id)) {
          relayEntries.push({ read, received_at: NOW.toISOString() });
        }
      }
      return Promise.resolve(reads.length);
    },
    reset: () => Promise.reject(new Error('unused')),
  };

  const deps = {
    pool,
    relay,
    logger: createLogger((l) => log.push(l)),
    settleWindowSeconds: 480,
    now: () => NOW,
  };
  return { deps, poolReads, relayEntries, log };
}

const seeds = readSeedArtifact();

describe('S3 seed loader', () => {
  it('loads all 220 to both stores and names the settle window in the closing message', async () => {
    const f = fakes();
    const report = await loadSeeds(seeds, f.deps);
    expect(report).toMatchObject({
      total: 220,
      relaySeeded: 220,
      poolLoaded: 220,
      failed: [],
      rerunDetected: false,
    });
    expect(f.poolReads).toHaveLength(220);
    expect(f.relayEntries).toHaveLength(220);
    const closing = f.log[f.log.length - 1] ?? '';
    expect(closing).toMatch(/480s/);
    expect(closing).toMatch(/warm no earlier than 2026-07-25T10:08:00/);
  });

  it('loading twice warns about the re-run and the census stays identical via K6 dedup', async () => {
    const f = fakes();
    await loadSeeds(seeds, f.deps);
    const firstCensus = census(f.poolReads);
    const report = await loadSeeds(seeds, f.deps);
    expect(report.rerunDetected).toBe(true);
    expect(f.log.some((l) => l.includes('re-run detected'))).toBe(true);
    expect(f.poolReads).toHaveLength(440); // duplicates ARE created — no fake upserts
    expect(census(f.poolReads)).toEqual(firstCensus); // and dedup keeps the census stable
  });

  it('a partial pool failure reports the exact read_ids and notes the sweeper recovery path', async () => {
    const victims = new Set(seeds.slice(0, 3).map((r) => r.read_id));
    const f = fakes({ failPoolFor: victims });
    const report = await loadSeeds(seeds, f.deps);
    expect(report.poolLoaded).toBe(217);
    expect([...report.failed].sort()).toEqual([...victims].sort());
    expect(f.relayEntries).toHaveLength(220); // relay copies of the failures remain
    expect(f.log.some((l) => l.includes('sweeper will re-ingest'))).toBe(true);
  });

  it('progress lines appear per batch', async () => {
    const f = fakes();
    await loadSeeds(seeds, f.deps);
    const batchLines = f.log.filter((l) => /batch \d+\/9/.test(l));
    expect(batchLines).toHaveLength(9); // 220 reads / 25 per batch
  });
});
