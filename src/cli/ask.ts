/**
 * `confit ask` (X3) — assemble the card.
 *
 * Assembly is coordination, not business logic: candidates come from the S1
 * corpus, reads from M6's PoolView, cohort verdicts from K6, suppressions from
 * K3, the ranking from K4, and every sentence from the narrator (L3 live or L1
 * template — the flag decides, never this module). Never prints a confession;
 * never cites a cohort K6 did not return as matched — the floor is enforced
 * upstream and respected here by construction.
 *
 * A cohort miss is a NORMAL card (exit 0): it renders the first-teller line,
 * the demo's rehearsed branch, not a failure.
 */

import type { Narrator, PoolView, UserStore } from '../contracts/modules.js';
import type {
  AskContext,
  Card,
  CohortStat,
  Driver,
  NarratorFacts,
  Place,
  RankedPlace,
  Read,
} from '../contracts/types.js';
import { DEMO_CONTEXT, DRIVERS } from '../contracts/types.js';
import type { Flags } from '../contracts/flags.js';
import type { Logger } from '../config/logger.js';
import { UNMATCHABLE_DRIVERS, matched, missed } from '../kernel/cohorts.js';
import { DRIVER_PHRASES } from '../llm/catalog.js';
import type { UsualNoteKey } from '../kernel/askEngine.js';
import { suppressions } from '../kernel/rotation.js';
import { scorePlaces } from '../kernel/score.js';
import { EXIT, type CommandResult } from './render.js';

const MATCHABLE_DRIVERS: readonly Driver[] = DRIVERS.filter(
  (driver) => !UNMATCHABLE_DRIVERS.includes(driver),
);

export interface AskDeps {
  profile: string;
  userStore: UserStore;
  poolView: PoolView;
  narrator: Narrator;
  corpus: Place[];
  flags: Flags;
  logger: Logger;
  now: string;
  /** Live-pool induction; absent under relay-only. Failure degrades to no claim. */
  inducedClaim?: (query: string) => Promise<string>;
}

/** Deterministic pick among citable cohorts: largest k, then vocabulary order. */
function bestCohort(stats: CohortStat[]): CohortStat | undefined {
  return [...stats].sort(
    (a, b) => b.k - a.k || DRIVERS.indexOf(a.driver) - DRIVERS.indexOf(b.driver),
  )[0];
}

function contextFor(flags: Flags, now: string, solo: boolean): AskContext {
  if (flags.demoMode) return DEMO_CONTEXT;
  return { hour: new Date(now).getHours(), solo, weather: 'clear' };
}

/** One pre-linted usual note, or none — never an unlinted string into the card. */
/**
 * The usual note, as a CATALOG KEY — not a sentence.
 *
 * This returned `'A seat for one, no audience — your usual shape.'` and the line never
 * once reached a card (defect SL-15). `usualLineFor` filters its input against
 * `USUAL_PHRASES`, a closed key vocabulary, because an unfiltered pass-through is how a
 * raw identifier got onto a card in the first place (SL-01) and how `'toString'` threw
 * (SL-18). A full sentence is not a key, so `Object.hasOwn` dropped it, `phrases.length`
 * was zero, and `copy.usualLine` came back `undefined` on **every** card `confit ask`
 * printed — one of the four lines design v0.8 §5 specifies, silently absent, with no
 * error anywhere.
 *
 * Emitting the key instead puts the wording in the catalog, where G3 lints it and where
 * K7's `askEngine` already puts its own notes. The place-aware condition is kept: the
 * note is only true if the pick can actually seat one.
 */
function usualNote(pick: Place, solo: boolean): UsualNoteKey[] {
  if (!solo) return [];
  const seated =
    pick.tags.includes('counter_seating') || pick.tags.includes('solo_friendly');
  return seated ? ['solo_comfortable'] : [];
}

