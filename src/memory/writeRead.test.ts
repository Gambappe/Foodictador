import { describe, expect, it } from 'vitest';

import type { PoolStore, Relay, UserStore } from '../contracts/modules.js';
import type { Read } from '../contracts/types.js';
import { sampleRead } from '../contracts/fixtures/index.js';
import { createLogger } from '../config/logger.js';
import { assertWriteBody, guardPoolStore, guardRelay } from './guard.js';
import { writeRead, type WriteReadInput } from './writeRead.js';

interface Failures {
  relayPut?: boolean;
  poolWrite?: boolean;
  setJob?: boolean;
  prose?: boolean;
}

/** Records every store call in one ordered log so write order is assertable. */
function fakes(failures: Failures = {}) {
  const calls: string[] = [];
  const relay: Relay = {
    put(read) {
      calls.push(`relay.put:${read.read_id}`);
      return failures.relayPut ? Promise.reject(new Error('relay down')) : Promise.resolve();
    },
    setJob(readId, jobId) {
      calls.push(`relay.setJob:${readId}:${jobId}`);
      return failures.setJob ? Promise.reject(new Error('setJob down')) : Promise.resolve();
    },
    setPoolMemories: () => Promise.resolve(),
    list: () => Promise.resolve([]),
    drop: () => Promise.resolve(),
    stats: () => Promise.resolve({ count: 0, oldest_entry_age_seconds: 0 }),
    seed: () => Promise.resolve(0),
    reset: () => Promise.resolve(),
  };
  const pool: PoolStore = {
    writeRead(read) {
      calls.push(`pool.writeRead:${read.read_id}`);
      return failures.poolWrite
        ? Promise.reject(new Error('pool down'))
        : Promise.resolve({ jobId: 'job-77' });
    },
    writeReads: () => Promise.reject(new Error('the write path writes one read')),
    inducedClaim: () => Promise.resolve(''),
  };
  const user: UserStore = {
    personalClaim: () => Promise.resolve(''),
    writeProse(profile, text) {
      calls.push(`user.writeProse:${profile}:${text}`);
      return failures.prose
        ? Promise.reject(new Error('user tier down'))
        : Promise.resolve({ buffered: 0, jobId: 'job-p' });
    },
    usual: () => Promise.resolve(null),
    setUsual: () => Promise.resolve(),
    mealLog: () => Promise.resolve([]),
    setMealLog: () => Promise.resolve(),
  };
  return { calls, relay, pool, user };
}

function input(overrides: Partial<WriteReadInput> = {}): WriteReadInput {
  return {
    profile: 'A',
    text: 'I pretend the spice does not bother me.',
    chips: {
      place: 'rosas_taqueria',
      signal: 'pretends_preference',
      driver: 'spice_tolerance_low',
      cadence: 'monthly',
      weight: 0.8,
    },
    offLimits: [],
    ...overrides,
  };
}

function harness(failures: Failures = {}) {
  const lines: string[] = [];
  const logger = createLogger((m) => lines.push(m));
  const { calls, relay, pool, user } = fakes(failures);
  return { calls, lines, deps: { relay, pool, user, logger } };
}

describe('M5 writeRead — the [E24] gate', () => {
  it('a blocked topic writes NOTHING anywhere: zero calls to all three stores', async () => {
    const { calls, deps } = harness();
    const result = await writeRead(deps, input({ offLimits: ['spice'] }));
    expect(result).toEqual({ blocked: true });
    expect(calls).toEqual([]);
  });

  it('the gate is case- and accent-insensitive, like K2', async () => {
    const { calls, deps } = harness();
    const result = await writeRead(
      deps,
      input({ text: 'the crème brûlée thing again', offLimits: ['creme brulee'] }),
    );
    expect(result).toEqual({ blocked: true });
    expect(calls).toEqual([]);
  });

  it('a topic carried only by the chips still blocks everything', async () => {
    const { calls, deps } = harness();
    const result = await writeRead(
      deps,
      input({ text: 'nothing suspicious here', offLimits: ['taqueria'] }),
    );
    expect(result).toEqual({ blocked: true });
    expect(calls).toEqual([]);
  });
});

