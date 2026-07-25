/**
 * The Ask engine (K7). Pure kernel: no I/O, and `now` arrives on the input.
 *
 * This is the module task DAG §4 D-6 added. `AskEngine.ask(input) → Card` was declared in
 * the contracts and stubbed at P0.2, but no task built it, and X3 was specced to assemble
 * the card inside the CLI — which §1 forbids and which would have left the UI lane either
 * importing from `src/cli/**` or writing the assembly a second time.
 *
 * It cannot literally return a `Card`, because a `Card` carries `reasonLine` and that
 * sentence is written by a model (plan v1.0 §2b: the client ranks, the model narrates).
 * So the work splits in two, and both halves are pure:
 *
 *   planAsk(input)           → everything the card needs except copy, plus NarratorFacts
 *   assembleCard(plan, copy) → the Card, once a narrator has returned copy
 *
 * A front end therefore does three things and decides nothing: call `planAsk`, hand
 * `plan.facts` to a narrator, call `assembleCard`.
 */

import { KFLOOR, matched, missed } from './cohorts.js';
import { exclusionsFor, scorePlaces, type Exclusion } from './score.js';
import { suppressions } from './rotation.js';
import { DEMO_CONTEXT } from '../contracts/types.js';
import type {
  AskContext,
  Card,
  CardCopy,
  CohortStat,
  NarratorFacts,
  Place,
  RankedPlace,
} from '../contracts/types.js';
import type { AskInput } from '../contracts/modules.js';

/**
 * How many places sit behind the pick on the card.
 *
 * Two, because the demo's peak is a visible reordering of a top three (design v0.8 §4).
 * It lives here rather than in `constants.ts` because it shapes the engine's output, not
 * the scoring maths — nothing about retuning a rehearsal should touch it.
 */
export const RUNNERS_UP_COUNT = 2;

/**
 * Both synthesised claims come from async substrate calls (M2 over the pool, M3 over the
 * user's own scope). A pure engine cannot fetch either, so the caller passes in what it has.
 *
 * Two fields rather than one because they make different promises — one is about strangers,
 * one is about the reader — and D-8 counts them as separate inputs to a recommendation.
 */
export interface AskEngineInput extends AskInput {
  poolClaim?: string;
  personalClaim?: string;
  /**
   * Per-place affinity in `[0, 1]`, from what the diner said in their own words (D-14).
   *
   * A MULTIPLIER over the kernel's score, and only over places the kernel already allowed —
   * so it can reorder survivors and can never resurrect an exclusion. `giConstraint`, the
   * budget ceiling, rotation and the k-floor stay exactly where they were, decided by code
   * that cannot be talked out of them.
   *
   * Absent, or absent for a place, means `1`: the kernel score unchanged. That is not a
   * degraded ranking, it is the ranking this product gave before affinity existed, which is
   * what makes the no-model path correct rather than merely tolerable.
   *
   * The kernel stays PURE (§1): it multiplies a number it is handed. Obtaining that number
   * is the caller's I/O, in `src/llm/scorer.ts`.
   */
  affinity?: Readonly<Record<string, number>>;
}

/**
 * Kernel score × affinity, clamped and defaulting to 1.
 *
 * Clamped because the number comes from a model: a score of `4` or `-2` would silently
 * outrank every constraint-respecting place, and the kernel must not be the thing that
 * trusts it. Out-of-range is clamped rather than rejected — a bad affinity should cost the
 * ranking its nuance, never the diner their recommendation.
 */
export function applyAffinity(
  ranked: readonly RankedPlace[],
  affinity: AskEngineInput['affinity'],
): RankedPlace[] {
  if (affinity === undefined) return [...ranked];
  return [...ranked]
    .map((entry) => {
      const raw = affinity[entry.place.id];
      const factor = typeof raw === 'number' && Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 1;
      return { ...entry, score: entry.score * factor };
    })
    .sort((a, b) => b.score - a.score || a.place.id.localeCompare(b.place.id));
}