export async function runAsk(deps: AskDeps): Promise<CommandResult> {
  const usual = await deps.userStore.usual(deps.profile);
  if (usual === null) {
    return {
      lines: [
        `Profile ${deps.profile} has no Usual yet — run \`confit pass provision --profile ${deps.profile}\` first.`,
      ],
      data: { error: 'unprovisioned', profile: deps.profile },
      exit: EXIT.environment,
    };
  }
  const log = await deps.userStore.mealLog(deps.profile);

  // Fetch per matchable driver (the counting path is per-driver by design, [E22])
  // and union — read_ids are globally unique, so a driver-keyed union stays exact.
  const reads: Read[] = [];
  const seen = new Set<string>();
  let degraded = false;
  for (const driver of MATCHABLE_DRIVERS) {
    const result = await deps.poolView.readsForDriver(driver);
    degraded = degraded || result.degraded;
    for (const read of result.reads) {
      if (seen.has(read.read_id)) continue;
      seen.add(read.read_id);
      reads.push(read);
    }
  }

  const ranked: RankedPlace[] = scorePlaces({
    reads,
    usual,
    log,
    corpus: deps.corpus,
    context: contextFor(deps.flags, deps.now, usual.soloComfort),
    now: deps.now,
  });
  const pick = ranked[0];
  if (pick === undefined) {
    return {
      lines: ['No candidate places survive the hard constraints — check the corpus and profile.'],
      data: { error: 'no_candidates' },
      exit: EXIT.environment,
    };
  }

  const citation = bestCohort(matched(usual, reads));
  const miss = citation === undefined ? bestCohort(missed(usual, reads)) : undefined;
  const suppressed = suppressions(log, deps.now);

  let inducedClaim: string | undefined;
  if (deps.inducedClaim !== undefined && !degraded) {
    try {
      inducedClaim = await deps.inducedClaim('what people quietly regret near here');
    } catch (error) {
      deps.logger.line(
        `ask: induction unavailable, card proceeds without it: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const facts: NarratorFacts = {
    ...(citation ? { citation: { driver: citation.driver, k: citation.k } } : {}),
    ...(miss ? { cohortMiss: { driver: miss.driver } } : {}),
    ...(inducedClaim !== undefined ? { inducedClaim } : {}),
    suppressions: suppressed,
    usualNotes: usualNote(pick.place, usual.soloComfort),
    degradedPool: degraded,
  };
  const copy = await deps.narrator.write(ranked, facts);

  const card: Card = {
    pick: pick.place,
    reasonLine: copy.reasonLine,
    ...(citation ? { poolCitation: { driver: citation.driver, k: citation.k } } : {}),
    ...(copy.rotationLine !== undefined ? { rotationLine: copy.rotationLine } : {}),
    ...(copy.usualLine !== undefined ? { usualLine: copy.usualLine } : {}),
    ...(miss ? { cohortMiss: { driver: miss.driver } } : {}),
    runnersUp: ranked.slice(1, 3).map((entry) => ({ place: entry.place, score: entry.score })),
    scores: Object.fromEntries(ranked.map((entry) => [entry.place.id, entry.score])),
    ...(degraded ? { degradedPool: true } : {}),
  };

  const lines: string[] = [`▸ ${card.pick.name}`, card.reasonLine];
  if (card.poolCitation) {
    // DRIVER_PHRASES, not the token with its underscores swapped for spaces. That
    // produced `[spice tolerance low × 8]` one line under the *correct* prose rendering
    // of the same driver (defect SL-30) — the K5 banned-lexicon failure of SL-01,
    // reappearing on the one surface no test was reading. U3's AskCard already renders
    // the phrase; this now matches it.
    lines.push(
      `[people with ${DRIVER_PHRASES[card.poolCitation.driver]} · ${card.poolCitation.k} of them]`,
    );
  } else if (copy.cohortMissLine !== undefined) {
    lines.push(copy.cohortMissLine);
  }
  if (card.rotationLine !== undefined) lines.push(card.rotationLine);
  if (card.usualLine !== undefined) lines.push(card.usualLine);
  if (card.degradedPool === true) {
    lines.push('(pool degraded — answering from cached patterns; counts are live)');
  }
  lines.push('');
  lines.push('Runners-up:');
  for (const runner of card.runnersUp) {
    lines.push(`  ${runner.place.name} — ${runner.score.toFixed(4)}`);
  }

  return {
    lines,
    data: { card },
    exit: EXIT.ok,
  };
}

// ---- integration wiring (the handler main.ts registers) ----

import type { CommandContext, CommandHandler } from './main.js';
import { loadCorpus } from '../../scripts/seed/validate-corpus.js';


export const askHandler: CommandHandler = async (context: CommandContext) => {
  const profile = context.argv.values['profile'];
  if (profile === undefined) throw new Error('ask: --profile survived validation unset');
  const graph = context.graph;
  return runAsk({
    profile,
    userStore: graph.user,
    poolView: graph.poolView,
    narrator: graph.narrator,
    corpus: loadCorpus(),
    flags: graph.flags.get(),
    logger: graph.logger,
    now: new Date().toISOString(),
    inducedClaim: (query) => graph.pool.inducedClaim(query),
  });
};
