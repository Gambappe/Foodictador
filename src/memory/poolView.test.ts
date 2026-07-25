import { describe, expect, it } from 'vitest';

import type { Relay } from '../contracts/modules.js';
import type { Read, RelayEntry } from '../contracts/types.js';
import { DEFAULT_FLAGS } from '../contracts/flags.js';
import { sampleRead } from '../contracts/fixtures/index.js';
import { createFlagStore } from '../config/flagStore.js';
import { createLogger } from '../config/logger.js';
import { createPoolView } from './poolView.js';

const OTHER: Read = { ...sampleRead, read_id: '00000000-0000-4000-8000-0000000000dd' };
const OTHER_DRIVER: Read = { ...sampleRead, read_id: '00000000-0000-4000-8000-0000000000ee', driver: 'solo_comfort' };

function fakes(init: { relayReads?: Read[]; pool?: 'live' | 'relay-only' }) {
  const log: string[] = [];
  let listCalls = 0;
  const relay: Relay = {
    put: () => Promise.reject(new Error('unused')),
    setJob: () => Promise.reject(new Error('unused')),
    list: () => {
      listCalls += 1;
      return Promise.resolve(
        (init.relayReads ?? []).map(
          (read): RelayEntry => ({ read, received_at: '2026-07-25T19:00:00.000Z' }),
        ),
      );
    },
    drop: () => Promise.reject(new Error('unused')),
    stats: () => Promise.resolve({ count: 0, oldest_entry_age_seconds: 0 }),
    seed: () => Promise.reject(new Error('unused')),
    reset: () => Promise.reject(new Error('unused')),
  };
  const logger = createLogger((l) => log.push(l));
  const flags = createFlagStore({ ...DEFAULT_FLAGS, pool: init.pool ?? 'live' }, logger);
  return {
    view: createPoolView({ relay, flags, logger }),
    log,
    flags,
    listCalls: () => listCalls,
  };
}

describe('M6 PoolView', () => {
  it('counts the relay, which holds the exact reads (D-7)', async () => {
    const { view } = fakes({ relayReads: [sampleRead, OTHER] });
    const { reads, degraded } = await view.readsForDriver(sampleRead.driver);
    expect(degraded).toBe(false);
    expect(reads.map((r) => r.read_id)).toEqual([sampleRead.read_id, OTHER.read_id]);
  });

  it('filters to the requested driver', async () => {
    const { view } = fakes({ relayReads: [sampleRead, OTHER_DRIVER] });
    expect((await view.readsForDriver(sampleRead.driver)).reads).toHaveLength(1);
    expect((await view.readsForDriver('solo_comfort')).reads).toHaveLength(1);
  });

  it('a read is countable the instant it is confessed — no settle wait', async () => {
    // The property [E20] existed for and D-7 keeps: the relay is read directly,
    // so a confession is citable before any XTrace ingest has completed.
    const { view } = fakes({ relayReads: [sampleRead] });
    expect((await view.readsForDriver(sampleRead.driver)).reads).toHaveLength(1);
  });

  it('counts a duplicated read_id once, and says it did', async () => {
    // A double-counted read is a cohort clearing the k>=5 floor without five
    // people behind it — the k-anonymity floor leaking by arithmetic.
    const divergent: Read = { ...sampleRead, weight: 0.11 }; // same read_id, different body
    const { view, log } = fakes({ relayReads: [sampleRead, divergent] });
    const { reads } = await view.readsForDriver(sampleRead.driver);
    expect(reads).toHaveLength(1);
    expect(reads[0]?.weight).toBe(sampleRead.weight); // first occurrence wins
    expect(log.join('\n')).toContain('duplicate read_id');
  });

  it('says nothing about duplicates when there are none', async () => {
    const { view, log } = fakes({ relayReads: [sampleRead, OTHER] });
    await view.readsForDriver(sampleRead.driver);
    expect(log.join('\n')).not.toContain('duplicate');
  });

  it('two distinct reads with identical fields but different read_ids appear twice', async () => {
    const { view } = fakes({ relayReads: [sampleRead, OTHER] });
    expect((await view.readsForDriver(sampleRead.driver)).reads).toHaveLength(2);
  });

  it('an empty relay is an empty cohort, not an error', async () => {
    const { view } = fakes({ relayReads: [] });
    expect(await view.readsForDriver(sampleRead.driver)).toEqual({ reads: [], degraded: false });
  });

  it('degraded reports induction availability, and counts stay exact', async () => {
    // Under D-7 `degraded` no longer means "counts may be incomplete" — the
    // relay is read either way. It means there is no induced claim for the card.
    // A test that asserted a smaller read set here would be encoding the old,
    // wrong meaning back into the contract.
    const { view } = fakes({ pool: 'relay-only', relayReads: [sampleRead, OTHER] });
    const { reads, degraded } = await view.readsForDriver(sampleRead.driver);
    expect(degraded).toBe(true);
    expect(reads).toHaveLength(2);
  });

  it('flipping the flag at runtime flips degraded without reconstruction', async () => {
    const { view, flags } = fakes({ relayReads: [sampleRead] });
    expect((await view.readsForDriver(sampleRead.driver)).degraded).toBe(false);
    flags.set('pool', 'relay-only', 'xtrace-not-settling');
    expect((await view.readsForDriver(sampleRead.driver)).degraded).toBe(true);
  });

  it('reads the relay once per query, in both flag states', async () => {
    // The relay is the only source now; a view that skipped it in either state
    // would return an empty cohort while reporting success.
    const { view, listCalls, flags } = fakes({ relayReads: [sampleRead] });
    await view.readsForDriver(sampleRead.driver);
    expect(listCalls()).toBe(1);
    flags.set('pool', 'relay-only', 'xtrace-not-settling');
    await view.readsForDriver(sampleRead.driver);
    expect(listCalls()).toBe(2);
  });
});