interface AskPlanBase {
  /** Why each excluded place is absent — The Pass shows this, and it is not an error. */
  exclusions: Exclusion[];
  /** Every candidate's score, keyed by place id. Full transparency for The Pass. */
  scores: Record<string, number>;
}

/**
 * No place survived the hard constraints. Reachable in practice — a gi-constrained diner
 * in a corpus with no safe options — so it is a variant of the result rather than an
 * exception, and a caller cannot forget to handle it.
 */
export interface NoCandidatesPlan extends AskPlanBase {
  kind: 'no_candidates';
}

export interface RankedAskPlan extends AskPlanBase {
  kind: 'ranked';
  pick: Place;
  ranked: RankedPlace[];
  runnersUp: Array<{ place: Place; score: number }>;
  facts: NarratorFacts;
}

export type AskPlan = NoCandidatesPlan | RankedAskPlan;

/**
 * Which cohort the card cites: the largest citable one, ties broken by the order `matched`
 * already returns (the canonical driver vocabulary), so the choice is deterministic.
 *
 * Largest rather than "most influential on the pick": attributing score contribution back
 * to a single cohort would be a guess dressed as arithmetic, and the number the card
 * actually says out loud is the cohort size — "made that cohort six strong".
 */
function strongest(stats: CohortStat[]): CohortStat | undefined {
  return stats.reduce<CohortStat | undefined>(
    (best, stat) => (best === undefined || stat.k > best.k ? stat : best),
    undefined,
  );
}

/**
 * The closed vocabulary of usual-note keys.
 *
 * `NarratorFacts.usualNotes` is typed `string[]` by the frozen contract, which is what let
 * a raw key reach a card: K7 emitted `spice_tolerance_low`, L1 rendered note[0] verbatim,
 * and nothing in the type system objected. Exporting the vocabulary lets L1's catalog key
 * a `Record<UsualNoteKey, string>` off it, so a key added here without a phrase there is a
 * compile error rather than a card that shows an identifier to a user.
 */
export const USUAL_NOTE_KEYS = [
  'spice_tolerance_low',
  'budget_band_1',
  'budget_band_2',
  'budget_band_3',
  'budget_band_4',
  'portion_small',
  'portion_large',
  'solo_comfortable',
  'gi_constraint',
  'has_default_order',
] as const;

export type UsualNoteKey = (typeof USUAL_NOTE_KEYS)[number];

/**
 * Facts about the Usual, as stable keys rather than prose — same convention as
 * `Suppression.reasonKey`. Copy belongs to L1's catalog; the kernel must not put a
 * sentence in front of the linter's back.
 */
function usualNotes(input: AskEngineInput): UsualNoteKey[] {
  const notes: UsualNoteKey[] = [];
  const { usual } = input;
  if (usual.spiceTolerance <= 1) notes.push('spice_tolerance_low');
  if (usual.budgetBand <= 2) notes.push(`budget_band_${String(usual.budgetBand)}` as UsualNoteKey);
  if (usual.portionPref !== 'standard') notes.push(`portion_${usual.portionPref}`);
  if (usual.soloComfort) notes.push('solo_comfortable');
  if (usual.giConstraint) notes.push('gi_constraint');
  // A flag, not the dish: naming "the thing they always actually order" would need a
  // structured field on NarratorFacts, which is a contract change.
  if (usual.defaultOrder !== undefined) notes.push('has_default_order');
  return notes;
}

/**
 * `demoMode` pins the context so rehearsals are reproducible, per the contract's own note
 * on `AskInput.context`. Outside demo mode a context is required: silently falling back to
 * the demo's rainy 19:00 would make a real recommendation quietly wrong, which is worse
 * than a loud failure.
 */
function contextFor(input: AskEngineInput): AskContext {
  if (input.flags.demoMode) return DEMO_CONTEXT;
  if (input.context === undefined) {
    throw new Error('askEngine: context is required unless flags.demoMode pins DEMO_CONTEXT');
  }
  return input.context;
}

