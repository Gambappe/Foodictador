import { describe, expect, it } from 'vitest';

import type { MemoryClient, PoolStore, Relay } from '../contracts/modules.js';
import type {
  Driver,
  IngestJobStatus,
  JobHandle,
  Read,
  RelayEntry,
  RelayStats,
} from '../contracts/types.js';
import { createLogger } from '../config/logger.js';
import { sampleRead } from '../contracts/fixtures/index.js';
import { createSweeper } from './sweeper.js';

const NOW = '2026-07-25T19:00:00.000Z';
const WINDOW = 480;

function at(secondsBeforeNow: number): string {
  return new Date(Date.parse(NOW) - secondsBeforeNow * 1000).toISOString();
}

/** Purpose-built fakes: precise control over job states and pool contents. */
function fakes(init: {
  entries: RelayEntry[];
  poolReads?: Read[];
  jobs?: Record<string, IngestJobStatus>;
  failSetJob?: boolean;
}) {
  const entries = [...init.entries];
  const poolReads = [...(init.poolReads ?? [])];
  const jobs = { ...(init.jobs ?? {}) };
  const log: string[] = [];
  const calls = { writeRead: 0, setJob: 0, drop: [] as string[] };
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
      poolReads.push(read);
      jobSeq += 1;
      const jobId = `fresh-job-${jobSeq}`;
      jobs[jobId] = 'pending';
      return Promise.resolve({ jobId });
    },
    readsForDriver: (driver: Driver) =>
      Promise.resolve(poolReads.filter((r) => r.driver === driver)),
    inducedClaim: () => Promise.reject(new Error('unused')),
  };

  const client: MemoryClient = {
    ingest: () => Promise.reject(new Error('unused')),
    search: () => Promise.reject(new Error('unused')),
    remove: () => Promise.reject(new Error('unused')),
    jobStatus: (jobId) => Promise.resolve(jobs[jobId] ?? 'unknown'),
  };

  const sweeper = createSweeper({
    relay,
    pool,
    client,
    logger: createLogger((line) => log.push(line)),
    settleWindowSeconds: WINDOW,
  });

  return { sweeper, entries, poolReads, jobs, calls, log };
}

function read(id: string, driver: Read['driver'] = 'solo_comfort'): Read {
  return { ...sampleRead, read_id: id, driver };
}

describe('M7 settle-sweeper', () => {
  it('an entry that verifies by job is dropped', async () => {
    const f = fakes({
      entries: [{ read: read('r1'), received_at: at(WINDOW + 60), ingest_job_id: 'job-1' }],
      jobs: { 'job-1': 'complete' },
    });
    const report = await f.sweeper.sweepOnce(NOW);
    expect(report).toMatchObject({ verified: 1, reingested: 0, retained: 0 });
    expect(f.calls.drop).toEqual(['r1']);
  });

  it('an entry with no job id verifies by the search fallback', async () => {
    const f = fakes({
      entries: [{ read: read('r2'), received_at: at(WINDOW + 60) }],
      poolReads: [read('r2')],
    });
    const report = await f.sweeper.sweepOnce(NOW);
    expect(report.verified).toBe(1);
    expect(f.calls.drop).toEqual(['r2']);
  });

  it('a missing entry is re-ingested from its own six fields and retained', async () => {
    const f = fakes({
      entries: [{ read: read('r3'), received_at: at(WINDOW + 120) }],
    });
    const report = await f.sweeper.sweepOnce(NOW);
    expect(report).toMatchObject({ verified: 0, reingested: 1, retained: 1 });
    expect(f.poolReads.map((r) => r.read_id)).toEqual(['r3']);
    expect(f.calls.drop).toEqual([]);
    // the entry was re-annotated so the next pass polls the fresh job
    expect(f.entries[0]?.ingest_job_id).toBe('fresh-job-1');
  });

  it('THE POINT: an entry older than any conceivable TTL is still not dropped while unverified', async () => {
    const f = fakes({
      entries: [{ read: read('r4'), received_at: at(30 * 24 * 3600) }], // a month old
    });
    const report = await f.sweeper.sweepOnce(NOW);
    expect(f.calls.drop).toEqual([]);
    expect(report.retained).toBe(1);
    expect(report.oldestEntryAgeSeconds).toBeGreaterThan(29 * 24 * 3600);
  });

  it('a failed job re-ingests; a pending job waits; a stale/unknown job falls back to search', async () => {
    const f = fakes({
      entries: [
        { read: read('rf'), received_at: at(WINDOW + 10), ingest_job_id: 'job-failed' },
        { read: read('rp'), received_at: at(WINDOW + 10), ingest_job_id: 'job-pending' },
        { read: read('ru'), received_at: at(WINDOW + 10), ingest_job_id: 'job-vanished' },
      ],
      jobs: { 'job-failed': 'failed', 'job-pending': 'pending' },
      poolReads: [read('ru')], // the unknown-job entry IS retrievable — search finds it
    });
    const report = await f.sweeper.sweepOnce(NOW);
    expect(report.verified).toBe(1); // ru via fallback
    expect(report.reingested).toBe(1); // rf
    expect(f.calls.drop).toEqual(['ru']);
    expect(f.entries.map((e) => e.read.read_id).sort()).toEqual(['rf', 'rp']);
  });

  it('entries younger than the settle window are not examined at all', async () => {
    const f = fakes({
      entries: [{ read: read('young'), received_at: at(WINDOW - 60) }],
    });
    const report = await f.sweeper.sweepOnce(NOW);
    expect(report).toMatchObject({ verified: 0, reingested: 0, retained: 1 });
    expect(f.calls.writeRead).toBe(0);
  });

  it('two consecutive sweeps are idempotent: the second pass re-ingests nothing new', async () => {
    const f = fakes({
      entries: [{ read: read('r5'), received_at: at(WINDOW + 60) }],
    });
    const first = await f.sweeper.sweepOnce(NOW);
    expect(first.reingested).toBe(1);
    const second = await f.sweeper.sweepOnce(NOW);
    // the fresh job is pending → wait, not a second re-ingest
    expect(second.reingested).toBe(0);
    expect(f.calls.writeRead).toBe(1);
    expect(second.retained).toBe(1);
    // and once the job completes, the third pass verifies and drops
    const freshJob = f.entries[0]?.ingest_job_id;
    expect(freshJob).toBeDefined();
    if (freshJob) f.jobs[freshJob] = 'complete';
    const third = await f.sweeper.sweepOnce(NOW);
    expect(third.verified).toBe(1);
    expect(third.retained).toBe(0);
  });

  it('a failed job annotation is best-effort: logged, not fatal, re-ingest still counts', async () => {
    const f = fakes({
      entries: [{ read: read('r6'), received_at: at(WINDOW + 60) }],
      failSetJob: true,
    });
    const report = await f.sweeper.sweepOnce(NOW);
    expect(report.reingested).toBe(1);
    expect(f.log.some((line) => line.includes('job annotation failed'))).toBe(true);
  });
});
