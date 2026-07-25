import { describe, expect, it } from 'vitest';

import type { PoolStore, Relay } from '../../src/contracts/modules.js';
import type { Read, RelayEntry } from '../../src/contracts/types.js';
import type { BatchHandle } from '../../src/contracts/modules.js';
import { createLogger } from '../../src/config/logger.js';
import { loadSeeds, readPackArtifact, readSeedArtifact } from './load-seeds.js';

const NOW = new Date('2026-07-25T10:00:00.000Z');

/**
 * The pool fake records BATCHES, not reads.
 *
 * That is the shape of the change M12 made: this loader used to send 220 individual
 * ingests, one per read, each landing in its own conversation — so XTrace produced 220
 * episodes, each a paraphrase of one read, and the cross-record synthesis the pool exists
 * for could not happen. Recording batches is how a test can see the difference; a fake that
 * flattened them back into a list of reads would pass either way.
 */
function fakes(init?: { poolFails?: boolean }) {
  const batches: Read[][] = [];
  const relayEntries: RelayEntry[] = [];
  const log: string[] = [];
  let jobSeq = 0;

  const pool: PoolStore = {
    writeRead: () =>
      Promise.reject(new Error('the loader must batch — one ingest per read is the M12 defect')),
    writeReads(reads): Promise<BatchHandle[]> {
      if (init?.poolFails === true) return Promise.reject(new Error('ingest 503'));
      // Grouping policy is M2's, so this fake does not model it; it records what it was
      // given and returns one handle per driver, which is the shape the real store returns.
      batches.push([...reads]);
      const drivers = new Set(reads.map((read) => read.driver));
      return Promise.resolve(
        [...drivers].map((driver) => {
          jobSeq += 1;
          return {
            jobId: `job-${String(jobSeq)}`,
            readIds: reads.filter((r) => r.driver === driver).map((r) => r.read_id),
          };
        }),
      );
    },
    inducedClaim: () => Promise.reject(new Error('unused')),
  };

  const relay: Relay = {
    put: () => Promise.reject(new Error('unused')),
    setJob: () => Promise.reject(new Error('unused')),
    setPoolMemories: () => Promise.resolve(),
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
  return { deps, batches, relayEntries, log };
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
    expect(f.relayEntries).toHaveLength(220);
    const closing = f.log[f.log.length - 1] ?? '';
    expect(closing).toMatch(/480s/);
    expect(closing).toMatch(/warm no earlier than 2026-07-25T10:08:00/);
  });

  it('feeds the pool in ONE call, so the store can group reads into conversations', async () => {
    // The M12 regression this locks. Per-read ingests are not a performance question —
    // XTrace episodes summarise a conversation, so an isolated read can only produce a
    // paraphrase of itself. Measured on the live API: ungrouped, the induced claim was
    // "The session consisted of a single structured signal about Harbor Greens"; grouped,
    // it spanned four places. If this loader ever loops over `writeRead` again, the pool
    // fake above rejects and this file names why.
    const f = fakes();
    await loadSeeds(seeds, f.deps);
    expect(f.batches).toHaveLength(1);
    expect(f.batches[0]).toHaveLength(220);
    expect(f.log.some((l) => /conversation\(s\)/.test(l))).toBe(true);
  });

  it('loading twice warns about the re-run; the relay upserts so counts stay stable', async () => {
    const f = fakes();
    await loadSeeds(seeds, f.deps);
    const report = await loadSeeds(seeds, f.deps);
    expect(report.rerunDetected).toBe(true);
    expect(f.log.some((l) => l.includes('re-run detected'))).toBe(true);
    // The relay is the store of record (D-7) and keys on read_id, so a re-seed does not
    // double a cohort. The pool gets fed again, which is extra induction material rather
    // than a miscount — nothing counts from XTrace any more.
    expect(f.relayEntries).toHaveLength(220);
    expect(f.batches).toHaveLength(2);
  });

  it('a pool failure loses no reads and says induction is what degraded', async () => {
    // All-or-nothing on the pool feed, and it must not read as data loss: every read is on
    // the relay, countable immediately. Only the induced claim suffers until a re-seed.
    const f = fakes({ poolFails: true });
    const report = await loadSeeds(seeds, f.deps);
    expect(report.poolLoaded).toBe(0);
    expect(report.failed).toHaveLength(220);
    expect(report.relaySeeded).toBe(220);
    expect(f.relayEntries).toHaveLength(220); // nothing lost
    const failure = f.log.find((l) => l.includes('pool feed failed')) ?? '';
    expect(failure).toMatch(/countable/);
    expect(failure).toMatch(/induction is degraded/);
  });
});

/**
 * DEMO.2 — the pack is a real artifact, and the claim it exists to satisfy is checkable.
 *
 * The pack was written to fix a measured problem: the base seed puts 190 of its 220 reads on
 * drivers no `UsualProfile` can evidence, leaving the five matchable ones one or two reads
 * over the `k>=5` floor. If the pack ever stops deepening those five, every downstream demo
 * beat quietly reverts to citing "5 of them" — and nothing else in the suite would notice,
 * because a generated file that parses looks healthy.
 */
describe('DEMO.2 demo pack', () => {
  /** The five a diner can actually match (D-5); the other six are unreachable by construction. */
  const MATCHABLE = [
    'spice_tolerance_low',
    'budget_ceiling',
    'solo_comfort',
    'portion_small',
    'gi_constraint',
  ] as const;

  const count = (reads: readonly { driver: string }[], driver: string) =>
    reads.filter((r) => r.driver === driver).length;

  it('parses through the same reader as the base seed, with a non-colliding id space', () => {
    const pack = readPackArtifact();
    expect(pack.length).toBeGreaterThan(0);
    // Distinct ids are what let `pass census` attribute a surprise to one set or the other,
    // and what stops a pack load registering as a seed re-run.
    const seedIds = new Set(seeds.map((r) => r.read_id));
    expect(pack.filter((r) => seedIds.has(r.read_id))).toHaveLength(0);
  });

  it('deepens every matchable driver clear of the floor, which is its whole purpose', () => {
    const pack = readPackArtifact();
    for (const driver of MATCHABLE) {
      const base = count(seeds, driver);
      const combined = base + count(pack, driver);
      expect(count(pack, driver)).toBeGreaterThan(0);
      // Not merely "more": comfortably clear of KFLOOR, so a citation sounds like a crowd
      // rather than a quorum. gi_constraint is deliberately the thinnest and still clears it.
      expect(combined).toBeGreaterThan(5);
      expect(combined).toBeGreaterThan(base);
    }
  });

  it('spreads across the corpus rather than clustering on a few places', () => {
    const pack = readPackArtifact();
    // A cohort built from one restaurant's regulars says "42 people like you" about 42 people
    // who like one place. The citation asserts something about the DRIVER, so the reads
    // behind it have to be spread.
    expect(new Set(pack.map((r) => r.place)).size).toBeGreaterThan(10);
  });

  it('is deterministic: regeneration is a no-op, so a rehearsal rehearses the demo', () => {
    // Same bytes twice from the same reader — the artifact is committed, and the generator is
    // seeded from a constant with no clock. A pack that differed per run would mean the demo
    // rehearsed one corpus and performed another.
    expect(readPackArtifact()).toEqual(readPackArtifact());
  });
});
