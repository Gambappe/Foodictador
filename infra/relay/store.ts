/**
 * The relay store (P0.4, made durable in P0.8). The clock is injected so tests can age
 * entries.
 *
 * `put` is idempotent on read_id: re-putting an existing read updates the body but
 * PRESERVES received_at and ingest_job_id — a retried write must not reset the
 * stuck-entry signal or orphan a job annotation.
 *
 * **Persistence is synchronous and happens inside the mutation** (P0.8). D-7 made this
 * the store of record, and the only useful meaning of that is: when the caller gets its
 * 201, the read is on disk. A periodic flush cannot provide that no matter how short the
 * interval, because the acknowledgement and the durability are not ordered — the client
 * is told "stored" and then the process dies. So `persist` runs before the mutation
 * returns, and if it throws, the mutation throws, and the caller is told the truth.
 *
 * The hook is injected rather than imported so the store stays a plain data structure
 * that tests can drive without a filesystem — and so the "did it persist before it
 * answered?" ordering can be asserted directly, which is the property that matters.
 */

import type { Read } from '../../src/contracts/types.js';

/** NUL-joined, so no profile id can spell another profile's key. */
function settingsKey(profile: string, key: string): string {
  return `${profile}\u0000${key}`;
}

export interface StoredEntry {
  read: Read;
  received_at: string;
  ingest_job_id?: string;
  /**
   * XTrace memory ids the pool ingest of this read created — the ingest ledger (M10).
   *
   * Recorded by the sweeper on the transition to a succeeded job, because that is the first
   * moment they exist: the handles come from the job RESULT, and at write time the job is
   * still pending. Without them `forget` could delete the relay entry and nothing else.
   */
  pool_memories?: string[];
}

/**
 * Called with the full serialized state after each mutation, before it returns.
 * Throwing rejects the mutation.
 */
export type PersistFn = (snapshot: string) => void;

export interface RelayStoreOptions {
  now?: () => Date;
  persist?: PersistFn;
}

export class RelayStore {
  private entries = new Map<string, StoredEntry>();
  /**
   * Per-profile settings, keyed `<profile>\u0000<key>`.
   *
   * Here rather than in a separate service because D-8 needs a durable store for declared
   * settings and this is the one that exists — P0.8 already made every mutation atomic and
   * fsynced before it is acknowledged, which is exactly the guarantee an allergy list needs.
   * NUL as the separator so a profile id containing the separator cannot forge another
   * profile's key.
   */
  private settings = new Map<string, unknown>();
  private readonly nowFn: () => Date;
  private readonly persistFn: PersistFn | null;
  /** Suppresses persistence while `restore` repopulates from disk. */
  private loading = false;

  constructor(options: RelayStoreOptions | (() => Date) = {}) {
    // P0.4's constructor took a bare clock. Kept working rather than churning every
    // call site, since the clock-only form is what the existing tests and stubs use.
    const opts = typeof options === 'function' ? { now: options } : options;
    this.nowFn = opts.now ?? (() => new Date());
    this.persistFn = opts.persist ?? null;
  }

  /**
   * Runs a mutation and persists the result before returning it.
   *
   * On a persist failure the in-memory change is rolled back, so a caller that sees a
   * 500 and retries does not find the write already applied — and a relay that cannot
   * write to disk does not silently drift into being an in-memory cache again.
   */
  private mutate<T>(apply: () => T): T {
    if (this.persistFn === null || this.loading) return apply();
    // BOTH maps. This snapshotted only `entries` until D-8 put settings in the same
    // store: a persist failure inside `settingsPut` then threw at the caller while
    // leaving the setting applied in memory, so the next successful mutation would
    // quietly write it to disk. For a declared allergy list that is the worst possible
    // inversion — "your change failed" followed by the change taking effect anyway.
    const entriesRollback = new Map(this.entries);
    const settingsRollback = new Map(this.settings);
    const result = apply();
    try {
      this.persistFn(this.serialize());
    } catch (error) {
      this.entries = entriesRollback;
      this.settings = settingsRollback;
      throw error;
    }
    return result;
  }

  put(read: Read): StoredEntry {
    return this.mutate(() => {
      const existing = this.entries.get(read.read_id);
      if (existing) {
        existing.read = read;
        return existing;
      }
      const entry: StoredEntry = { read, received_at: this.nowFn().toISOString() };
      this.entries.set(read.read_id, entry);
      return entry;
    });
  }

  setJob(readId: string, jobId: string): boolean {
    const entry = this.entries.get(readId);
    // Persisting a no-op would rewrite the snapshot for every unknown read_id.
    if (!entry) return false;
    return this.mutate(() => {
      entry.ingest_job_id = jobId;
      return true;
    });
  }

  /**
   * Records the XTrace memory ids this read's pool ingest created — the ingest ledger (M10).
   *
   * Replaces rather than appends: the handles come from one job result, so a second call for
   * the same read is a re-read of the same truth, not more of it. Appending would grow the
   * list on every sweep pass that saw the same succeeded job.
   */
  setPoolMemories(readId: string, memoryIds: readonly string[]): boolean {
    const entry = this.entries.get(readId);
    if (!entry) return false;
    return this.mutate(() => {
      entry.pool_memories = [...memoryIds];
      return true;
    });
  }

  list(since?: string): StoredEntry[] {
    const all = [...this.entries.values()];
    return since === undefined ? all : all.filter((e) => e.received_at > since);
  }

  drop(readId: string): boolean {
    if (!this.entries.has(readId)) return false;
    return this.mutate(() => this.entries.delete(readId));
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
    // One snapshot for the batch, not one per read: seeding is thousands of reads and
    // the atomic write is a whole-file rewrite. Still all-or-nothing — if the single
    // persist fails, mutate() rolls the whole batch back.
    return this.mutate(() => {
      for (const read of reads) {
        const existing = this.entries.get(read.read_id);
        if (existing) {
          existing.read = read;
          continue;
        }
        this.entries.set(read.read_id, { read, received_at: this.nowFn().toISOString() });
      }
      return reads.length;
    });
  }

  reset(): void {
    this.mutate(() => {
      this.entries.clear();
    });
  }

  settingsGet(profile: string, key: string): unknown {
    return this.settings.get(settingsKey(profile, key)) ?? null;
  }

  settingsPut(profile: string, key: string, value: unknown): void {
    this.mutate(() => {
      this.settings.set(settingsKey(profile, key), value);
    });
  }

  serialize(): string {
    return JSON.stringify({
      entries: [...this.entries.values()],
      settings: Object.fromEntries(this.settings),
    });
  }

  /** Skips structurally invalid entries rather than keying the map on undefined. */
  restore(json: string): { restored: number; skipped: number } {
    const parsed = JSON.parse(json) as { entries?: unknown[]; settings?: Record<string, unknown> };
    this.loading = true;
    try {
      this.entries.clear();
      // Absent in any snapshot written before settings existed, and an empty object is the
      // right reading of that — a pre-D-8 relay held no settings.
      this.settings = new Map(Object.entries(parsed.settings ?? {}));
      let skipped = 0;
      for (const raw of parsed.entries ?? []) {
        const entry = raw as StoredEntry | null;
        const readId = entry?.read?.read_id;
        if (typeof readId !== 'string' || readId === '' || typeof entry?.received_at !== 'string') {
          skipped += 1;
          continue;
        }
        this.entries.set(readId, entry);
      }
      return { restored: this.entries.size, skipped };
    } finally {
      this.loading = false;
    }
  }
}
