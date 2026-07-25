/**
 * Adapter construction (P0.6) — the seam nobody owned.
 *
 * Every command in lane X takes its stores injected, which is right for testing and left
 * production assembly with no home: each command knew how to *use* a `PoolStore` and
 * nothing knew how to *build* one. This module is the one place that turns an `AppConfig`
 * into a working graph, so a command author never writes `new` and the wiring is reviewed
 * once instead of six times.
 *
 * Two factories:
 *
 *  - `liveGraph(config, logger)` — real HTTP against XTrace, the relay and the model API.
 *  - `fixtureGraph()` — the P0.2 stubs, which is what lets `gate:cli` drive the whole
 *    flow with no network and no `ANTHROPIC_API_KEY` (G5's acceptance criterion).
 *
 * The degrade flags decide which LLM implementations the live graph uses, so a missing
 * model key produces a working graph with template copy and seeded chips rather than a
 * crash — P0.3 already flipped the flags; this honours them.
 */

import type {
  Extractor,
  MemoryClient,
  Narrator,
  PoolStore,
  PoolView,
  Relay,
  UserStore,
} from '../contracts/modules.js';
import {
  StubExtractor,
  StubMemoryClient,
  StubNarrator,
  StubPoolStore,
  StubPoolView,
  StubRelay,
  StubUserStore,
} from '../contracts/stubs/index.js';
import { createMemoryClient, createFetchTransport } from '../memory/client.js';
import { createPoolStore } from '../memory/pool.js';
import { createPoolView } from '../memory/poolView.js';
import { createRelayClient } from '../memory/relay.js';
import { createUserStore } from '../memory/user.js';
import { createLiveExtractor } from '../llm/extractor.js';
import { createFetchModelClient, createLiveNarrator } from '../llm/narrator.js';
import { templateNarrator } from '../llm/template.js';
import type { AppConfig } from './env.js';
import { createFlagStore, initialFlags, type FlagStore } from './flagStore.js';
import type { Logger } from './logger.js';

/**
 * Everything a command can ask for. One object rather than six parameters, so adding an
 * adapter later does not touch every call site.
 */
export interface AdapterGraph {
  client: MemoryClient;
  pool: PoolStore;
  user: UserStore;
  relay: Relay;
  poolView: PoolView;
  extractor: Extractor;
  narrator: Narrator;
  flags: FlagStore;
  logger: Logger;
  settleWindowSeconds: number;
}

/**
 * Real adapters against real services.
 *
 * The LLM halves follow the flags rather than the config: P0.3 sets `extraction: seeded`
 * and `narrator: template` when `ANTHROPIC_API_KEY` is absent, and a graph that threw here
 * instead would make the no-key path unrunnable — which is exactly what G5 must run.
 */
export function liveGraph(config: AppConfig, logger: Logger, existing?: FlagStore): AdapterGraph {
  // Take the caller's flag store when there is one. X1 builds a FlagStore and puts it in
  // the CommandContext; a graph that made its own would mean `pass flags --set narrator=
  // template` mutated one store while every adapter read another, and the toggle would
  // appear to work while changing nothing.
  const flags = existing ?? createFlagStore(initialFlags(config, logger), logger);

  const client = createMemoryClient(
    createFetchTransport({ baseUrl: config.xtraceBaseUrl, apiKey: config.xtraceApiKey }),
  );
  const pool = createPoolStore({ client, logger });
  const user = createUserStore({ client, logger });
  const relay = createRelayClient({ url: config.relayUrl, token: config.relayToken, logger });
  const poolView = createPoolView({ pool, relay, flags, logger });

  // No key means no live model. Asking for one anyway would fail at the first call, deep
  // inside a command, instead of here where the reason is obvious.
  const modelClient =
    config.anthropicApiKey === null ? null : createFetchModelClient(config.anthropicApiKey);

  const extractor: Extractor =
    modelClient === null || flags.get().extraction === 'seeded'
      ? new StubExtractor()
      : createLiveExtractor({ client: modelClient, flags, logger });

  const narrator: Narrator =
    modelClient === null || flags.get().narrator === 'template'
      ? templateNarrator
      : createLiveNarrator({ client: modelClient, flags, logger });

  return {
    client,
    pool,
    user,
    relay,
    poolView,
    extractor,
    narrator,
    flags,
    logger,
    settleWindowSeconds: config.settleWindowSeconds,
  };
}

export interface FixtureGraphOptions {
  logger: Logger;
  /** Pinned so a fixture run is reproducible; defaults to the demo's evening. */
  now?: () => Date;
}

/**
 * The P0.2 stubs, wired the same shape as the live graph.
 *
 * This is what `gate:cli` runs against: no network, no API key, no XTrace credentials.
 * Flags start all-`live` on purpose — the stubs *are* the implementations here, so
 * pretending to be degraded would hide which path the gate exercised.
 */
export function fixtureGraph(options: FixtureGraphOptions): AdapterGraph {
  const { logger } = options;
  const now = options.now ?? ((): Date => new Date('2026-07-25T19:00:00.000Z'));

  const flags = createFlagStore(
    { extraction: 'live', narrator: 'live', pool: 'live', demoMode: true },
    logger,
  );

  const client = new StubMemoryClient();
  const pool = new StubPoolStore();
  const relay = new StubRelay(now);

  return {
    client,
    pool,
    user: new StubUserStore(),
    relay,
    poolView: new StubPoolView(),
    extractor: new StubExtractor(),
    narrator: new StubNarrator(),
    flags,
    logger,
    settleWindowSeconds: 0, // Nothing settles asynchronously in a stub graph.
  };
}
