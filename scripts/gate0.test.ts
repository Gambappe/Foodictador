import { afterEach, describe, expect, it } from 'vitest';

import type { MemoryClient } from '../src/contracts/modules.js';
import type { IngestJobStatus, MemoryRow } from '../src/contracts/types.js';
import { parseRead } from '../src/kernel/read.js';
import {
  entriesMatch,
  renderResults,
  stepDeletionByHandle,
  stepInductionClaim,
  syntheticReads,
  xtraceEnv,
  type GateStepResult,
  type WireEntry,
} from './gate0.js';

// `stepRestartSurvival` is deliberately not driven from vitest: it spawns two real
// relay processes and SIGKILLs one, which belongs in `npm run gate0` (where its output
// is the evidence), not in a suite that must stay fast and hermetic. The pure pieces it
// is built from — the read builder and the byte-honest comparator — are covered here.

function entry(id: string, overrides: Partial<WireEntry> = {}): WireEntry {
  const read = syntheticReads(1)[0];
  if (!read) throw new Error('syntheticReads(1) was empty');
  return { read: { ...read, read_id: id }, received_at: '2026-07-25T19:00:00.000Z', ...overrides };
}

describe('G7 gate zero — synthetic reads', () => {
  it('emits schema-valid reads with unique ids', () => {
    const reads = syntheicReadsSafe(12);
    for (const read of reads) expect(() => parseRead(read)).not.toThrow();
    expect(new Set(reads.map((r) => r.read_id)).size).toBe(12);
  });
});

function syntheicReadsSafe(n: number) {
  return syntheticReads(n);
}

describe('G7 gate zero — the restart comparator is byte-honest', () => {
  it('equal listings match', () => {
    const a = [entry('r1'), entry('r2', { ingest_job_id: 'j', pool_memories: ['m'] })];
    const b = [entry('r2', { ingest_job_id: 'j', pool_memories: ['m'] }), entry('r1')];
    expect(entriesMatch(a, b).equal).toBe(true);
  });

  it('names a missing entry, a second-level timestamp drift, and a lost ledger', () => {
    const before = [
      entry('r1', { pool_memories: ['m1'] }),
      entry('r2', { ingest_job_id: 'job' }),
      entry('r3'),
    ];
    const after = [
      entry('r1'), // ledger lost
      entry('r2', { ingest_job_id: 'job', received_at: '2026-07-25T19:00:01.000Z' }), // drifted 1s
      // r3 missing
    ];
    const verdict = entriesMatch(before, after);
    expect(verdict.equal).toBe(false);
    expect(verdict.diff.some((d) => d.includes('r1') && d.includes('pool_memories'))).toBe(true);
    expect(verdict.diff.some((d) => d.includes('r2') && d.includes('received_at'))).toBe(true);
    expect(verdict.diff.some((d) => d.includes('r3') && d.includes('missing'))).toBe(true);
  });

  it('an entry appearing from nowhere is as wrong as one disappearing', () => {
    const verdict = entriesMatch([entry('r1')], [entry('r1'), entry('ghost')]);
    expect(verdict.equal).toBe(false);
    expect(verdict.diff.some((d) => d.includes('ghost'))).toBe(true);
  });
});

/** A fake MemoryClient for the deletion step: one job, scripted statuses, a searchable scope. */
function deletionFake(init: {
  statuses: IngestJobStatus[];
  created: MemoryRow[];
  searchServes?: MemoryRow[];
}) {
  const removed: string[] = [];
  const statuses = [...init.statuses];
  const client: MemoryClient = {
    ingest: () => Promise.resolve({ jobId: 'gate-job' }),
    ingestBatch: () => Promise.reject(new Error('unused')),
    search: () => Promise.resolve([...(init.searchServes ?? [])]),
    remove: (_scope, memoryId) => {
      removed.push(memoryId);
      return Promise.resolve();
    },
    jobStatus: () => Promise.resolve(statuses.length > 1 ? (statuses.shift() as IngestJobStatus) : (statuses[0] as IngestJobStatus)),
    jobResult: () => Promise.resolve([...init.created]),
  };
  return { client, removed };
}

const row = (memoryId: string): MemoryRow => ({ memoryId, kind: 'fact', content: 'x' });