/** Everything the card needs except the copy a narrator writes. */
export function planAsk(input: AskEngineInput): AskPlan {
  const context = contextFor(input);
  // `scorePlaces` filters internally, so this re-runs `exclusionsFor` per place — since
  // D-11 that includes a `matched()` census per call. Kept deliberately: the corpus is
  // dozens of places and the census O(reads), and the alternative is growing K4's
  // ranking API a second return value that only The Pass consumes. Both call sites
  // thread the same `reads`, which is what keeps this list and the ranking consistent
  // about who was lifted.
  const exclusions = input.corpus.flatMap((place) =>
    exclusionsFor(place, input.usual, input.reads),
  );
  const ranked = applyAffinity(
    scorePlaces({
      reads: input.reads,
      usual: input.usual,
      log: input.log,
      corpus: input.corpus,
      context,
      now: input.now,
    }),
    input.affinity,
  );

  const scores: Record<string, number> = {};
  for (const entry of ranked) scores[entry.place.id] = entry.score;

  const top = ranked[0];
  if (top === undefined) {
    // `scorePlaces` ranks exactly `candidates(corpus, usual)`, so an empty ranking means
    // the hard constraints excluded everything — there is no other way to get here.
    return { kind: 'no_candidates', exclusions, scores };
  }

  // A citation is preferred; a miss is the fallback the card speaks aloud. Both are
  // already floor-filtered by K6, so nothing sub-floor can be cited from here.
  const citation = strongest(matched(input.usual, input.reads, KFLOOR));
  const miss =
    citation === undefined ? strongest(missed(input.usual, input.reads, KFLOOR)) : undefined;

  // Non-empty, not merely defined: M2's `inducedClaim()` and M3's `personalClaim()` both
  // return '' to mean "no claim". Testing `!== undefined` let '' through, and the narrator
  // then picked the *induced* reason template — producing a headline that opened with a space
  // and asserted "is where THAT leads" with no antecedent.
  const hasText = (value: string | undefined): value is string =>
    value !== undefined && value.trim() !== '';

  const facts: NarratorFacts = {
    ...(citation !== undefined ? { citation: { driver: citation.driver, k: citation.k } } : {}),
    ...(miss !== undefined ? { cohortMiss: { driver: miss.driver } } : {}),
    ...(hasText(input.poolClaim) ? { poolClaim: input.poolClaim } : {}),
    ...(hasText(input.personalClaim) ? { personalClaim: input.personalClaim } : {}),
    // Every current suppression, NOT just the pick's dishes. The rotation line exists to
    // explain what was *not* chosen — design v0.8 §5's own example is "Not ramen — twice
    // this week already", about a dish the diner did not get — so filtering to the pick
    // would hide the fact the line is made of.
    suppressions: suppressions(input.log, input.now),
    usualNotes: usualNotes(input),
    // M6 reports degradation per query; `pool: 'relay-only'` is the standing flag for it.
    degradedPool: input.degradedPool ?? (input.flags.pool === 'relay-only'),
  };

  return {
    kind: 'ranked',
    pick: top.place,
    ranked,
    runnersUp: ranked
      .slice(1, 1 + RUNNERS_UP_COUNT)
      .map((entry) => ({ place: entry.place, score: entry.score })),
    facts,
    exclusions,
    scores,
  };
}

/**
 * The plan plus a narrator's copy, as a `Card`.
 *
 * Takes only the ranked variant, so "what does the card look like when nothing qualifies"
 * cannot be answered by accident — the caller has to have handled `no_candidates` before
 * it can reach this function.
 */
export function assembleCard(askPlan: RankedAskPlan, copy: CardCopy): Card {
  const { facts } = askPlan;
  return {
    pick: askPlan.pick,
    reasonLine: copy.reasonLine,
    ...(copy.rotationLine !== undefined ? { rotationLine: copy.rotationLine } : {}),
    ...(copy.usualLine !== undefined ? { usualLine: copy.usualLine } : {}),
    ...(facts.citation !== undefined ? { poolCitation: facts.citation } : {}),
    ...(facts.cohortMiss !== undefined ? { cohortMiss: facts.cohortMiss } : {}),
    runnersUp: askPlan.runnersUp,
    scores: askPlan.scores,
    degradedPool: facts.degradedPool,
  };
}
