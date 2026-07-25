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
 * `NarratorFacts.inducedClaim` comes from M2's async `inducedClaim()`. A pure engine
 * cannot fetch it, so the caller passes it in if it has one.
 */
export interface AskEngineInput extends AskInput {
  inducedClaim?: string;
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
 * Facts about the Usual, as stable keys rather than prose — same convention as
 * `Suppression.reasonKey`. Copy belongs to L1's catalog; the kernel must not put a
 * sentence in front of the linter's back.
 *
 * The contract types this `string[]`; a key union would be better and is a contract
 * change, so it is noted here rather than taken.
 */
function usualNotes(input: AskEngineInput): string[] {
  const notes: string[] = [];
  const { usual } = input;
  if (usual.spiceTolerance <= 1) notes.push('spice_tolerance_low');
  if (usual.budgetBand <= 2) notes.push(`budget_band_${String(usual.budgetBand)}`);
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
  // `scorePlaces` filters internally, so this re-runs `exclusionsFor` per place. Kept
  // deliberately: it is a couple of comparisons, and the alternative is growing K4's
  // ranking API a second return value that only The Pass consumes.
  const exclusions = input.corpus.flatMap((place) => exclusionsFor(place, input.usual));
  const ranked = scorePlaces({
    reads: input.reads,
    usual: input.usual,
    log: input.log,
    corpus: input.corpus,
    context,
    now: input.now,
  });

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

  const facts: NarratorFacts = {
    ...(citation !== undefined ? { citation: { driver: citation.driver, k: citation.k } } : {}),
    ...(miss !== undefined ? { cohortMiss: { driver: miss.driver } } : {}),
    ...(input.inducedClaim !== undefined ? { inducedClaim: input.inducedClaim } : {}),
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
