import type { Relay } from '../modules.js';
import type { Read, RelayEntry, RelayStats } from '../types.js';

/**
 * In-memory relay. `drop` on an unknown read_id is a no-op here — the M8 contract
 * treats forget-of-unknown as success, and the stub follows the caller-facing rule
 * (the real service's 404 is M4's concern, not the interface's).
 *
 * `put` upserts on read_id, matching `infra/relay/store.ts`: a retried write
 * updates the body but preserves `received_at` and `ingest_job_id`. It matters
 * more under D-7 than it did as transport — the relay is the durable store now,
 * so a stub that appended would model a canonical store that duplicates reads.
 */
export class StubRelay implements Relay {
  private entries: RelayEntry[] = [];

  constructor(private readonly nowFn: () => Date = () => new Date()) {}

  put(read: Read): Promise<void> {
    const existing = this.entries.find((e) => e.read.read_id === read.read_id);
    if (existing) {
      existing.read = read;
      return Promise.resolve();
    }
    this.entries.push({ read, received_at: this.nowFn().toISOString() });
    return Promise.resolve();
  }

  setJob(readId: string, jobId: string): Promise<void> {
    const entry = this.entries.find((e) => e.read.read_id === readId);
    if (!entry) return Promise.reject(new Error(`relay: unknown read_id ${readId}`));
    entry.ingest_job_id = jobId;
    return Promise.resolve();
  }

  list(since?: string): Promise<RelayEntry[]> {
    const all = [...this.entries];
    return Promise.resolve(since === undefined ? all : all.filter((e) => e.received_at > since));
  }

  drop(readId: string): Promise<void> {
    this.entries = this.entries.filter((e) => e.read.read_id !== readId);
    return Promise.resolve();
  }

  stats(): Promise<RelayStats> {
    const now = this.nowFn().getTime();
    const oldest = this.entries.reduce(
      (age, e) => Math.max(age, (now - Date.parse(e.received_at)) / 1000),
      0,
    );
    return Promise.resolve({ count: this.entries.length, oldest_entry_age_seconds: oldest });
  }

  seed(reads: Read[]): Promise<number> {
    const at = this.nowFn().toISOString();
    for (const read of reads) this.entries.push({ read, received_at: at });
    return Promise.resolve(reads.length);
  }

  reset(): Promise<void> {
    this.entries = [];
    return Promise.resolve();
  }
}
