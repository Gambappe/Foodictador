/**
 * G2 — off-limits propagation (design v0.8 [E24], the §9 fix).
 *
 * A topic set off-limits via UserStore.setUsual — the ONLY write path for
 * off-limits topics — must yield ZERO new records in BOTH tiers when a
 * confession touches it: no pool read, no relay entry, and no user-scope
 * prose. v0.7's version checked only the pool, which is exactly how the §9
 * violation survived a review cycle; this suite counts records everywhere.
 *
 * Red-verification (per the task's acceptance, performed before this merged):
 * with `src/memory/writeRead.ts` mutated so the prose write ran BEFORE the
 * isBlocked gate, "no new user-scope prose" failed (prose count rose by 1);
 * with the gate's early return removed so relay/pool proceeded, "no pool
 * record" and "no relay entry" both failed. Each mutation was reverted and
 * the suite re-ran green — the guard goes red if either half of the block is
 * lost.
 */
import { describe, expect, it } from 'vitest';

import type { MemoryClient, Relay } from '../../src/contracts/modules.js';
import type { MemoryRow, Read, UsualProfile } from '../../src/contracts/types.js';
import { sampleUsual } from '../../src/contracts/fixtures/index.js';
import { createLogger } from '../../src/config/logger.js';
import { createPoolStore, POOL_SCOPE } from '../../src/memory/pool.js';
import { createUserStore } from '../../src/memory/user.js';
import { writeRead } from '../../src/memory/writeRead.js';

/** In-memory substrate that counts every record in every scope. */
function fakeSubstrate() {
  const rowsByScope = new Map<string, MemoryRow[]>();
  let seq = 0;
  const client: MemoryClient = {
    ingest(scope, payload) {
      const rows = rowsByScope.get(scope) ?? [];
      rows.push({ memoryId: `mem-${++seq}`, kind: 'fact', content: payload });
      rowsByScope.set(scope, rows);
      return Promise.resolve({ jobId: `job-${seq}` });
    },
    search(scope, query) {
      const rows = rowsByScope.get(scope) ?? [];
      return Promise.resolve(rows.filter((r) => r.content.includes(query)));
    },
    ingestBatch: () => Promise.reject(new Error('unused — single ingests only in this suite')),
    remove(scope, memoryId) {
      rowsByScope.set(scope, (rowsByScope.get(scope) ?? []).filter((r) => r.memoryId !== memoryId));
      return Promise.resolve();
    },
    jobStatus: () => Promise.resolve('complete' as const),
  };
  const countRows = (scope: string) => (rowsByScope.get(scope) ?? []).length;
  return { client, countRows };
}

/** In-memory relay that records entries. */
function fakeRelay() {
  const entries: Read[] = [];
  const relay: Relay = {
    put(read) {
      entries.push(read);
      return Promise.resolve();
    },
    setJob: () => Promise.resolve(),
    list: () => Promise.resolve([]),
    drop: () => Promise.resolve(),
    stats: () => Promise.resolve({ count: 0, oldest_entry_age_seconds: 0 }),
    seed: () => Promise.resolve(0),
    reset: () => Promise.resolve(),
  };
  return { relay, entries };
}

const CHIPS: Omit<Read, 'read_id'> = {
  place: 'rosas_taqueria',
  signal: 'pretends_preference',
  driver: 'spice_tolerance_low',
  cadence: 'monthly',
  weight: 0.8,
};

async function harness(offLimits: string[]) {
  const logger = createLogger(() => {});
  const substrate = fakeSubstrate();
  const { relay, entries } = fakeRelay();
  const pool = createPoolStore({ client: substrate.client, logger, placeName: (id: string) => id.replaceAll('_', ' ') });
  const user = createUserStore({ client: substrate.client, logger });

  // The topic list travels the real path: written through setUsual — the only
  // write path for off-limits topics — and read back through usual().
  const profile: UsualProfile = { ...sampleUsual, offLimits };
  await user.setUsual('A', profile);
  const storedOffLimits = (await user.usual('A'))?.offLimits;
  if (!storedOffLimits) throw new Error('usual round-trip failed');

  return {
    deps: { relay, pool, user, logger },
    storedOffLimits,
    relayEntries: entries,
    countRows: substrate.countRows,
  };
}

describe('G2: a flagged topic yields zero new records in BOTH tiers', () => {
  it('blocks pool, relay AND user-scope prose for a confession touching the topic', async () => {
    const h = await harness(['fasting']);
    const userRowsBefore = h.countRows('A');
    const poolRowsBefore = h.countRows(POOL_SCOPE);

    const result = await writeRead(h.deps, {
      profile: 'A',
      text: 'I have been fasting before dinners out so the portions look normal.',
      chips: CHIPS,
      offLimits: h.storedOffLimits,
    });

    expect(result).toEqual({ blocked: true });
    expect(h.countRows(POOL_SCOPE) - poolRowsBefore).toBe(0); // no pool read
    expect(h.relayEntries).toHaveLength(0); // no relay entry
    expect(h.countRows('A') - userRowsBefore).toBe(0); // no user-scope prose
  });

  it('the block is case- and accent-insensitive end to end', async () => {
    const h = await harness(['crème brûlée']);
    const before = h.countRows('A');
    const result = await writeRead(h.deps, {
      profile: 'A',
      text: 'the CREME BRULEE incident, again',
      chips: CHIPS,
      offLimits: h.storedOffLimits,
    });
    expect(result).toEqual({ blocked: true });
    expect(h.countRows('A')).toBe(before);
    expect(h.relayEntries).toHaveLength(0);
  });

  it('a topic carried only by the approved chips still blocks everything', async () => {
    const h = await harness(['taqueria']);
    const before = h.countRows('A');
    const result = await writeRead(h.deps, {
      profile: 'A',
      text: 'nothing to see in the prose itself',
      chips: CHIPS, // place: rosas_taqueria
      offLimits: h.storedOffLimits,
    });
    expect(result).toEqual({ blocked: true });
    expect(h.countRows('A')).toBe(before);
    expect(h.countRows(POOL_SCOPE)).toBe(0);
    expect(h.relayEntries).toHaveLength(0);
  });

  it('control: an unrelated topic writes all three targets — the zero-assertions bite', async () => {
    const h = await harness(['fasting']);
    const userRowsBefore = h.countRows('A');
    const result = await writeRead(h.deps, {
      profile: 'A',
      text: 'I always order the mild one and say it is a preference.',
      chips: CHIPS,
      offLimits: h.storedOffLimits,
    });
    if ('blocked' in result) throw new Error('control must not block');
    expect(result.wrote).toEqual({ relay: true, pool: true, job: true, prose: true });
    expect(h.relayEntries).toHaveLength(1);
    expect(h.countRows(POOL_SCOPE)).toBe(1);
    expect(h.countRows('A') - userRowsBefore).toBe(1); // exactly the prose
  });

  it('editing the topic away via setUsual unblocks — the list is live, not cached', async () => {
    const h = await harness(['fasting']);
    await h.deps.user.setUsual('A', { ...sampleUsual, offLimits: [] });
    const cleared = (await h.deps.user.usual('A'))?.offLimits ?? [];
    const result = await writeRead(h.deps, {
      profile: 'A',
      text: 'I have been fasting before dinners out.',
      chips: CHIPS,
      offLimits: cleared,
    });
    if ('blocked' in result) throw new Error('cleared topic must not block');
    expect(result.wrote.prose).toBe(true);
  });
});
