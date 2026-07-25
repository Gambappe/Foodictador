/**
 * The D-7 guard: **nothing on the read path may delete a relay entry except
 * `forget`.**
 *
 * Under DAG §4 D-7 the relay is the durable store of reads. XTrace extracts
 * payloads rather than storing them — gate zero ingested one read and got back
 * five prose facts with nothing joining them — so a relay entry is the only copy
 * of the read that produced it. Deleting one outside an explicit user request is
 * not a cache eviction; it is the read destroyed, permanently, with the UI still
 * reporting it pooled. That is design v0.8's [E12] failure, and until D-7 the
 * settle-sweeper committed it on purpose once per verified entry, because under
 * the old architecture it was the correct thing to do.
 *
 * That is what makes this worth a source-level guard rather than only a
 * behavioural one. The sweeper's unit tests assert it does not drop *today*; this
 * asserts nobody can reintroduce the call tomorrow while its tests still pass —
 * which is exactly what would happen if someone restored a TTL, or a
 * "housekeeping" pass, or re-derived the old verified-drop from the [E21] text
 * that still describes it.
 *
 * `forget` is the sole legitimate caller: the user asked, and the report tells
 * them what went. It is named here as an allow-list of one, so adding a second
 * deleter is a decision someone has to make in this file, in front of this
 * comment.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { StubRelay } from '../../src/contracts/stubs/index.js';
import { createLogger } from '../../src/config/logger.js';
import { createSweeper } from '../../src/memory/sweeper.js';
import { sampleRead } from '../../src/contracts/fixtures/index.js';
import type { MemoryClient, PoolStore } from '../../src/contracts/modules.js';

function source(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(`../../src/${relativePath}`, import.meta.url)), 'utf8');
}

/** Every module allowed to remove a read, and why. */
const PERMITTED_DELETERS = new Set(['memory/forget.ts']);

/** The read path — modules that run on confess/ask/sweep and must never delete. */
const READ_PATH = [
  'memory/sweeper.ts',
  'memory/poolView.ts',
  'memory/pool.ts',
  'memory/writeRead.ts',
  'cli/sweep.ts',
  'cli/ask.ts',
];

describe('D-7: the relay is the durable store', () => {
  it.each(READ_PATH)('%s never calls relay.drop', (path) => {
    expect(PERMITTED_DELETERS.has(path)).toBe(false); // the list stays honest
    // Matches `.drop(`, `relay.drop`, and a destructured `drop` being invoked.
    expect(source(path)).not.toMatch(/\bdrop\s*\(/);
  });

  it('forget is still the one module that does delete', () => {
    // The inverse assertion. If this goes red, deletion silently stopped working
    // and the guard above would have happily stayed green.
    expect(source('memory/forget.ts')).toMatch(/relay\.drop\(/);
  });

  it('a sweep over every job state leaves the store exactly as it found it', async () => {
    // The behavioural half, at the seam rather than against a fake: a real
    // StubRelay, entries in every state the sweeper can classify, swept far past
    // the window. The count before must equal the count after.
    const logger = createLogger(() => undefined);
    const relay = new StubRelay(() => new Date('2026-07-25T19:00:00.000Z'));
    const ids = ['complete', 'failed', 'pending', 'vanished', 'unannotated'];
    for (const [index, id] of ids.entries()) {
      await relay.put({ ...sampleRead, read_id: `d7-0000-4000-8000-00000000000${index}` });
      if (id !== 'unannotated') {
        await relay.setJob(`d7-0000-4000-8000-00000000000${index}`, `job-${id}`);
      }
    }

    const statuses: Record<string, 'complete' | 'failed' | 'pending'> = {
      'job-complete': 'complete',
      'job-failed': 'failed',
      'job-pending': 'pending',
    };
    const client: MemoryClient = {
      ingest: () => Promise.resolve({ jobId: 'fresh' }),
      ingestBatch: () => Promise.resolve({ jobId: 'fresh-batch' }),
      search: () => Promise.resolve([]),
      remove: () => Promise.resolve(),
      jobStatus: (jobId) => Promise.resolve(statuses[jobId] ?? 'unknown'),
      // M10's ledger is not what this suite is about; no handles is a valid job result.
      jobResult: () => Promise.resolve([]),
    };
    const pool: PoolStore = {
      writeRead: () => Promise.resolve({ jobId: 'fresh' }),
      writeReads: (reads) => Promise.resolve([{ jobId: 'fresh-batch', readIds: reads.map((r) => r.read_id) }]),
      inducedClaim: () => Promise.resolve(''),
    };

    const before = (await relay.list()).map((e) => e.read.read_id).sort();
    expect(before).toHaveLength(ids.length);

    const sweeper = createSweeper({ relay, pool, client, logger, settleWindowSeconds: 1 });
    // Several passes, an hour on: no accumulation of confidence turns into a delete.
    for (let i = 0; i < 3; i++) await sweeper.sweepOnce('2026-07-25T20:00:00.000Z');

    expect((await relay.list()).map((e) => e.read.read_id).sort()).toEqual(before);
  });
});
