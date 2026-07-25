/**
 * In-memory relay store (P0.4). The clock is injected so tests can age entries.
 *
 * `put` is idempotent on read_id: re-putting an existing read updates the body but
 * PRESERVES received_at and ingest_job_id — a retried write must not reset the
 * stuck-entry signal or orphan a job annotation.
 */

import type { Read } from '../../src/contracts/types.js';

export interface StoredEntry {
  read: Read;
  received_at: string;
  ingest_job_id?: string;
}

export class RelayStore {
  private entries = new Map<string, StoredEntry>();

  constructor(private readonly nowFn: () => Date = () => new Date()) {}

  put(read: Read): StoredEntry {
    const existing = this.entries.get(read.read_id);
    if (existing) {
      existing.read = read;
      return existing;
    }
    const entry: StoredEntry = { read, received_at: this.nowFn().toISOString() };
    this.entries.set(read.read_id, entry);
    return entry;
  }

  setJob(readId: string, jobId: string): boolean {
    const entry = this.entries.get(readId);
    if (!entry) return false;
    entry.ingest_job_id = jobId;
    return true;
  }

  list(since?: string): StoredEntry[] {
    const all = [...this.entries.values()];
    return since === undefined ? all : all.filter((e) => e.received_at > since);
  }

  drop(readId: string): boolean {
    return this.entries.delete(readId);
  }

  stats(): { count: number; oldest_entry_age_seconds: number } {
    const now = this.nowFn().getTime();
    let oldest = 0;
    for (const entry of this.entries.values()) {
      oldest = Math.max(oldest, Math.floor((now - Date.parse(entry.received_at)) / 1000));
    }
    return { count: this.entries.size, oldest_entry_age_seconds: oldest };
  }

  seed(reads: Read[]): number {
    for (const read of reads) this.put(read);
    return reads.length;
  }

  reset(): void {
    this.entries.clear();
  }

  serialize(): string {
    return JSON.stringify({ entries: [...this.entries.values()] });
  }

  restore(json: string): void {
    const parsed = JSON.parse(json) as { entries?: StoredEntry[] };
    this.entries.clear();
    for (const entry of parsed.entries ?? []) this.entries.set(entry.read.read_id, entry);
  }
}
