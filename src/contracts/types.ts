/**
 * Core types — frozen at P0.2 per docs/confit-v0.8-task-dag.md §3.
 * After the freeze only the integrator edits this file.
 *
 * Enum value lists are exported as const arrays so validators (K1), the relay route
 * validator (P0.4) and the write guard (G1) can check membership at runtime without
 * re-declaring the vocabulary.
 */

export const DRIVERS = [
  'spice_tolerance_low',
  'budget_ceiling',
  'portion_small',
  'solo_comfort',
  'gi_constraint',
  'allergy_constraint',
  'sensory_shift',
  'companion_constraint',
  'emotional_exclusion',
  'acclaim_skeptic',
  'crowd_aversion',
] as const;
export type Driver = (typeof DRIVERS)[number];

export const SIGNALS = [
  'regret_after_order',
  'never_ordered_again',
  'returns_despite_incident',
  'pretends_preference',
  'secret_default',
  'trusted_safe_place',
  'wanted_something_else',
] as const;
export type Signal = (typeof SIGNALS)[number];

export const CADENCES = ['once', 'rarely', 'monthly', 'weekly', 'daily'] as const;
export type Cadence = (typeof CADENCES)[number];

/**
 * The single source of truth for the read's field names (design v0.8 [E20]/[E25]).
 * K1's validator, P0.4's route validator and G1's guard consume this constant —
 * none of them re-declares the list.
 */
export const READ_KEYS = ['read_id', 'place', 'signal', 'driver', 'cadence', 'weight'] as const;
export type ReadKey = (typeof READ_KEYS)[number];

/**
 * The ONLY shape that ever reaches the pool or the relay. Exactly six fields,
 * closed to extra properties. `read_id` is minted client-side at approval and
 * identifies nothing but the read — no account, no session, no ordering.
 * A read carries no time at all ([E26]): the relay's `received_at` and
 * `ingest_job_id` are server-side metadata, never part of this body.
 */
export interface Read {
  read_id: string; // uuid v4
  place: string; // corpus slug
  signal: Signal;
  driver: Driver;
  cadence: Cadence;
  weight: number; // 0..1 inclusive
}

// Compile-time pin: Read's keys are exactly READ_KEYS (the runtime pin is the
// sampleRead fixture test in contracts.test.ts).
type AssertBoth<A extends true, B extends true> = A extends B ? true : never;
type KeysCoverRead = keyof Read extends ReadKey ? true : never;
type ReadCoversKeys = ReadKey extends keyof Read ? true : never;
const _readKeysMatch: AssertBoth<KeysCoverRead, ReadCoversKeys> = true;
void _readKeysMatch;

export interface ProposedRead {
  chips: Omit<Read, 'read_id'>;
  confidence: number;
}

export interface UsualProfile {
  spiceTolerance: 0 | 1 | 2 | 3;
  budgetBand: 1 | 2 | 3 | 4;
  portionPref: 'small' | 'standard' | 'large';
  soloComfort: boolean;
  giConstraint: boolean;
  offLimits: string[]; // free-text topics; enforced by K2 via M5, upstream of every write
  defaultOrder?: { placeId: string; dishId: string };
}

export interface MealLogEntry {
  dishId: string;
  placeId: string;
  at: string; // ISO date
  felt?: 'glad' | 'fine' | 'regret';
}

export type PlaceTag =
  | 'late_night'
  | 'counter_seating'
  | 'solo_friendly'
  | 'quiet'
  | 'gi_safe_options'
  | 'small_plates';

export interface Place {
  id: string;
  name: string;
  cuisine: string;
  priceBand: 1 | 2 | 3 | 4;
  tags: PlaceTag[];
  signatureDishes: Array<{ dishId: string; name: string; spiceLevel: 0 | 1 | 2 | 3 }>;
}

export interface CohortStat {
  driver: Driver;
  k: number;
  meanWeight: number;
  placeIds: string[];
}

export interface ScoreParts {
  pool: number;
  usual: number;
  rotation: number;
  context: number;
}

export interface RankedPlace {
  place: Place;
  score: number;
  parts: ScoreParts;
}

/** Rotation suppression carries a reason KEY, not prose — copy comes from L1's catalog. */
export interface Suppression {
  dishId: string;
  reasonKey: string;
}

/** Facts handed to the narrator. Facts only — never confession prose. */
export interface NarratorFacts {
  citation?: { driver: Driver; k: number };
  cohortMiss?: { driver: Driver };
  inducedClaim?: string;
  suppressions: Suppression[];
  usualNotes: string[];
  degradedPool: boolean;
}

/** What a narrator (live or template) returns. */
export interface CardCopy {
  reasonLine: string;
  rotationLine?: string;
  usualLine?: string;
  cohortMissLine?: string;
}

export interface Card {
  pick: Place;
  reasonLine: string;
  poolCitation?: { driver: Driver; k: number }; // named cohort — NEVER narrative content
  rotationLine?: string;
  usualLine?: string;
  cohortMiss?: { driver: Driver };
  runnersUp: Array<{ place: Place; score: number }>;
  scores: Record<string, number>; // full transparency for The Pass
  /** Declared delta from plan v1.0 §3.1: PoolView degradation is disclosed on the card. */
  degradedPool?: boolean;
}

export interface AskContext {
  hour: number;
  solo: boolean;
  weather: 'rain' | 'clear';
}

/** The context demoMode pins, so rehearsals are reproducible. */
export const DEMO_CONTEXT: AskContext = { hour: 19, solo: true, weather: 'rain' };

// ---- memory / transport shapes ----

export type IngestJobStatus = 'pending' | 'complete' | 'failed' | 'unknown';

export interface JobHandle {
  jobId: string;
}

export interface MemoryRow {
  memoryId: string;
  kind: 'fact' | 'episode';
  content: string;
}

/**
 * `episodeSlots` is required on purpose: facts are returned before episodes, so a
 * flat top-k drops every episode (design v0.8 §14). Making the reservation
 * unavoidable at the type level is the contract's half of M1's acceptance.
 */
export interface SearchOpts {
  topK: number;
  episodeSlots: number;
}

/** What the relay stores. `received_at`/`ingest_job_id` are server-side metadata — never in the read body. */
export interface RelayEntry {
  read: Read;
  received_at: string;
  ingest_job_id?: string;
}

export interface RelayStats {
  count: number;
  /**
   * Age of the oldest entry, in seconds.
   *
   * This was the stuck-entry signal while the sweeper dropped verified entries —
   * a surviving entry was unverified by construction. Under DAG §4 D-7 the relay
   * is the durable store and the sweeper never deletes, so the oldest entry is
   * simply the oldest read anyone ever confessed. It says nothing about health.
   * The stuck-entry signal is now `SweepReport.pending`.
   */
  oldest_entry_age_seconds: number;
}

/**
 * One sweep pass (M7 under D-7). The sweeper is an induction backfill: it never
 * deletes, so these count what XTrace knows, not what the relay has shed.
 */
export interface SweepReport {
  /** Past the settle window and confirmed present in XTrace's induction index. */
  pooled: number;
  /** Re-sent to XTrace this pass, because the ingest failed or was never annotated. */
  reingested: number;
  /** Past the window and still unconfirmed. THE stuck-entry signal under D-7. */
  pending: number;
  /** Reads the relay holds. This is the pool size, not a backlog. */
  stored: number;
  /** Age of the oldest stored read. Store age — for a health signal use `pending`. */
  oldestStoredAgeSeconds: number;
}

export interface NudgeState {
  optedIn: boolean;
  silenced: boolean;
  armed: boolean;
  lastFiredDay: string | null; // local-timezone day key (N1)
}
