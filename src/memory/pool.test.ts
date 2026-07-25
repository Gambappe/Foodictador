import { describe, expect, it } from 'vitest';

import type { MemoryClient } from '../contracts/modules.js';
import type { MemoryRow, SearchOpts } from '../contracts/types.js';
import { sampleRead } from '../contracts/fixtures/index.js';
import { createLogger } from '../config/logger.js';
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

describe('M2 has no counting query, on purpose', () => {
  it('exposes exactly writeRead and inducedClaim', () => {
    // Not a style assertion. Gate zero proved XTrace cannot hand a read back, so
    // a `readsForDriver` on this store could only ever return [] while looking
    // like it worked — a cohort silently counted as zero. Counting moved to the
    // relay (M6, D-7); if this list grows a read path again, that regressed.
    const { pool } = harness();
    expect(Object.keys(pool).sort()).toEqual(['inducedClaim', 'writeRead']);
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
    expect(searches[0]?.opts.topK).toBe(12); // induction stays top-k
  });

  it('returns an empty claim when the pool has no episodes', async () => {
    const { pool } = harness([row('m1', JSON.stringify(sampleRead))]);
    expect(await pool.inducedClaim('anything')).toBe('');
  });
});
