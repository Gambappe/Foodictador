import { describe, expect, it } from 'vitest';

import type { MemoryClient } from '../contracts/modules.js';
import type { MemoryRow, Read, SearchOpts } from '../contracts/types.js';
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
  const batches: Array<{ scope: string; payloads: string[]; convId: string }> = [];
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
    // M10's ledger is not what this suite is about; no handles is a valid job result.
    jobResult: () => Promise.resolve([]),
    ingestBatch(scope, payloads, convId) {
      batches.push({ scope, payloads: [...payloads], convId });
      return Promise.resolve({ jobId: `batch-${batches.length}` });
    },
  };
  return { client, ingests, searches, batches };
}

function harness(rows: MemoryRow[] = []) {
  const lines: string[] = [];
  const logger = createLogger((m) => lines.push(m));
  const { client, ingests, searches, batches } = fakeClient(rows);
  // Real place names: the whole point of M14's prose is that the extractor never sees an id.
  const pool = createPoolStore({
    client,
    logger,
    placeName: (id) => ({ rosas_taqueria: "Rosa's Taqueria", noodle_shrine: 'Noodle Shrine' })[id],
  });
  return { pool, ingests, searches, batches, lines };
}

function row(memoryId: string, content: string, kind: 'fact' | 'episode' = 'fact'): MemoryRow {
  return { memoryId, kind, content };
}

describe('M2 writeRead — prose, not notation (M14)', () => {
  it('sends an English sentence, not JSON', async () => {
    // The payload used to be `JSON.stringify(read)`, which had to survive verbatim
    // because `readsForDriver` parsed it back. D-7 deleted that path, so the payload is
    // free — and notation is the substrate's worst input (guide R4: 0 facts from 8
    // complete records).
    const { pool, ingests } = harness();
    const handle = await pool.writeRead({ ...sampleRead, place: 'rosas_taqueria' });
    expect(handle.jobId).toBe('job-1');
    expect(ingests).toHaveLength(1);
    expect(ingests[0]?.scope).toBe(POOL_SCOPE);
    const payload = ingests[0]?.payload ?? '';
    // `JSON.parse` returns `any`, so it is wrapped rather than returned from the arrow.
    expect(() => {
      JSON.parse(payload);
    }).toThrow(); // it is a sentence, not a record
    expect(payload).toMatch(/^Someone who /);
    expect(payload).toMatch(/What is really going on is that /);
  });

  it('never lets a raw place id reach the substrate', async () => {
    // The measured failure this exists for: feed the extractor `rosas_taqueria` and the
    // induced claim comes back carrying `rosas_taqueria`, onto a card (L4). The read_id
    // must not travel either — it identifies the read, and induction has no use for it.
    const { pool, ingests } = harness();
    await pool.writeRead({ ...sampleRead, place: 'rosas_taqueria' });
    const payload = ingests[0]?.payload ?? '';
    expect(payload).toContain("Rosa's Taqueria");
    expect(payload).not.toContain('rosas_taqueria');
    expect(payload).not.toContain(sampleRead.read_id);
    expect(payload).not.toMatch(/[a-z]+_[a-z]+/); // no enum token in any field
  });

  it('refuses a read whose place is not in the corpus rather than sending the id', async () => {
    // Falling back to the id would silently undo the point of the whole change.
    const { pool } = harness();
    await expect(pool.writeRead({ ...sampleRead, place: 'not_a_real_place' })).rejects.toThrow(
      /unknown place/,
    );
  });
});

