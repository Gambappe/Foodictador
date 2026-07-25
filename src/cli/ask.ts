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

/**
 * `snake_case` between lowercase letters — an enum token, whatever its spelling.
 * Matches the assertion the acceptance gate makes about card lines, deliberately, so the
 * guard and the check agree on what "a raw identifier" means.
 */
const RAW_IDENTIFIER = /[a-z]+_[a-z]+/;

/** The two induction queries. Named, so the pair is visible in one place (D-8). */
// Exported because S5's induction-set probe must BE this query — a committed probe
// that drifts from what `ask` actually issues would gate the wrong question.
export const POOL_QUERY = 'what people quietly regret near here';
const PERSONAL_QUERY = 'what this person keeps doing and what is really behind it';

/**
 * Fetches one synthesised claim and refuses it unless it is safe to print.
 *
 * ONE implementation for both the pool claim and the personal claim, because they are the
 * same kind of risk: text Confit did not write, on its way to a card. A second copy of the
 * rule is a second copy free to drift, and the personal claim is the one where a leaked
 * identifier would be describing the reader rather than a crowd.
 *
 * Every failure returns `undefined` and the card is built to stand without a claim, so an
 * unavailable substrate, an unparseable answer and an unprintable one all degrade the same
 * way — the alternative is an Ask that fails because a decorative line could not be produced.
 */
async function safeClaim(
  which: 'pool' | 'personal',
  fetch: ((query: string) => Promise<string>) | undefined,
  query: string,
  deps: Pick<AskDeps, 'logger'>,
): Promise<string | undefined> {
  if (fetch === undefined) return undefined;
  let claim: string;
  try {
    claim = await fetch(query);
  } catch (error) {
    deps.logger.line(
      `ask: ${which} synthesis unavailable, card proceeds without it: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return undefined;
  }
  if (claim.trim() === '') return undefined;

  // Defect L4. G3 lints the catalog, and the catalog INTERPOLATES this value — so the
  // sentence around it is checked and the sentence itself never was. Measured live on the
  // first working card: 'The key context was that the driver was "spice_tolerance_low"'.
  const verdict = lint(claim);
  if (!verdict.ok) {
    deps.logger.line(
      `ask: ${which} claim dropped — it carries ${verdict.hits.join(', ')} (K5 lexicon)`,
    );
    return undefined;
  }
  if (RAW_IDENTIFIER.test(claim)) {
    // An enum token is a shape, not a banned word, so the lexicon alone does not catch it.
    // M14 stopped us feeding ids to the extractor, but pre-M14 records remain (M15) and the
    // claim is not ours either way.
    deps.logger.line(`ask: ${which} claim dropped — it carries a raw identifier`);
    return undefined;
  }
  return claim;
}
import { lint } from '../kernel/copylint.js';
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
  /** The CROWD's synthesis — M2 over `confit:pool`. D-8's third input. */
  inducedClaim?: (query: string) => Promise<string>;
  /** THIS user's own synthesis — M3 over their scope. D-8's second input (M16). */
  personalClaim?: (query: string) => Promise<string>;
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

  // D-8's second and third inputs. Both are XTrace synthesis, both are the only text on a
  // card Confit did not write, so both go through ONE gate — a second copy of the lint rule
  // is a second copy free to drift, and the personal claim is the one where a leaked
  // identifier would be describing the reader.
  const claims = deps.inducedClaim === undefined && deps.personalClaim === undefined
    ? { pool: undefined, personal: undefined }
    : {
        pool: degraded ? undefined : await safeClaim('pool', deps.inducedClaim, POOL_QUERY, deps),
        personal: await safeClaim('personal', deps.personalClaim, PERSONAL_QUERY, deps),
      };

  const facts: NarratorFacts = {
    ...(citation ? { citation: { driver: citation.driver, k: citation.k } } : {}),
    ...(miss ? { cohortMiss: { driver: miss.driver } } : {}),
    ...(claims.pool !== undefined ? { poolClaim: claims.pool } : {}),
    ...(claims.personal !== undefined ? { personalClaim: claims.personal } : {}),
    suppressions: suppressed,
    usualNotes: usualNote(pick.place, usual.soloComfort),
    degradedPool: degraded,
  };
  const copy = await deps.narrator.write(ranked, facts);

  const card: Card = {
    pick: pick.place,
    reasonLine: copy.reasonLine,
    ...(copy.personalLine !== undefined ? { personalLine: copy.personalLine } : {}),
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
  // After the Usual, because both describe the reader and the declared profile should be
  // read before what has been inferred about them (D-8 puts them on similar footing; order
  // is the only thing that says which one they told us themselves).
  if (card.personalLine !== undefined) lines.push(card.personalLine);
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
    // D-8's second input, finally read. The personal scope has been written on every
    // confession since M5 and queried by nothing until now.
    personalClaim: (query) => graph.user.personalClaim(profile, query),
  });
};
