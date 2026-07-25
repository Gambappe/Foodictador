import { describe, expect, it } from 'vitest';

import type { MemoryClient, PoolStore, Relay } from '../contracts/modules.js';
import type { IngestJobStatus, JobHandle, MemoryRow, Read, RelayEntry, RelayStats } from '../contracts/types.js';
import { createLogger } from '../config/logger.js';
import { sampleRead } from '../contracts/fixtures/index.js';
import { createSweeper } from './sweeper.js';

const NOW = '2026-07-25T19:00:00.000Z';
const WINDOW = 480;

function at(secondsBeforeNow: number): string {
  return new Date(Date.parse(NOW) - secondsBeforeNow * 1000).toISOString();
}

/**
 * Purpose-built fakes: precise control over job states.
 *
 * The relay fake still implements `drop` and still records every call, even
 * though nothing should ever call it. That is deliberate — a fake that threw on
 * `drop` would turn the regression into a crash somewhere inside the sweep, and
 * `calls.drop` is the assertion that matters most in this file.
 */
function fakes(init: {
  entries: RelayEntry[];
  jobs?: Record<string, IngestJobStatus>;
  failSetJob?: boolean;
  /** M10: what a succeeded job's result carries, per job id. */
  jobResults?: Record<string, MemoryRow[]>;
  setPoolMemoriesFails?: boolean;
}) {
  const entries = [...init.entries];
  const ingested: Read[] = [];
  const jobs = { ...(init.jobs ?? {}) };
  const log: string[] = [];
  const calls = {
    writeRead: 0,
    setJob: 0,
    drop: [] as string[],
    setPoolMemories: [] as Array<{ readId: string; ids: string[] }>,
    jobResult: 0,
  };
  let jobSeq = 0;

  const relay: Relay = {
    put: () => Promise.reject(new Error('unused')),
    setJob(readId, jobId) {
      if (init.failSetJob) return Promise.reject(new Error('relay down'));
      calls.setJob += 1;
      const entry = entries.find((e) => e.read.read_id === readId);
      if (entry) entry.ingest_job_id = jobId;
      return Promise.resolve();
    },
    setPoolMemories(readId, memoryIds) {
      if (init.setPoolMemoriesFails) return Promise.reject(new Error('relay down'));
      calls.setPoolMemories.push({ readId, ids: [...memoryIds] });
      const entry = entries.find((e) => e.read.read_id === readId);
      if (entry) entry.pool_memories = [...memoryIds];
      return Promise.resolve();
    },
    list: () => Promise.resolve(entries.map((e) => ({ ...e }))),
    drop(readId) {
      calls.drop.push(readId);
      const index = entries.findIndex((e) => e.read.read_id === readId);
      if (index >= 0) entries.splice(index, 1);
      return Promise.resolve();
    },
    stats(): Promise<RelayStats> {
      const oldest = entries.reduce(
        (max, e) => Math.max(max, (Date.parse(NOW) - Date.parse(e.received_at)) / 1000),
        0,
      );
      return Promise.resolve({ count: entries.length, oldest_entry_age_seconds: oldest });
    },
    seed: () => Promise.reject(new Error('unused')),
    reset: () => Promise.reject(new Error('unused')),
  };

  const pool: PoolStore = {
    writeRead(read): Promise<JobHandle> {
      calls.writeRead += 1;
      ingested.push(read);
      jobSeq += 1;
      const jobId = `fresh-job-${jobSeq}`;
      jobs[jobId] = 'pending';
      return Promise.resolve({ jobId });
    },
    // The sweeper backfills ONE read at a time by design — it recovers individual
    // entries, and a batch path here would group unrelated reads that happened to fail
    // together. Rejecting proves it is never called.
    writeReads: () => Promise.reject(new Error('the sweeper must backfill per read')),
    inducedClaim: () => Promise.reject(new Error('unused')),
  };

  const client: MemoryClient = {
    ingest: () => Promise.reject(new Error('unused')),
    ingestBatch: () => Promise.reject(new Error('unused')),
    search: () => Promise.reject(new Error('unused')),
    remove: () => Promise.reject(new Error('unused')),
    jobStatus: (jobId) => Promise.resolve(jobs[jobId] ?? 'unknown'),
    jobResult: (jobId) => {
      calls.jobResult += 1;
      return Promise.resolve(init.jobResults?.[jobId] ?? []);
    },
  };

  const sweeper = createSweeper({
    relay,
    pool,
    client,
    logger: createLogger((line) => log.push(line)),
    settleWindowSeconds: WINDOW,
  });

  return { sweeper, entries, ingested, jobs, calls, log };
}

