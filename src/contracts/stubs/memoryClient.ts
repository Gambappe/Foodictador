import type { MemoryClient } from '../modules.js';
import type { IngestJobStatus, JobHandle, MemoryRow, SearchOpts } from '../types.js';

/** In-memory MemoryClient: every ingest lands as one 'fact' row, jobs complete instantly. */
export class StubMemoryClient implements MemoryClient {
  private readonly rows = new Map<string, MemoryRow[]>();
  private readonly jobs = new Map<string, IngestJobStatus>();
  private seq = 0;

  ingest(scope: string, payload: string): Promise<JobHandle> {
    this.seq += 1;
    const row: MemoryRow = { memoryId: `mem-${this.seq}`, kind: 'fact', content: payload };
    this.rows.set(scope, [...(this.rows.get(scope) ?? []), row]);
    const jobId = `job-${this.seq}`;
    this.jobs.set(jobId, 'complete');
    return Promise.resolve({ jobId });
  }

  search(scope: string, query: string, opts: SearchOpts): Promise<MemoryRow[]> {
    const scoped = this.rows.get(scope) ?? [];
    const matched = query === '' ? scoped : scoped.filter((r) => r.content.includes(query));
    return Promise.resolve(matched.slice(0, opts.topK));
  }

  remove(scope: string, memoryId: string): Promise<void> {
    this.rows.set(scope, (this.rows.get(scope) ?? []).filter((r) => r.memoryId !== memoryId));
    return Promise.resolve();
  }

  jobStatus(jobId: string): Promise<IngestJobStatus> {
    return Promise.resolve(this.jobs.get(jobId) ?? 'unknown');
  }
}
