import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import type { PoolStore, Relay } from '../contracts/modules.js';
import type { Read, RelayEntry } from '../contracts/types.js';
import { DEFAULT_FLAGS } from '../contracts/flags.js';
import { sampleRead } from '../contracts/fixtures/index.js';
import { createFlagStore } from '../config/flagStore.js';
import { createLogger } from '../config/logger.js';
import { createPoolView } from './poolView.js';

const OTHER: Read = { ...sampleRead, read_id: '00000000-0000-4000-8000-0000000000dd' };
const RELAY_DIVERGENT: Read = { ...sampleRead, weight: 0.11 }; // same read_id, different body

function fakes(init: { poolReads?: Read[]; relayReads?: Read[]; pool?: 'live' | 'relay-only' }) {
  const log: string[] = [];
  const pool: PoolStore = {
    writeRead: () => Promise.reject(new Error('unused')),
    readsForDriver: (driver) =>
      Promise.resolve((init.poolReads ?? []).filter((r) => r.driver === driver)),
    inducedClaim: () => Promise.reject(new Error('unused')),
  };
  const relay: Relay = {
    put: () => Promise.reject(new Error('unused')),
    setJob: () => Promise.reject(new Error('unused')),
    list: () =>
      Promise.resolve(
        (init.relayReads ?? []).map(
          (read): RelayEntry => ({ read, received_at: '2026-07-25T19:00:00.000Z' }),
        ),
      ),
    drop: () => Promise.reject(new Error('unused')),
    stats: () => Promise.resolve({ count: 0, oldest_entry_age_seconds: 0 }),
    seed: () => Promise.reject(new Error('unused')),
    reset: () => Promise.reject(new Error('unused')),
  };
  const flags = createFlagStore(
    { ...DEFAULT_FLAGS, pool: init.pool ?? 'live' },
    createLogger((l) => log.push(l)),
  );
  return { view: createPoolView({ pool, relay, flags, logger: createLogger((l) => log.push(l)) }), log };
}

describe('M6 PoolView', () => {
  it('a read present in both sources appears once — and the pool copy wins', async () => {
    const { view } = fakes({ poolReads: [sampleRead], relayReads: [RELAY_DIVERGENT] });
    const { reads, degraded } = await view.readsForDriver(sampleRead.driver);
    expect(degraded).toBe(false);
    expect(reads.filter((r) => r.read_id === sampleRead.read_id)).toHaveLength(1);
    expect(reads[0]?.weight).toBe(sampleRead.weight); // canonical, not the divergent relay copy
  });

  it('two distinct reads with identical fields but different read_ids appear twice', async () => {
    const { view } = fakes({ poolReads: [sampleRead], relayReads: [OTHER] });
    const { reads } = await view.readsForDriver(sampleRead.driver);
    expect(reads).toHaveLength(2);
  });

  it('a relay read still in flight is countable immediately', async () => {
    const { view } = fakes({ poolReads: [], relayReads: [sampleRead] });
    const { reads } = await view.readsForDriver(sampleRead.driver);
    expect(reads).toHaveLength(1);
  });

  it('relay-only mode serves the S2 induction set plus live relay contents, degraded: true', async () => {
    const inductionReads = (
      JSON.parse(
        readFileSync(new URL('../../data/seeds/induction-set.json', import.meta.url), 'utf8'),
      ) as { reads: Read[] }
    ).reads;
    const soloSeeds = inductionReads.filter((r) => r.driver === 'solo_comfort');
    expect(soloSeeds.length).toBeGreaterThanOrEqual(5); // S2 guarantees the floor

    const liveJudgeRead: Read = { ...sampleRead, driver: 'solo_comfort' };
    const { view } = fakes({ pool: 'relay-only', relayReads: [liveJudgeRead] });
    const { reads, degraded } = await view.readsForDriver('solo_comfort');
    expect(degraded).toBe(true);
    expect(reads.length).toBe(soloSeeds.length + 1); // full seed cohort + the live read
    expect(reads.some((r) => r.read_id === liveJudgeRead.read_id)).toBe(true);
    for (const seed of soloSeeds) {
      expect(reads.some((r) => r.read_id === seed.read_id), seed.read_id).toBe(true);
    }
  });

  it('the pool store is never consulted in relay-only mode', async () => {
    let poolCalls = 0;
    const pool: PoolStore = {
      writeRead: () => Promise.reject(new Error('unused')),
      readsForDriver: () => {
        poolCalls += 1;
        return Promise.resolve([]);
      },
      inducedClaim: () => Promise.reject(new Error('unused')),
    };
    const relay: Relay = {
      put: () => Promise.reject(new Error('unused')),
      setJob: () => Promise.reject(new Error('unused')),
      list: () => Promise.resolve([]),
      drop: () => Promise.reject(new Error('unused')),
      stats: () => Promise.resolve({ count: 0, oldest_entry_age_seconds: 0 }),
      seed: () => Promise.reject(new Error('unused')),
      reset: () => Promise.reject(new Error('unused')),
    };
    const flags = createFlagStore({ ...DEFAULT_FLAGS, pool: 'relay-only' }, createLogger(() => {}));
    const view = createPoolView({ pool, relay, flags, logger: createLogger(() => {}) });
    await view.readsForDriver('solo_comfort');
    expect(poolCalls).toBe(0);
  });

  it('flipping the flag at runtime flips the view without reconstruction', async () => {
    const log: string[] = [];
    const flags = createFlagStore(DEFAULT_FLAGS, createLogger((l) => log.push(l)));
    const pool: PoolStore = {
      writeRead: () => Promise.reject(new Error('unused')),
      readsForDriver: () => Promise.resolve([sampleRead]),
      inducedClaim: () => Promise.reject(new Error('unused')),
    };
    const relay: Relay = {
      put: () => Promise.reject(new Error('unused')),
      setJob: () => Promise.reject(new Error('unused')),
      list: () => Promise.resolve([]),
      drop: () => Promise.reject(new Error('unused')),
      stats: () => Promise.resolve({ count: 0, oldest_entry_age_seconds: 0 }),
      seed: () => Promise.reject(new Error('unused')),
      reset: () => Promise.reject(new Error('unused')),
    };
    const view = createPoolView({ pool, relay, flags, logger: createLogger(() => {}) });
    expect((await view.readsForDriver(sampleRead.driver)).degraded).toBe(false);
    flags.set('pool', 'relay-only', 'xtrace-not-settling');
    expect((await view.readsForDriver(sampleRead.driver)).degraded).toBe(true);
  });
});
