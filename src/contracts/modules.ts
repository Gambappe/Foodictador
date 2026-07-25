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
  /**
   * The memory ids a succeeded ingest created — the ingest ledger's source (M10).
   *
   * Measured live: a succeeded job's result carries
   * `memories_created: [{id, type, text}]`. Returns `[]` for a job that has not succeeded, or
   * one whose result carries nothing — absence of handles is not an error, it is the normal
   * state of a job still running.
   *
   * Separate from `jobStatus` because the sweeper polls status often and only needs the result
   * once, on the transition to succeeded.
   */
  jobResult(jobId: string): Promise<MemoryRow[]>;
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
/**
 * One ingested conversation: the job, and which reads it carried (M12).
 *
 * `memories_created` for such a job covers EVERY read in it and says which read produced
 * which memory nowhere — so a batched ingest cannot feed M10's per-read ledger. That is a
 * real cost of batching, recorded here rather than discovered by a `forget` that reports
 * `skipped` with no explanation.
 */
export interface BatchHandle {
  jobId: string;
  readIds: string[];
}

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
   *
   * Returns one handle per CONVERSATION with the reads that went into it. The `readIds` are
   * not decoration: a caller that must annotate each read with the job that ingested it —
   * the sweeper does, so its next pass can confirm them — cannot recover the grouping from a
   * bare handle list, and guessing it would re-derive a private policy of this store.
   */
  writeReads(reads: readonly Read[]): Promise<BatchHandle[]>;
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

/**
 * What a confession write did — buffered, or sent as part of a batch (M20).
 *
 * A `JobHandle` is no longer the right answer, because most calls do not produce a job: the
 * confession is held so several can share one ingest call. `confess` prints this, so it must
 * distinguish "held" from "sent" — telling a user their words reached their memory when they
 * are sitting in a buffer is a false receipt, and deferral is not loss.
 */
export interface ProseWrite {
  /** Confessions now waiting to be sent, after this call. */
  buffered: number;
  /** Present only when this call triggered a flush. */
  jobId?: string;
  /**
   * `true` when a CONCURRENT process claimed the batch this confession is in.
   *
   * `buffered: 0` used to be read as "this call sent them", which is false in exactly one
   * case: two `confess` processes cross the threshold together, one claims the batch, and the
   * other finds nothing left to hold. That process sent nothing, yet printed
   * `ok (your words, sent to your tier only)` — measured 9 times in 60 (SL-49).
   *
   * The confession is not lost: the other process has it. But "I sent it" and "someone else
   * is sending it" are different claims, and a receipt may only make the one that is true.
   */
  handedOff?: boolean;
}

export interface UserStore {
  /**
   * Buffers the confession, byte-identical, and sends the batch when one has accumulated.
   *
   * [E11] is untouched — buffering changes WHEN a confession is ingested, never WHAT. It is
   * batched because XTrace generates an episode per ingest CALL: measured, eight
   * one-at-a-time confessions produced eight per-confession paraphrases across eight
   * `conv_id`s, and a shared `conv_id` across separate POSTs does not merge them (M20).
   *
   * `readId` ties the buffered copy to the read it came from, so `forget` can delete it before
   * it is ever sent — without it, `forget` reported success on all three of its targets while
   * a copy of the raw confession waited on disk for the next flush (SL-50).
   */
  writeProse(profile: string, text: string, readId?: string): Promise<ProseWrite>;
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
  /**
   * Records the XTrace memory ids this read's pool ingest created — the ingest ledger (M10).
   *
   * Best-effort like `setJob`: a failure costs `forget` its pool handles, which is a weaker
   * deletion promise, not a lost read. Written by the sweeper rather than the write path,
   * because the handles come from the job RESULT and the job is still pending at write time.
   */
  setPoolMemories(readId: string, memoryIds: readonly string[]): Promise<void>;
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

/*
 * `AskEngine.ask(input) → Card` was declared here, stubbed in P0.2, and implemented by nobody
 * (§4 D-6). It is DELETED rather than re-specced, because the shape was not merely unbuilt —
 * it was impossible. A `Card` carries narrated copy, and copy comes from a model call, so no
 * synchronous pure function can return one. K7 proved that by building the thing; the
 * interface survived anyway because a fixture stub satisfied it and a contract test asserted
 * the stub, which is a closed loop that can agree with itself for ever.
 *
 * The real seam is two pure functions in `src/kernel/askEngine.ts`:
 *
 *   planAsk(input)            → AskPlan       — every decision, no copy, no I/O
 *   assembleCard(plan, copy)  → Card          — the plan plus copy the caller fetched
 *
 * The split is the point: the impossible part was returning copy, so copy is the caller's to
 * obtain and the kernel stays pure. `AskInput` below is still the input shape both take.
 */

// ---- lane N — nudge ----

export interface Nudge {
  setOptIn(on: boolean): void;
  arm(): void;
  /** Returns true at most once per LOCAL calendar day (N1); never when opted out or silenced. */
  maybeFire(now: string): boolean;
  silenceForever(): void;
  state(): NudgeState;
}
