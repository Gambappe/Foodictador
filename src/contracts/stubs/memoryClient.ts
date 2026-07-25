import type { MemoryClient } from '../modules.js';
import type { IngestJobStatus, JobHandle, MemoryRow, SearchOpts } from '../types.js';

/**
 * In-memory MemoryClient: every ingest lands as one 'fact' row, jobs complete instantly.
 *
 * `conversations` records what was grouped under which `conv_id`. It exists because the
 * property M12 is about is not observable in the rows — the real substrate turns a
 * conversation into an episode, and a stub cannot fake that. What a stub CAN assert is that
 * the caller grouped correctly, which is the half of the behaviour we control.
 */
export class StubMemoryClient implements MemoryClient {
  private readonly rows = new Map<string, MemoryRow[]>();
  private readonly jobs = new Map<string, IngestJobStatus>();
  private seq = 0;

  /** conv_id → the payloads sent under it, in order. */
  readonly conversations = new Map<string, string[]>();

  ingest(scope: string, payload: string): Promise<JobHandle> {
    this.seq += 1;
    const row: MemoryRow = { memoryId: `mem-${this.seq}`, kind: 'fact', content: payload };
    this.rows.set(scope, [...(this.rows.get(scope) ?? []), row]);
    const jobId = `job-${this.seq}`;
    this.jobs.set(jobId, 'complete');
    return Promise.resolve({ jobId });
  }

  ingestBatch(scope: string, payloads: readonly string[], convId: string): Promise<JobHandle> {
    this.conversations.set(convId, [...(this.conversations.get(convId) ?? []), ...payloads]);
    for (const payload of payloads) {
      this.seq += 1;
      const row: MemoryRow = { memoryId: `mem-${this.seq}`, kind: 'fact', content: payload };
      this.rows.set(scope, [...(this.rows.get(scope) ?? []), row]);
    }
    this.seq += 1;
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