describe('M2 writeReads — batched into conversations (M12)', () => {
  const read = (place: string, driver: Read['driver'], n: number): Read => ({
    ...sampleRead,
    read_id: `00000000-0000-4000-8000-00000000000${n}`,
    place,
    driver,
  });

  it('groups by driver, so a conversation is one cohort\'s worth of reads', async () => {
    // Episodes are conversation summaries, so what shares a conv_id is what a claim can
    // span. Grouping by driver makes each conversation thematically coherent and maps it
    // onto exactly the cohort a citation is about.
    const { pool, batches } = harness();
    await pool.writeReads([
      read('rosas_taqueria', 'spice_tolerance_low', 1),
      read('noodle_shrine', 'acclaim_skeptic', 2),
      read('noodle_shrine', 'spice_tolerance_low', 3),
    ]);
    expect(batches).toHaveLength(2);
    const byConv = new Map(batches.map((b) => [b.convId, b.payloads]));
    expect(byConv.get(`${POOL_SCOPE}:spice_tolerance_low:0`)).toHaveLength(2);
    expect(byConv.get(`${POOL_SCOPE}:acclaim_skeptic:0`)).toHaveLength(1);
  });

  it('uses ONE call per conversation, not one per read', async () => {
    // The M12 defect in one assertion: 3 reads used to be 3 ingests in 3 conversations,
    // so every episode paraphrased a single read.
    const { pool, ingests, batches } = harness();
    await pool.writeReads([
      read('rosas_taqueria', 'spice_tolerance_low', 1),
      read('noodle_shrine', 'spice_tolerance_low', 2),
      read('rosas_taqueria', 'spice_tolerance_low', 3),
    ]);
    expect(batches).toHaveLength(1);
    expect(ingests).toHaveLength(0); // the single-read path was not used at all
  });

  it('chunks a cohort larger than one conversation, with distinct conv_ids', async () => {
    const { pool, batches } = harness();
    const many = Array.from({ length: 25 }, (_, i) =>
      read('rosas_taqueria', 'spice_tolerance_low', i % 10),
    );
    await pool.writeReads(many);
    expect(batches.map((b) => b.convId)).toEqual([
      `${POOL_SCOPE}:spice_tolerance_low:0`,
      `${POOL_SCOPE}:spice_tolerance_low:1`,
    ]);
    expect(batches[0]?.payloads).toHaveLength(20);
    expect(batches[1]?.payloads).toHaveLength(5);
  });

  it('skips an unrenderable read with a log line instead of failing the batch', async () => {
    // Different from the single-read path, which throws: losing one read from the
    // induction feed is not worth failing a 220-read seed, and the relay holds it anyway.
    const { pool, batches, lines } = harness();
    await pool.writeReads([
      read('rosas_taqueria', 'spice_tolerance_low', 1),
      read('not_a_real_place', 'spice_tolerance_low', 2),
    ]);
    expect(batches[0]?.payloads).toHaveLength(1);
    expect(lines.join('\n')).toContain('not in the corpus');
  });

  it('sends nothing at all when no read can be rendered', async () => {
    const { pool, batches } = harness();
    await pool.writeReads([read('not_a_real_place', 'spice_tolerance_low', 1)]);
    expect(batches).toHaveLength(0);
  });
});

describe('M2 has no counting query, on purpose', () => {
  it('exposes exactly the induction feed and the induction query', () => {
    // Not a style assertion. Gate zero proved XTrace cannot hand a read back, so
    // a `readsForDriver` on this store could only ever return [] while looking
    // like it worked — a cohort silently counted as zero. Counting moved to the
    // relay (M6, D-7); if this list grows a read path again, that regressed.
    const { pool } = harness();
    expect(Object.keys(pool).sort()).toEqual(['inducedClaim', 'writeRead', 'writeReads']);
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
    // Headroom, not a tuned number. Measured against a clean scope holding the full seed:
    // facts are returned before episodes and the first episode landed at index 10, so the
    // old top-k of 12 was two rows from dropping the claim. And `episode_slots` cannot be
    // relied on — the API accepts a made-up parameter with 200 (M13) — so top-k is the
    // protection that actually works.
    expect(searches[0]?.opts.topK).toBeGreaterThanOrEqual(40);
  });

  it('returns an empty claim when the pool has no episodes', async () => {
    const { pool } = harness([row('m1', JSON.stringify(sampleRead))]);
    expect(await pool.inducedClaim('anything')).toBe('');
  });
});
