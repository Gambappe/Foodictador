import { describe, expect, it } from 'vitest';

import type { MemoryClient, Relay } from '../contracts/modules.js';
import type { MemoryRow, RelayEntry } from '../contracts/types.js';
import { createLogger } from '../config/logger.js';
import { sampleRead } from '../contracts/fixtures/index.js';
import { POOL_SCOPE } from './pool.js';
import { forget } from './forget.js';

const OTHER_READ = { ...sampleRead, read_id: '00000000-0000-4000-8000-0000000000cc' };

function fakes(init: {
  poolRows?: MemoryRow[];
  relayEntries?: RelayEntry[];
  userRows?: Record<string, MemoryRow[]>;
  relayDropFails?: boolean;
  searchFails?: boolean;
}) {
  const poolRows = [...(init.poolRows ?? [])];
  const relayEntries = [...(init.relayEntries ?? [])];
  const userRows = Object.fromEntries(
    Object.entries(init.userRows ?? {}).map(([profile, rows]) => [profile, [...rows]]),
  );
  const removed: Array<{ scope: string; memoryId: string }> = [];
  const log: string[] = [];

  const client: MemoryClient = {
    ingest: () => Promise.reject(new Error('unused')),
    search(scope, _query, _opts) {
      if (init.searchFails) return Promise.reject(new Error('substrate down'));
      if (scope === POOL_SCOPE) return Promise.resolve([...poolRows]);
      return Promise.resolve([...(userRows[scope] ?? [])]);
    },
    remove(scope, memoryId) {
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
  return { deps, removed, log, poolRows, relayEntries };
}

function poolRow(id: string, read = sampleRead): MemoryRow {
  return { memoryId: id, kind: 'fact', content: JSON.stringify(read) };
}

describe('M8 forget', () => {
  it('deletes from all three targets and reports per-target', async () => {
    const f = fakes({
      poolRows: [poolRow('m1'), poolRow('m2')], // duplicate re-ingest: two copies, same read_id
      relayEntries: [{ read: sampleRead, received_at: '2026-07-25T19:00:00.000Z' }],
      userRows: { 'profile-a': [{ memoryId: 'u1', kind: 'fact', content: 'derived' }] },
    });
    const report = await forget(sampleRead.read_id, f.deps, {
      userMemories: [{ profile: 'profile-a', memoryId: 'u1' }],
    });
    expect(report.ok).toBe(true);
    expect(report.pool).toEqual({ status: 'deleted', count: 2 });
    expect(report.relay).toEqual({ status: 'deleted', count: 1 });
    expect(report.user).toEqual({ status: 'deleted', count: 1 });
    expect(f.removed).toContainEqual({ scope: POOL_SCOPE, memoryId: 'm1' });
    expect(f.removed).toContainEqual({ scope: POOL_SCOPE, memoryId: 'm2' });
    expect(f.removed).toContainEqual({ scope: 'profile-a', memoryId: 'u1' });
    expect(f.relayEntries).toHaveLength(0);
  });

  it('a relay-only failure is reported as such — pool purge still happens', async () => {
    const f = fakes({
      poolRows: [poolRow('m1')],
      relayEntries: [{ read: sampleRead, received_at: '2026-07-25T19:00:00.000Z' }],
      relayDropFails: true,
    });
    const report = await forget(sampleRead.read_id, f.deps);
    expect(report.ok).toBe(false);
    expect(report.relay.status).toBe('failed');
    expect(report.relay.detail).toMatch(/relay unreachable/);
    expect(report.pool).toEqual({ status: 'deleted', count: 1 });
  });

  it('an unknown read_id is not an error: nothing_to_delete everywhere, ok true', async () => {
    const f = fakes({});
    const report = await forget('never-existed', f.deps);
    expect(report.ok).toBe(true);
    expect(report.pool.status).toBe('nothing_to_delete');
    expect(report.relay.status).toBe('nothing_to_delete');
    expect(report.user.status).toBe('skipped');
  });

  it('rows that merely mention the read_id are left in place and logged', async () => {
    const f = fakes({
      poolRows: [
        poolRow('m1'),
        { memoryId: 'ep1', kind: 'episode', content: `an episode citing ${sampleRead.read_id}` },
        poolRow('m3', OTHER_READ),
      ],
    });
    const report = await forget(sampleRead.read_id, f.deps);
    expect(report.pool).toEqual({ status: 'deleted', count: 1 });
    expect(f.poolRows.map((r) => r.memoryId).sort()).toEqual(['ep1', 'm3']);
    expect(f.log.some((l) => l.includes('mention') && l.includes('left in place'))).toBe(true);
  });

  it('user target without handles reports skipped with the documented reason', async () => {
    const f = fakes({ poolRows: [poolRow('m1')] });
    const report = await forget(sampleRead.read_id, f.deps);
    expect(report.user.status).toBe('skipped');
    expect(report.user.detail).toMatch(/not keyed by read_id/);
  });

  it('a substrate failure on the pool search is a failed pool target, not a crash', async () => {
    const f = fakes({ searchFails: true });
    const report = await forget(sampleRead.read_id, f.deps);
    expect(report.pool.status).toBe('failed');
    expect(report.ok).toBe(false);
    expect(report.relay.status).toBe('nothing_to_delete');
  });
});
