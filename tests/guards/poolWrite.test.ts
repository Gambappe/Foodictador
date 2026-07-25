/**
 * G1 — pool-write schema guard, adversarial suite (design v0.8 [E25]).
 *
 * Every pool-bound and relay-bound write body must be EXACTLY the six
 * READ_KEYS fields, closed to extra properties, enums respected —
 * reject-by-construction, because CI cannot recognise "narrative text". The
 * guard under test is M5's src/memory/guard.ts; the point proven here is that
 * it sits at the STORE boundary, so a caller that bypasses writeRead and hits
 * a store directly is still stopped, and a rejected body never reaches the
 * underlying store at all.
 */
import { describe, expect, it } from 'vitest';

import type { PoolStore, Relay } from '../../src/contracts/modules.js';
import type { Read } from '../../src/contracts/types.js';
import { READ_KEYS } from '../../src/contracts/types.js';
import { sampleRead } from '../../src/contracts/fixtures/index.js';
import { createLogger } from '../../src/config/logger.js';
import { assertWriteBody, guardPoolStore, guardRelay } from '../../src/memory/guard.js';
import { writeRead } from '../../src/memory/writeRead.js';

function recordingPool() {
  const writes: Read[] = [];
  const pool: PoolStore = {
    writeRead(read) {
      writes.push(read);
      return Promise.resolve({ jobId: 'job-1' });
    },
    inducedClaim: () => Promise.resolve(''),
  };
  return { pool, writes };
}

function recordingRelay() {
  const puts: Read[] = [];
  const seeds: Read[][] = [];
  const relay: Relay = {
    put(read) {
      puts.push(read);
      return Promise.resolve();
    },
    seed(reads) {
      seeds.push(reads);
      return Promise.resolve(reads.length);
    },
    setJob: () => Promise.resolve(),
    list: () => Promise.resolve([]),
    drop: () => Promise.resolve(),
    stats: () => Promise.resolve({ count: 0, oldest_entry_age_seconds: 0 }),
    reset: () => Promise.resolve(),
  };
  return { relay, puts, seeds };
}

/** The adversarial bodies — every way a write has tried to smuggle something. */
const REJECTED: Array<[label: string, body: unknown, messageMatch: RegExp]> = [
  ['confession prose as a field', { ...sampleRead, prose: 'the sentence itself' }, /prose/],
  ['narrative text as a field', { ...sampleRead, narrative: 'what they actually typed' }, /narrative/],
  ['a profile user_id', { ...sampleRead, user_id: 'profile-a' }, /user_id/],
  ['a seventh key', { ...sampleRead, mood: 'wistful' }, /mood/],
  ["the relay's received_at metadata", { ...sampleRead, received_at: '2026-07-25T12:00:00Z' }, /received_at/],
  ["the relay's ingest_job_id metadata", { ...sampleRead, ingest_job_id: 'job-9' }, /ingest_job_id/],
  ['a bad signal enum', { ...sampleRead, signal: 'posted_a_review' }, /signal/],
  ['a bad driver enum', { ...sampleRead, driver: 'spice_tolerance_high' }, /driver/],
  ['a bad cadence enum', { ...sampleRead, cadence: 'hourly' }, /cadence/],
  ['weight above 1', { ...sampleRead, weight: 1.0000001 }, /weight/],
  ['weight as a string', { ...sampleRead, weight: '0.5' }, /weight/],
  ['NaN weight', { ...sampleRead, weight: Number.NaN }, /weight/],
  ['an empty read_id', { ...sampleRead, read_id: '' }, /read_id/],
  ['bare prose instead of an object', 'I never told anyone about the taqueria.', /plain object/],
  ['an array of reads', [sampleRead], /plain object/],
  ['null', null, /plain object/],
];

const MISSING: Array<[string, unknown]> = READ_KEYS.map((key) => {
  const body: Record<string, unknown> = { ...sampleRead };
  delete body[key];
  return [`missing "${key}"`, body];
});

describe('G1: assertWriteBody rejects every smuggling shape', () => {
  for (const [label, body, match] of REJECTED) {
    it(`rejects ${label}`, () => {
      expect(() => assertWriteBody(body)).toThrow(match);
    });
  }
  for (const [label, body] of MISSING) {
    it(`rejects a body ${label}`, () => {
      expect(() => assertWriteBody(body)).toThrow(/missing/);
    });
  }
  it('accepts exactly the six-field read, unchanged', () => {
    expect(assertWriteBody({ ...sampleRead })).toEqual(sampleRead);
  });
});

describe('G1: the guard sits at the store boundary, not in the caller', () => {
  it('a DIRECT pool-store call bypassing writeRead is still stopped — nothing reaches the store', async () => {
    const { pool, writes } = recordingPool();
    const guarded = guardPoolStore(pool);
    for (const [, body] of REJECTED) {
      await expect(guarded.writeRead(body as Read)).rejects.toThrow();
    }
    expect(writes).toHaveLength(0); // rejected bodies never touched the substrate
  });

  it('a DIRECT relay put bypassing writeRead is still stopped', async () => {
    const { relay, puts } = recordingRelay();
    const guarded = guardRelay(relay);
    for (const [, body] of REJECTED) {
      await expect(guarded.put(body as Read)).rejects.toThrow();
    }
    expect(puts).toHaveLength(0);
  });

  it('one bad read poisons a whole relay seed batch — all-or-nothing', async () => {
    const { relay, seeds } = recordingRelay();
    const guarded = guardRelay(relay);
    const bad: Read = { ...sampleRead, weight: 2 };
    await expect(guarded.seed([sampleRead, bad])).rejects.toThrow(/weight/);
    expect(seeds).toHaveLength(0);
  });

  it('valid bodies pass through the guard byte-identical', async () => {
    const { pool, writes } = recordingPool();
    const { relay, puts } = recordingRelay();
    await guardPoolStore(pool).writeRead(sampleRead);
    await guardRelay(relay).put(sampleRead);
    expect(writes).toEqual([sampleRead]);
    expect(puts).toEqual([sampleRead]);
  });
});

describe('G1: the legitimate writeRead path passes through guarded stores', () => {
  it('writeRead over GUARDED stores succeeds and lands exactly six-field reads', async () => {
    const logger = createLogger(() => {});
    const { pool, writes } = recordingPool();
    const { relay, puts } = recordingRelay();
    const user = {
      writeProse: () => Promise.resolve({ jobId: 'p' }),
      usual: () => Promise.resolve(null),
      setUsual: () => Promise.resolve(),
      mealLog: () => Promise.resolve([]),
      setMealLog: () => Promise.resolve(),
    };

    const result = await writeRead(
      { relay: guardRelay(relay), pool: guardPoolStore(pool), user, logger },
      {
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
      },
    );

    if ('blocked' in result) throw new Error('unexpected block');
    expect(result.wrote).toEqual({ relay: true, pool: true, job: true, prose: true });
    // What landed is exactly the closed six-field schema, in both stores.
    expect(Object.keys(puts[0] ?? {}).sort()).toEqual([...READ_KEYS].sort());
    expect(Object.keys(writes[0] ?? {}).sort()).toEqual([...READ_KEYS].sort());
    expect(puts[0]).toEqual(writes[0]);
  });
});