/** An entry old enough to be past the settle window, annotated with a job. */
function settled(id: string, jobId: string): RelayEntry {
  return {
    read: read(id),
    received_at: new Date(Date.parse(NOW) - (WINDOW + 60) * 1000).toISOString(),
    ingest_job_id: jobId,
  };
}

function read(id: string, driver: Read['driver'] = 'solo_comfort'): Read {
  return { ...sampleRead, read_id: id, driver };
}

describe('M7 induction backfill — it deletes nothing', () => {
  /**
   * The load-bearing test in this file. Under D-7 the relay is the only place a
   * read exists, so a `drop` here is the read destroyed with no second copy —
   * exactly the [E12] loss the sweeper was written to prevent, committed by the
   * sweeper itself. Every state below is asserted against `calls.drop`.
   */
  it.each([
    ['a confirmed ingest', { jobs: { j: 'complete' as IngestJobStatus } }],
    ['a failed ingest', { jobs: { j: 'failed' as IngestJobStatus } }],
    ['a pending ingest', { jobs: { j: 'pending' as IngestJobStatus } }],
    ['a vanished job', { jobs: {} }],
  ])('never drops an entry: %s', async (_label, init) => {
    const f = fakes({
      entries: [{ read: read('r1'), received_at: at(WINDOW + 60), ingest_job_id: 'j' }],
      ...init,
    });
    await f.sweeper.sweepOnce(NOW);
    expect(f.calls.drop).toEqual([]);
    expect(f.entries.map((e) => e.read.read_id)).toEqual(['r1']);
  });

  it('never drops an entry older than any conceivable TTL', async () => {
    // A month old, confirmed pooled, and still kept. The old sweeper dropped
    // exactly this entry, which is what made XTrace the sole copy of it.
    const f = fakes({
      entries: [{ read: read('ancient'), received_at: at(30 * 24 * 3600), ingest_job_id: 'j' }],
      jobs: { j: 'complete' },
    });
    const report = await f.sweeper.sweepOnce(NOW);
    expect(f.calls.drop).toEqual([]);
    expect(report.pooled).toBe(1);
    expect(report.stored).toBe(1);
    expect(report.oldestStoredAgeSeconds).toBeGreaterThan(29 * 24 * 3600);
  });
});

