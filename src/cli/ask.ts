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
import type { AskContext, Driver, Place, Read } from '../contracts/types.js';
import { DRIVERS } from '../contracts/types.js';
import type { Flags } from '../contracts/flags.js';
import type { Logger } from '../config/logger.js';
import { UNMATCHABLE_DRIVERS } from '../kernel/cohorts.js';
import { assembleCard, planAsk } from '../kernel/askEngine.js';
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

/** Off demoMode, the engine needs a live context; derive a minimal honest one. */
function liveContext(now: string, solo: boolean): AskContext {
  return { hour: new Date(now).getHours(), solo, weather: 'clear' };
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

  // Induction is fetched here because the pure engine cannot (K7's contract);
  // an empty claim is "no claim" (SL-03), and a failure degrades to no claim.
  let inducedClaim: string | undefined;
  if (deps.inducedClaim !== undefined && !degraded) {
    try {
      const claim = await deps.inducedClaim('what people quietly regret near here');
      if (claim !== '') inducedClaim = claim;
    } catch (error) {
      deps.logger.line(
        `ask: induction unavailable, card proceeds without it: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // ONE card assembly in this codebase: K7's planAsk/assembleCard. This module
  // used to carry its own — the exact seam-duplication the defect log names.
  const plan = planAsk({
    reads,
    usual,
    log,
    corpus: deps.corpus,
    flags: deps.flags,
    now: deps.now,
    ...(deps.flags.demoMode ? {} : { context: liveContext(deps.now, usual.soloComfort) }),
    degradedPool: degraded,
    ...(inducedClaim !== undefined ? { inducedClaim } : {}),
  });
  if (plan.kind === 'no_candidates') {
    return {
      lines: ['No candidate places survive the hard constraints — check the corpus and profile.'],
      data: { error: 'no_candidates', exclusions: plan.exclusions },
      exit: EXIT.environment,
    };
  }

  const copy = await deps.narrator.write(plan.ranked, plan.facts);
  const card = assembleCard(plan, copy);

  const lines: string[] = [`▸ ${card.pick.name}`, card.reasonLine];
  if (card.poolCitation) {
    lines.push(`[${card.poolCitation.driver.replaceAll('_', ' ')} × ${card.poolCitation.k}]`);
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
import { createFetchTransport, createMemoryClient } from '../memory/client.js';
import { createPoolStore } from '../memory/pool.js';
import { createRelayClient } from '../memory/relay.js';
import { createPoolView } from '../memory/poolView.js';
import { createUserStore } from '../memory/user.js';
import { createFetchModelClient, createLiveNarrator, type ModelClient } from '../llm/narrator.js';
import { loadCorpus } from '../../scripts/seed/validate-corpus.js';

/** With no key the narrator flag is already 'template' (P0.3), so this never runs. */
const noModelClient: ModelClient = {
  complete: () => Promise.reject(new Error('no ANTHROPIC_API_KEY in this environment')),
};

export const askHandler: CommandHandler = async (context: CommandContext) => {
  const profile = context.argv.values['profile'];
  if (profile === undefined) throw new Error('ask: --profile survived validation unset');
  const { config, flags, logger } = context;
  const client = createMemoryClient(
    createFetchTransport({ baseUrl: config.xtraceBaseUrl, apiKey: config.xtraceApiKey }),
  );
  const pool = createPoolStore({ client, logger });
  const relay = createRelayClient({ url: config.relayUrl, token: config.relayToken, logger });
  const poolView = createPoolView({ pool, relay, flags, logger });
  const userStore = createUserStore({ client, logger });
  const corpus = loadCorpus();
  const narrator = createLiveNarrator({
    client: config.anthropicApiKey === null ? noModelClient : createFetchModelClient(config.anthropicApiKey),
    flags,
    logger,
    corpus,
  });
  return runAsk({
    profile,
    userStore,
    poolView,
    narrator,
    corpus,
    flags: flags.get(),
    logger,
    now: new Date().toISOString(),
    inducedClaim: (query) => pool.inducedClaim(query),
  });
};
