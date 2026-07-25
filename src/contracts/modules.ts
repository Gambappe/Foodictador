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
  /**
   * Several messages in ONE conversation, under a caller-chosen `convId`.
   *
   * Not a convenience wrapper. XTrace's episodes are conversation summaries, so an isolated
   * one-message ingest can only ever produce a paraphrase of that one message — measured:
   * ungrouped reads yielded *"The session consisted of a single structured signal about
   * Harbor Greens"*, while the same twelve reads in one conversation yielded a claim spanning
   * four places. Cross-record synthesis is the one job XTrace kept after D-7, and grouping is
   * the precondition for it (M12; operational guide R4).
   */
  ingestBatch(scope: string, payloads: readonly string[], convId: string): Promise<JobHandle>;
  search(scope: string, query: string, opts: SearchOpts): Promise<MemoryRow[]>;
  remove(scope: string, memoryId: string): Promise<void>;
  jobStatus(jobId: string): Promise<IngestJobStatus>;
}

/**
 * The XTrace side of the pool. **Induction only, under DAG §4 D-7.**
 *
 * There is deliberately no `readsForDriver` here. Gate zero established that
 * XTrace does not store payloads, it extracts them: one ingested read becomes
 * five unjoinable prose facts, and no query returns the object that went in.
 * Counting therefore reads the relay (see `PoolView`), and this interface keeps
 * only the job XTrace is measurably good at (design v0.8 §8) — cross-record
 * synthesis over the prose it derived.
 */
export interface PoolStore {
  /**
   * Feeds the induction index with ONE read. The returned job is what the sweeper confirms
   * against.
   *
   * A single read is its own conversation, so this path cannot produce cross-record
   * synthesis — that is a property of the substrate, not a bug here. It is the live-confession
   * path and it exists so a confession is fed at all; `writeReads` is what induction is
   * actually built on, and the guide's R5 says to seed ahead of time rather than ingest live.
   */
  writeRead(read: Read): Promise<JobHandle>;
  /**
   * Many reads, grouped into conversations so episodes can span them (M12/M14).
   * Returns one handle per conversation, not per read.
   */
  writeReads(reads: readonly Read[]): Promise<JobHandle[]>;
  /** The INDUCTION query. The only read path XTrace can actually serve. */
  inducedClaim(query: string): Promise<string>;
}

/**
 * Durable per-profile settings — the DECLARED half of DAG §4 D-8.
 *
 * A plain keyed store, because that is the primitive the settings path actually needs and
 * never had. XTrace offers no addressing, no upsert and no byte fidelity, so M3 built three
 * prostheses for them — a `kind` tag used as a search query, `written_at` ordering to pick
 * between duplicates XTrace's missing upsert guarantees, and a JSON body to survive
 * extraction. All three failed at once, because extraction drops the tag AND the JSON:
 * `usual()` returned null on every live read, which took out `confit ask` and `confit
 * confess` together.
 *
 * D-8's rule is what makes this a different interface rather than a fixed one: the user
 * ASSERTED these facts and expects them honoured exactly. `offLimits` and `giConstraint` are
 * allergy and medical data, and `~11/16` non-deterministic retention is not a quality
 * question when a dropped topic means a confession that should have been blocked is written
 * to the pool.
 *
 * Values are `unknown` on the way out on purpose: the caller parses at the boundary (§1), so
 * a store that round-trips garbage cannot launder it into a type.
 */
export interface SettingsStore {
  /**
   * `null` means absent. Not ambiguous in practice: every value this store holds is an
   * object or an array, so nothing stores a bare `null` for the reading to collide with.
   * Typed `unknown` rather than `unknown | null` because `unknown` already admits null —
   * the contract is in this sentence, not in the union.
   */
  get(profile: string, key: string): Promise<unknown>;
  /** Overwrites. There is no merge: the caller owns the whole value for a key. */
  put(profile: string, key: string, value: unknown): Promise<void>;
}

export interface UserStore {
  /** Ingests the confession as raw prose, unmodified ([E11]). */
  writeProse(profile: string, text: string): Promise<JobHandle>;
  /**
   * XTrace's synthesis over THIS user's own confessions — D-8's second input (M16).
   *
   * The mirror of `PoolStore.inducedClaim`, over the personal scope instead of the pool.
   * Until this existed the personal tier was write-only: `writeProse` ingested every
   * confession and nothing ever read one back, so the tier was pure cost.
   *
   * Returns `''` for "no claim", never throws for absence — a user with one confession gets
   * a thin claim or none, and by the product owner's ruling there is deliberately no minimum
   * ("no floor; let's see what happens"). The confession count behind a claim is logged so
   * that a thin one is attributable rather than mysterious.
   */
  personalClaim(profile: string, query: string): Promise<string>;
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

/**
 * The read set every Ask counts, deduplicated on `read_id` ([E20]).
 *
 * Under D-7 this is the relay and nothing else — it holds the exact six-field
 * objects, so cohort counts are exact and are never degraded. `degraded` reports
 * the OTHER half: XTrace's induction index is unavailable, so there is no induced
 * claim to put on the card. Counts stay live either way, which is what the
 * disclosure copy in `src/cli/ask.ts` has always said.
 */
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