describe('M7 confirmation and backfill', () => {
  it('a complete job counts as pooled and re-ingests nothing', async () => {
    const f = fakes({
      entries: [{ read: read('r1'), received_at: at(WINDOW + 60), ingest_job_id: 'job-1' }],
      jobs: { 'job-1': 'complete' },
    });
    const report = await f.sweeper.sweepOnce(NOW);
    expect(report).toMatchObject({ pooled: 1, reingested: 0, pending: 0, stored: 1 });
    expect(f.calls.writeRead).toBe(0);
  });

  it('a failed job re-ingests from the entry\'s own six fields', async () => {
    const f = fakes({
      entries: [{ read: read('rf'), received_at: at(WINDOW + 10), ingest_job_id: 'job-failed' }],
      jobs: { 'job-failed': 'failed' },
    });
    const report = await f.sweeper.sweepOnce(NOW);
    expect(report).toMatchObject({ pooled: 0, reingested: 1, pending: 0 });
    expect(f.ingested.map((r) => r.read_id)).toEqual(['rf']);
    expect(f.entries[0]?.ingest_job_id).toBe('fresh-job-1'); // re-annotated for the next pass
  });

  it('a pending job waits — neither pooled nor re-ingested', async () => {
    const f = fakes({
      entries: [{ read: read('rp'), received_at: at(WINDOW + 10), ingest_job_id: 'job-pending' }],
      jobs: { 'job-pending': 'pending' },
    });
    const report = await f.sweeper.sweepOnce(NOW);
    expect(report).toMatchObject({ pooled: 0, reingested: 0, pending: 1 });
    expect(f.calls.writeRead).toBe(0);
  });

  it('an entry never annotated at all is re-ingested and annotated', async () => {
    const f = fakes({ entries: [{ read: read('r3'), received_at: at(WINDOW + 120) }] });
    const report = await f.sweeper.sweepOnce(NOW);
    expect(report).toMatchObject({ pooled: 0, reingested: 1, pending: 0, stored: 1 });
    expect(f.ingested.map((r) => r.read_id)).toEqual(['r3']);
    expect(f.entries[0]?.ingest_job_id).toBe('fresh-job-1');
  });

  it('an unknown job is left alone rather than re-ingested on a guess', async () => {
    // The old sweeper fell through to a pool search here. That search cannot
    // succeed under D-7, so keeping it would have re-ingested this entry on
    // every pass forever — N duplicate prose copies of one read, which makes
    // induction read a single confession as a crowd.
    const f = fakes({
      entries: [{ read: read('ru'), received_at: at(WINDOW + 10), ingest_job_id: 'job-vanished' }],
    });
    const report = await f.sweeper.sweepOnce(NOW);
    expect(report).toMatchObject({ pooled: 0, reingested: 0, pending: 1 });
    expect(f.calls.writeRead).toBe(0);
    expect(f.log.some((l) => l.includes('not re-ingesting on a guess'))).toBe(true);
  });

  it('repeated sweeps of an unknown job never accumulate duplicates', async () => {
    const f = fakes({
      entries: [{ read: read('ru'), received_at: at(WINDOW + 10), ingest_job_id: 'job-vanished' }],
    });
    for (let i = 0; i < 5; i++) await f.sweeper.sweepOnce(NOW);
    expect(f.calls.writeRead).toBe(0);
  });

  it('mixed states are counted independently in one pass', async () => {
    const f = fakes({
      entries: [
        { read: read('rc'), received_at: at(WINDOW + 10), ingest_job_id: 'job-complete' },
        { read: read('rf'), received_at: at(WINDOW + 10), ingest_job_id: 'job-failed' },
        { read: read('rp'), received_at: at(WINDOW + 10), ingest_job_id: 'job-pending' },
        { read: read('ru'), received_at: at(WINDOW + 10), ingest_job_id: 'job-vanished' },
      ],
      jobs: { 'job-complete': 'complete', 'job-failed': 'failed', 'job-pending': 'pending' },
    });
    const report = await f.sweeper.sweepOnce(NOW);
    expect(report).toMatchObject({ pooled: 1, reingested: 1, pending: 2, stored: 4 });
    expect(f.calls.drop).toEqual([]);
  });

  it('entries younger than the settle window are not examined at all', async () => {
    const f = fakes({ entries: [{ read: read('young'), received_at: at(WINDOW - 60) }] });
    const report = await f.sweeper.sweepOnce(NOW);
    // Not `pending`: it is not late, it is early. Counting it as pending would
    // make a healthy relay look stuck on every pass.
    expect(report).toMatchObject({ pooled: 0, reingested: 0, pending: 0, stored: 1 });
    expect(f.calls.writeRead).toBe(0);
  });

  it('an entry exactly at the window boundary is not yet examined', async () => {
    const f = fakes({ entries: [{ read: read('edge'), received_at: at(WINDOW) }] });
    expect(await f.sweeper.sweepOnce(NOW)).toMatchObject({ reingested: 0, pending: 0 });
  });

  it('re-ingest converges: pass 2 waits on the fresh job, pass 3 confirms it', async () => {
    const f = fakes({ entries: [{ read: read('r5'), received_at: at(WINDOW + 60) }] });

    expect((await f.sweeper.sweepOnce(NOW)).reingested).toBe(1);

    const second = await f.sweeper.sweepOnce(NOW);
    expect(second).toMatchObject({ reingested: 0, pending: 1 }); // fresh job is pending
    expect(f.calls.writeRead).toBe(1);

    const freshJob = f.entries[0]?.ingest_job_id;
    expect(freshJob).toBeDefined();
    if (freshJob) f.jobs[freshJob] = 'complete';

    const third = await f.sweeper.sweepOnce(NOW);
    expect(third).toMatchObject({ pooled: 1, pending: 0, stored: 1 });
    expect(f.calls.drop).toEqual([]); // confirmed, and STILL kept
  });

  it('a failed annotation is logged as a repeat, not as success', async () => {
    // The honest failure mode: a relay that rejects setJob makes this entry
    // re-ingest once per pass. The log has to say so, because `reingested: 1`
    // on every pass otherwise reads as steady progress.
    const f = fakes({
      entries: [{ read: read('r6'), received_at: at(WINDOW + 60) }],
      failSetJob: true,
    });
    expect((await f.sweeper.sweepOnce(NOW)).reingested).toBe(1);
    expect(f.log.some((l) => l.includes('re-ingest again next pass'))).toBe(true);
    expect((await f.sweeper.sweepOnce(NOW)).reingested).toBe(1); // and it does
  });

  it('an empty relay sweeps to all zeroes', async () => {
    const f = fakes({ entries: [] });
    expect(await f.sweeper.sweepOnce(NOW)).toEqual({
      pooled: 0,
      reingested: 0,
      pending: 0,
        ledgered: 0,
      stored: 0,
      oldestStoredAgeSeconds: 0,
    });
  });
});

