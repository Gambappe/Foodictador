import { describe, expect, it } from 'vitest';

import type { MemoryClient, Relay } from '../contracts/modules.js';
import type { MemoryRow, RelayEntry } from '../contracts/types.js';
import { createLogger } from '../config/logger.js';
import { sampleRead } from '../contracts/fixtures/index.js';
import { POOL_SCOPE } from './pool.js';
import { forget } from './forget.js';

function fakes(init: {
  poolRows?: MemoryRow[];
  relayEntries?: RelayEntry[];
  relayDropFails?: boolean;
  removeFails?: boolean;
}) {
  const poolRows = [...(init.poolRows ?? [])];
  const relayEntries = [...(init.relayEntries ?? [])];
  const removed: Array<{ scope: string; memoryId: string }> = [];
  const searches: string[] = [];
  const log: string[] = [];

  const client: MemoryClient = {
    ingest: () => Promise.reject(new Error('unused')),
    ingestBatch: () => Promise.reject(new Error('unused')),
    search(scope, _query, _opts) {
      // Recorded, not rejected: the assertion that forget performs NO search is
      // more useful than a fake that crashes when it does.
      searches.push(scope);
      return Promise.resolve([...poolRows]);
    },
    remove(scope, memoryId) {
      if (init.removeFails) return Promise.reject(new Error('substrate down'));
      removed.push({ scope, memoryId });
      if (scope === POOL_SCOPE) {
        const i = poolRows.findIndex((r) => r.memoryId === memoryId);
        if (i >= 0) poolRows.splice(i, 1);
      }
      return Promise.resolve();
    },
    jobStatus: () => Promise.resolve('unknown'),
  };

  const relay: Relay = {
    put: () => Promise.reject(new Error('unused')),
    setJob: () => Promise.reject(new Error('unused')),
    list: () => Promise.resolve(relayEntries.map((e) => ({ ...e }))),
    drop(readId) {
      if (init.relayDropFails) return Promise.reject(new Error('relay unreachable'));
      const i = relayEntries.findIndex((e) => e.read.read_id === readId);
      if (i >= 0) relayEntries.splice(i, 1);
      return Promise.resolve();
    },
    stats: () => Promise.resolve({ count: relayEntries.length, oldest_entry_age_seconds: 0 }),
    seed: () => Promise.reject(new Error('unused')),
    reset: () => Promise.reject(new Error('unused')),
  };

  const deps = { client, relay, logger: createLogger((l) => log.push(l)) };
  return { deps, removed, searches, log, poolRows, relayEntries };
}

function entry(): RelayEntry {
  return { read: sampleRead, received_at: '2026-07-25T19:00:00.000Z' };
}

describe('M8 forget — the relay delete is the authoritative one (D-7)', () => {
  it('removes the read from the store, so it leaves every cohort count', async () => {
    const f = fakes({ relayEntries: [entry()] });
    const report = await forget(sampleRead.read_id, f.deps);
    expect(report.ok).toBe(true);
    expect(report.relay).toEqual({ status: 'deleted', count: 1 });
    expect(f.relayEntries).toHaveLength(0);
  });

  it('an unknown read_id is not an error', async () => {
    const f = fakes({});
    const report = await forget('never-existed', f.deps);
    expect(report.ok).toBe(true);
    expect(report.relay.status).toBe('nothing_to_delete');
  });

  it('a relay failure is reported and makes the whole report not-ok', async () => {
    // This is the failure that matters now: the relay holds the read, so a
    // failed relay delete means the read is still there and still counted.
    const f = fakes({ relayEntries: [entry()], relayDropFails: true });
    const report = await forget(sampleRead.read_id, f.deps);
    expect(report.ok).toBe(false);
    expect(report.relay.status).toBe('failed');
    expect(report.relay.detail).toMatch(/relay unreachable/);
  });
});

describe('M8 forget — the XTrace targets are honest about what they cannot do', () => {
  it('reports pool as SKIPPED without handles, never nothing_to_delete', async () => {
    // The regression this locks: forget used to search the pool for JSON rows
    // holding the read_id, find none — because XTrace stores prose, not the read
    // — and report `nothing_to_delete`. That told the user "there was nothing
    // there" while five prose facts derived from their confession stayed put. A
    // deletion report that overstates itself is the one bug this flow cannot have.
    const f = fakes({ relayEntries: [entry()] });
    const report = await forget(sampleRead.read_id, f.deps);
    expect(report.pool.status).toBe('skipped');
    expect(report.pool.detail).toMatch(/not keyed by read_id/);
    expect(report.pool.status).not.toBe('nothing_to_delete');
  });

  it('reports user as SKIPPED without handles, with the reason', async () => {
    const f = fakes({});
    const report = await forget(sampleRead.read_id, f.deps);
    expect(report.user.status).toBe('skipped');
    expect(report.user.detail).toMatch(/not keyed by read_id/);
  });

  it('never searches XTrace to decide what to delete', async () => {
    // A fuzzy search choosing deletion targets means a near-miss destroys
    // someone else's row. Handles or nothing.
    const f = fakes({
      poolRows: [{ memoryId: 'm1', kind: 'fact', content: `mentions ${sampleRead.read_id}` }],
      relayEntries: [entry()],
    });
    await forget(sampleRead.read_id, f.deps);
    expect(f.searches).toEqual([]);
    expect(f.removed).toEqual([]);
  });

  it('deletes both XTrace scopes when the caller supplies handles', async () => {
    const f = fakes({ relayEntries: [entry()] });
    const report = await forget(sampleRead.read_id, f.deps, {
      poolMemories: ['m1', 'm2'],
      userMemories: [{ profile: 'profile-a', memoryId: 'u1' }],
    });
    expect(report.ok).toBe(true);
    expect(report.pool).toEqual({ status: 'deleted', count: 2 });
    expect(report.user).toEqual({ status: 'deleted', count: 1 });
    expect(f.removed).toContainEqual({ scope: POOL_SCOPE, memoryId: 'm1' });
    expect(f.removed).toContainEqual({ scope: POOL_SCOPE, memoryId: 'm2' });
    expect(f.removed).toContainEqual({ scope: 'profile-a', memoryId: 'u1' });
  });

  it('a substrate failure deleting a handle is failed, not a crash', async () => {
    const f = fakes({ relayEntries: [entry()], removeFails: true });
    const report = await forget(sampleRead.read_id, f.deps, { poolMemories: ['m1'] });
    expect(report.pool.status).toBe('failed');
    expect(report.ok).toBe(false);
    // And the authoritative delete still happened — targets are independent.
    expect(report.relay.status).toBe('deleted');
    expect(f.relayEntries).toHaveLength(0);
  });
});
