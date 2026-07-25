import { describe, expect, it } from 'vitest';

import type { MemoryClient } from '../contracts/modules.js';
import type { MemoryRow, SearchOpts } from '../contracts/types.js';
import { sampleRead } from '../contracts/fixtures/index.js';
import { createLogger } from '../config/logger.js';
import { COUNTING_K } from '../kernel/constants.js';
import { POOL_SCOPE, createPoolStore } from './pool.js';

interface RecordedSearch {
  scope: string;
  query: string;
  opts: SearchOpts;
}

function fakeClient(rows: MemoryRow[]) {
  const ingests: Array<{ scope: string; payload: string }> = [];
  const searches: RecordedSearch[] = [];
  const client: MemoryClient = {
    ingest(scope, payload) {
      ingests.push({ scope, payload });
      return Promise.resolve({ jobId: `job-${ingests.length}` });
    },
    search(scope, query, opts) {
      searches.push({ scope, query, opts });
      return Promise.resolve(rows);
    },
    remove() {
      return Promise.resolve();
    },
    jobStatus() {
      return Promise.resolve('complete' as const);
    },
  };
  return { client, ingests, searches };
}

function harness(rows: MemoryRow[] = []) {
  const lines: string[] = [];
  const logger = createLogger((m) => lines.push(m));
  const { client, ingests, searches } = fakeClient(rows);
  const pool = createPoolStore({ client, logger });
  return { pool, ingests, searches, lines };
}

function row(memoryId: string, content: string, kind: 'fact' | 'episode' = 'fact'): MemoryRow {
  return { memoryId, kind, content };
}

describe('M2 writeRead', () => {
  it('ingests the six-field read to the pool scope with read_id in the content', async () => {
    const { pool, ingests } = harness();
    const handle = await pool.writeRead(sampleRead);
    expect(handle.jobId).toBe('job-1');
    expect(ingests).toHaveLength(1);
    expect(ingests[0]?.scope).toBe(POOL_SCOPE);
    expect(ingests[0]?.payload).toContain(sampleRead.read_id);
    // The content round-trips into exactly the read that was written.
    expect(JSON.parse(ingests[0]?.payload ?? '')).toEqual(sampleRead);
  });
});

describe('M2 readsForDriver — the counting query', () => {
  it('is scoped to one driver and passes COUNTING_K', async () => {
    const { pool, searches } = harness();
    await pool.readsForDriver('spice_tolerance_low');
    expect(searches).toHaveLength(1);
    expect(searches[0]?.scope).toBe(POOL_SCOPE);
    expect(searches[0]?.query).toBe('spice_tolerance_low');
    expect(searches[0]?.opts.topK).toBe(COUNTING_K);
    expect(searches[0]?.opts.episodeSlots).toBe(0);
  });

  it('honours an explicit k override', async () => {
    const { pool, searches } = harness();
    await pool.readsForDriver('budget_ceiling', { k: 12 });
    expect(searches[0]?.opts.topK).toBe(12);
  });

  it('parses rows through parseRead and returns matching reads', async () => {
    const other = { ...sampleRead, read_id: '11111111-1111-4111-8111-111111111111' };
    const { pool } = harness([
      row('m1', JSON.stringify(sampleRead)),
      row('m2', JSON.stringify(other)),
    ]);
    const reads = await pool.readsForDriver(sampleRead.driver);
    expect(reads).toEqual([sampleRead, other]);
  });

  it('drops reads for another driver — the scope is enforced, not assumed', async () => {
    const offScope = {
      ...sampleRead,
      read_id: '22222222-2222-4222-8222-222222222222',
      driver: 'budget_ceiling' as const,
    };
    const { pool, lines } = harness([
      row('m1', JSON.stringify(sampleRead)),
      row('m2', JSON.stringify(offScope)),
    ]);
    const reads = await pool.readsForDriver(sampleRead.driver);
    expect(reads).toEqual([sampleRead]);
    // Off-scope is filtering, not damage — no warning line for it.
    expect(lines).toEqual([]);
  });

  it('skips a malformed row with a logged warning rather than crashing the Ask', async () => {
    const badWeight = { ...sampleRead, weight: 7 };
    const { pool, lines } = harness([
      row('m1', 'not json at all'),
      row('m2', JSON.stringify(badWeight)),
      row('m3', JSON.stringify(sampleRead)),
    ]);
    const reads = await pool.readsForDriver(sampleRead.driver);
    expect(reads).toEqual([sampleRead]);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('m1');
    expect(lines[0]).toContain('not JSON');
    expect(lines[1]).toContain('m2');
    expect(lines[1]).toContain('weight');
  });

  it('a read with an extra key is malformed, not countable', async () => {
    const smuggled = { ...sampleRead, received_at: '2026-07-25T12:00:00Z' };
    const { pool, lines } = harness([row('m1', JSON.stringify(smuggled))]);
    expect(await pool.readsForDriver(sampleRead.driver)).toEqual([]);
    expect(lines[0]).toContain('received_at');
  });
});

describe('M2 inducedClaim — the induction query', () => {
  it('reserves episode slots and prefers the episode content', async () => {
    const { pool, searches } = harness([
      row('m1', JSON.stringify(sampleRead)),
      row('m2', 'Hygiene complaints under-predict loyalty here.', 'episode'),
    ]);
    const claim = await pool.inducedClaim('what predicts loyalty');
    expect(claim).toBe('Hygiene complaints under-predict loyalty here.');
    expect(searches[0]?.opts.episodeSlots).toBeGreaterThan(0);
    expect(searches[0]?.opts.topK).toBeLessThan(COUNTING_K); // top-k stays top-k
  });

  it('returns an empty claim when the pool has no episodes', async () => {
    const { pool } = harness([row('m1', JSON.stringify(sampleRead))]);
    expect(await pool.inducedClaim('anything')).toBe('');
  });
});