describe('M7 the ingest ledger (M10)', () => {
  it('records the pool handles when a job succeeds, and counts them', async () => {
    // The FIRST moment the handles exist: they come from the job's result, and at write time
    // the job is still pending. Before this, `forget` reported `skipped` for the pool scope on
    // every read ever confessed, because there was no handle to delete by.
    const f = fakes({
      entries: [settled('r1', 'job-1')],
      jobs: { 'job-1': 'complete' },
      jobResults: {
        'job-1': [
          { memoryId: 'mem-a', kind: 'fact', content: 'derived one' },
          { memoryId: 'mem-b', kind: 'fact', content: 'derived two' },
        ],
      },
    });
    const report = await f.sweeper.sweepOnce(NOW);
    expect(report.pooled).toBe(1);
    expect(report.ledgered).toBe(2);
    expect(f.calls.setPoolMemories).toEqual([{ readId: 'r1', ids: ['mem-a', 'mem-b'] }]);
  });

  it('does not re-read the result for an entry that already has handles', async () => {
    // One job, one result. Re-reading it every pass would spend a live call per swept read per
    // pass for a value that cannot change.
    const f = fakes({
      entries: [{ ...settled('r1', 'job-1'), pool_memories: ['mem-a'] }],
      jobs: { 'job-1': 'complete' },
      jobResults: { 'job-1': [{ memoryId: 'mem-a', kind: 'fact', content: 'x' }] },
    });
    const report = await f.sweeper.sweepOnce(NOW);
    expect(report.pooled).toBe(1);
    expect(f.calls.jobResult).toBe(0);
    expect(report.ledgered).toBe(0);
  });

  it('a failure recording handles is logged and does not fail the sweep', async () => {
    // Best-effort, like setJob: losing the handles costs `forget` a strong deletion, not a
    // read. But never silently (§1) — an operator seeing `forget` skip the pool needs the
    // reason to exist somewhere.
    const f = fakes({
      entries: [settled('r1', 'job-1')],
      jobs: { 'job-1': 'complete' },
      jobResults: { 'job-1': [{ memoryId: 'mem-a', kind: 'fact', content: 'x' }] },
      setPoolMemoriesFails: true,
    });
    const report = await f.sweeper.sweepOnce(NOW);
    expect(report.pooled).toBe(1); // the sweep still reports the read as pooled
    expect(report.ledgered).toBe(0);
    expect(f.log.some((l) => /could not record pool handles/.test(l))).toBe(true);
    expect(f.log.some((l) => /forget will report skipped/.test(l))).toBe(true);
  });
});