describe('M5 writeRead — order and honest reporting', () => {
  it('writes relay → pool → setJob → prose, in that order, and reports all four', async () => {
    const { calls, deps } = harness();
    const result = await writeRead(deps, input());
    if ('blocked' in result) throw new Error('unexpected block');
    expect(result.wrote).toEqual({ relay: true, pool: true, job: true });
    expect(result.prose).toEqual({ state: 'sent' });
    expect(result.warnings).toEqual([]);
    expect(calls).toHaveLength(4);
    expect(calls[0]).toBe(`relay.put:${result.read_id}`);
    expect(calls[1]).toBe(`pool.writeRead:${result.read_id}`);
    expect(calls[2]).toBe(`relay.setJob:${result.read_id}:job-77`);
    expect(calls[3]).toContain('user.writeProse:A:');
  });

  it('mints a distinct uuid-shaped read_id at approval', async () => {
    const { deps } = harness();
    const first = await writeRead(deps, input());
    const second = await writeRead(deps, input());
    if ('blocked' in first || 'blocked' in second) throw new Error('unexpected block');
    expect(first.read_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(first.read_id).not.toBe(second.read_id);
  });

  it('a relay failure means NOT pooled — no pool write, no setJob, prose still written', async () => {
    const { calls, deps } = harness({ relayPut: true });
    const result = await writeRead(deps, input());
    if ('blocked' in result) throw new Error('unexpected block');
    expect(result.wrote).toEqual({ relay: false, pool: false, job: false });
    expect(result.prose).toEqual({ state: 'sent' });
    expect(result.warnings.some((w) => w.includes('NOT pooled'))).toBe(true);
    expect(calls.filter((c) => c.startsWith('pool.'))).toEqual([]);
    expect(calls.filter((c) => c.startsWith('relay.setJob'))).toEqual([]);
    expect(calls.some((c) => c.startsWith('user.writeProse'))).toBe(true);
  });

  it('a pool failure is recoverable: success with a warning, relay entry present', async () => {
    const { calls, deps } = harness({ poolWrite: true });
    const result = await writeRead(deps, input());
    if ('blocked' in result) throw new Error('unexpected block');
    expect(result.wrote).toEqual({ relay: true, pool: false, job: false });
    expect(result.prose).toEqual({ state: 'sent' });
    expect(result.warnings.some((w) => w.includes('relay entry retained'))).toBe(true);
    expect(calls.some((c) => c.startsWith('relay.put'))).toBe(true);
    expect(calls.filter((c) => c.startsWith('relay.setJob'))).toEqual([]);
  });

  it('a setJob failure is best-effort: success with a warning, prose still written', async () => {
    const { deps, lines } = harness({ setJob: true });
    const result = await writeRead(deps, input());
    if ('blocked' in result) throw new Error('unexpected block');
    expect(result.wrote).toEqual({ relay: true, pool: true, job: false });
    expect(result.prose).toEqual({ state: 'sent' });
    expect(result.warnings.some((w) => w.includes('search fallback'))).toBe(true);
    expect(lines.some((l) => l.includes('setJob failed'))).toBe(true);
  });

  it('a prose failure is reported honestly without unwinding the pooled read', async () => {
    const { deps } = harness({ prose: true });
    const result = await writeRead(deps, input());
    if ('blocked' in result) throw new Error('unexpected block');
    expect(result.wrote).toEqual({ relay: true, pool: true, job: true });
    expect(result.prose.state).toBe('failed');
    expect(result.warnings.some((w) => w.includes('personal memory'))).toBe(true);
  });

  it('the prose payload passes through byte-identical', async () => {
    const { calls, deps } = harness();
    const text = '  exact bytes — crème brûlée\tand all ';
    await writeRead(deps, input({ text }));
    expect(calls[3]).toBe(`user.writeProse:A:${text}`);
  });
});

describe('M5 guard — the [E25] boundary', () => {
  it('assertWriteBody rejects a seventh key, a bad enum, and server-side metadata', () => {
    expect(() => assertWriteBody({ ...sampleRead, prose: 'a confession' })).toThrow(/prose/);
    expect(() => assertWriteBody({ ...sampleRead, user_id: 'profile-a' })).toThrow(/user_id/);
    expect(() => assertWriteBody({ ...sampleRead, received_at: 'now' })).toThrow(/received_at/);
    expect(() => assertWriteBody({ ...sampleRead, signal: 'posted_a_review' })).toThrow(/signal/);
    expect(assertWriteBody({ ...sampleRead })).toEqual(sampleRead);
  });

  it('a direct pool-store call, bypassing writeRead, is still stopped', async () => {
    const { pool } = fakes();
    const guarded = guardPoolStore(pool);
    const smuggled = { ...sampleRead, narrative: 'the sentence itself' } as unknown as Read;
    await expect(guarded.writeRead(smuggled)).rejects.toThrow(/narrative/);
    await expect(guarded.writeRead(sampleRead)).resolves.toEqual({ jobId: 'job-77' });
  });

  it('a direct relay put or seed, bypassing writeRead, is still stopped', async () => {
    const { relay } = fakes();
    const guarded = guardRelay(relay);
    const bad: Read = { ...sampleRead, weight: 2 };
    await expect(guarded.put(bad)).rejects.toThrow(/weight/);
    await expect(guarded.seed([sampleRead, bad])).rejects.toThrow(/weight/);
    await expect(guarded.put(sampleRead)).resolves.toBeUndefined();
  });
});
