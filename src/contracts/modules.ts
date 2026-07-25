/**
 * Module interfaces — frozen at P0.2 per docs/confit-v0.8-task-dag.md §3.
 * Every interface has a working fixture stub in ./stubs; lanes build against the
 * stubs and swap real implementations in behind flags.
 *
 * Two integrator clarifications of the §3 summary table, recorded here because the
 * summaries could not be implemented without them:
 *
 * - `MemoryClient.jobStatus` exists because ingest must return a POLLABLE handle
 *   (M1) and the sweeper's D-1 primary verification path is polling the job by id
 *   carried on the relay entry — some method has to answer that poll.
 * - `UserStore.setMealLog` exists because X7's `provision` writes demo profiles
 *   "via UserStore" and S4's meal logs have no other write path.
 */

import type {
  AskContext,
  Card,
  CardCopy,
  CohortStat,
  Driver,
  IngestJobStatus,
  JobHandle,
  MealLogEntry,
  MemoryRow,
  NarratorFacts,
  NudgeState,
  Place,
  ProposedRead,
  RankedPlace,
  Read,
  RelayEntry,
  RelayStats,
  SearchOpts,
  Suppression,
  UsualProfile,
} from './types.js';
import type { Flags } from './flags.js';

// ---- lane M — memory & transport ----

/**
 * Typed client over the memory substrate. The scope (user_id) is a required
 * positional parameter on every method — omitting it searches app-wide, which is
 * why no overload may make it optional (M1 proves this with a type-level test).
 */
export interface MemoryClient {
  ingest(scope: string, payload: string): Promise<JobHandle>;
  search(scope: string, query: string, opts: SearchOpts): Promise<MemoryRow[]>;
  remove(scope: string, memoryId: string): Promise<void>;
  jobStatus(jobId: string): Promise<IngestJobStatus>;
}

export interface PoolStore {
  /** Embeds `read_id` in the record content so M7's fallback verification can find it. */
  writeRead(read: Read): Promise<JobHandle>;
  /** The COUNTING query (design v0.8 §8): one driver, k = COUNTING_K. */
  readsForDriver(driver: Driver, opts?: { k?: number }): Promise<Read[]>;
  /** The INDUCTION query — separate from counting on purpose; may stay top-k. */
  inducedClaim(query: string): Promise<string>;
}

export interface UserStore {
  /** Ingests the confession as raw prose, unmodified ([E11]). */
  writeProse(profile: string, text: string): Promise<JobHandle>;
  usual(profile: string): Promise<UsualProfile | null>;
  /** The only write path for off-limits topics — G2, X7 and U4 all go through here. */
  setUsual(profile: string, usual: UsualProfile): Promise<void>;
  mealLog(profile: string): Promise<MealLogEntry[]>;
  setMealLog(profile: string, entries: MealLogEntry[]): Promise<void>;
}

export interface Relay {
  put(read: Read): Promise<void>;
  /** Best-effort job annotation (DAG §4 D-1) — an entry with no job id is not broken. */
  setJob(readId: string, jobId: string): Promise<void>;
  list(since?: string): Promise<RelayEntry[]>;
  drop(readId: string): Promise<void>;
  stats(): Promise<RelayStats>;
  seed(reads: Read[]): Promise<number>;
  reset(): Promise<void>;
}

/** Pool ∪ relay, deduplicated on `read_id` ([E20]). */
export interface PoolView {
  readsForDriver(driver: Driver): Promise<{ reads: Read[]; degraded: boolean }>;
}

// ---- lane L — LLM ----

export interface Extractor {
  propose(text: string, offLimits: string[]): Promise<ProposedRead | { blocked: true }>;
}

export interface Narrator {
  write(ranked: RankedPlace[], facts: NarratorFacts): Promise<CardCopy>;
}

// ---- lane K — kernel (pure: implementations take `now` as a parameter) ----

export interface Rotation {
  /** Half-life per dish id; <3 observations inherit the seeded median. */
  fit(log: MealLogEntry[], seededMedians?: Record<string, number>): Record<string, number>;
  suppressions(log: MealLogEntry[], now: string): Suppression[];
  appetite(dishId: string, log: MealLogEntry[], now: string): number;
}

export interface Cohorts {
  /** Dedup on read_id before counting ([E20]). */
  census(reads: Read[]): CohortStat[];
  matched(usual: UsualProfile, reads: Read[], kFloor?: number): CohortStat[];
}

export interface AskInput {
  reads: Read[];
  usual: UsualProfile;
  log: MealLogEntry[];
  corpus: Place[];
  flags: Flags;
  now: string;
  /** Omitted under demoMode — the engine pins DEMO_CONTEXT. */
  context?: AskContext;
  degradedPool?: boolean;
}

export interface AskEngine {
  ask(input: AskInput): Card;
}

// ---- lane N — nudge ----

export interface Nudge {
  setOptIn(on: boolean): void;
  arm(): void;
  /** Returns true at most once per LOCAL calendar day (N1); never when opted out or silenced. */
  maybeFire(now: string): boolean;
  silenceForever(): void;
  state(): NudgeState;
}