describe('G7 gate zero — deletion by handle (against fakes)', () => {
  const sleep = (): Promise<void> => Promise.resolve();
  const print = (): void => {};

  it('passes when every handle deletes and stays gone across samples', async () => {
    const f = deletionFake({ statuses: ['pending', 'complete'], created: [row('m1'), row('m2')] });
    const result = await stepDeletionByHandle({ client: f.client, sleep, print });
    expect(result.status).toBe('PASS');
    expect(f.removed).toEqual(['m1', 'm2']);
    expect(result.lines.some((l) => l.includes('sampled absence'))).toBe(true);
  });

  it('fails when a deleted id comes back in a sample — deletion must be deletion', async () => {
    const f = deletionFake({
      statuses: ['complete'],
      created: [row('m1')],
      searchServes: [row('m1')],
    });
    const result = await stepDeletionByHandle({ client: f.client, sleep, print });
    expect(result.status).toBe('FAIL');
    expect(result.lines.some((l) => l.includes('came back'))).toBe(true);
  });

  it('fails when a complete job carries no handles — the ledger premise itself', async () => {
    const f = deletionFake({ statuses: ['complete'], created: [] });
    const result = await stepDeletionByHandle({ client: f.client, sleep, print });
    expect(result.status).toBe('FAIL');
    expect(result.lines.some((l) => l.includes('memories_created'))).toBe(true);
  });
});

describe('G7 gate zero — the induction probe (against fakes)', () => {
  const print = (): void => {};
  const probe = { query: 'what people quietly regret near here', expectedPlaceNames: ['Noodle Shrine', 'Harbor Greens'] };
  const pool = (claim: string) => ({
    writeRead: () => Promise.reject(new Error('unused')),
    writeReads: () => Promise.reject(new Error('unused')),
    inducedClaim: () => Promise.resolve(claim),
  });

  it('passes only when the claim grounds in a seeded place name', async () => {
    const grounded = await stepInductionClaim({
      pool: pool('A quiet pattern: people who regret loud rooms end up at Noodle Shrine.'),
      probe,
      print,
    });
    expect(grounded.status).toBe('PASS');
    expect(grounded.lines.some((l) => l.includes('Noodle Shrine'))).toBe(true);
  });

  it('fails an empty claim with the seed-and-settle instruction', async () => {
    const empty = await stepInductionClaim({ pool: pool(''), probe, print });
    expect(empty.status).toBe('FAIL');
    expect(empty.lines.some((l) => l.includes('settle'))).toBe(true);
  });

  it('fails an un-grounded claim — induced from something, but not our seed', async () => {
    const stray = await stepInductionClaim({
      pool: pool('People love the invented Wagyu Palace.'),
      probe,
      print,
    });
    expect(stray.status).toBe('FAIL');
    expect(stray.lines.some((l) => l.includes('none of the seeded places'))).toBe(true);
  });
});

describe('G7 gate zero — the record and the gate-cli contract', () => {
  const pass = (name: string): GateStepResult => ({ name, status: 'PASS', lines: ['ok'] });
  const RAN_AT = '2026-07-25T17:00:00.000Z';

  it('all three passing produces the exact line gate-cli greps for', () => {
    const doc = renderResults([pass('a'), pass('b'), pass('c')], RAN_AT);
    expect(doc).toMatch(/^\*\*Status: PASS\*\*/m);
  });

  it('a blocked step can NEVER produce the PASS line', () => {
    const doc = renderResults(
      [pass('relay survives'), { name: 'deletion', status: 'BLOCKED', lines: ['needs creds'] }],
      RAN_AT,
    );
    expect(doc).not.toMatch(/^\*\*Status: PASS\*\*/m);
    expect(doc).toMatch(/awaiting credentials/);
    expect(doc).toMatch(/"relay survives" PASS/); // partial progress is recorded, not hidden
  });

  it('a failed step records FAIL with the escalation line', () => {
    const doc = renderResults([{ name: 'deletion', status: 'FAIL', lines: ['ghost'] }], RAN_AT);
    expect(doc).toMatch(/^\*\*Status: FAIL\*\*/m);
    expect(doc).toMatch(/Stop and escalate/);
  });
});

describe('G7 gate zero — credential gating', () => {
  const saved = { url: process.env['XTRACE_BASE_URL'], key: process.env['XTRACE_API_KEY'] };
  afterEach(() => {
    if (saved.url === undefined) delete process.env['XTRACE_BASE_URL'];
    else process.env['XTRACE_BASE_URL'] = saved.url;
    if (saved.key === undefined) delete process.env['XTRACE_API_KEY'];
    else process.env['XTRACE_API_KEY'] = saved.key;
  });

  it('names exactly what is missing', () => {
    delete process.env['XTRACE_BASE_URL'];
    delete process.env['XTRACE_API_KEY'];
    expect(xtraceEnv()).toEqual({ missing: ['XTRACE_BASE_URL', 'XTRACE_API_KEY'] });
    process.env['XTRACE_BASE_URL'] = 'http://x';
    expect(xtraceEnv()).toEqual({ missing: ['XTRACE_API_KEY'] });
    process.env['XTRACE_API_KEY'] = 'k';
    expect(xtraceEnv()).toEqual({ baseUrl: 'http://x', apiKey: 'k' });
  });
});
