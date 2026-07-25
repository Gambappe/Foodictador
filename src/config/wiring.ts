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
  StubRelay,
  StubSettingsStore,
} from '../contracts/stubs/index.js';
import { createMemoryClient, createFetchTransport } from '../memory/client.js';
import { createPoolStore } from '../memory/pool.js';
import { placeNames } from '../memory/readProse.js';
import { loadCorpus } from '../../scripts/seed/validate-corpus.js';
import { createPoolView } from '../memory/poolView.js';
import { createRelayClient } from '../memory/relay.js';
import { createUserStore } from '../memory/user.js';
import { createSettingsClient } from '../memory/settings.js';
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
  // The corpus is read once per graph, not per write: the pool renders reads as prose and
  // needs place NAMES, because feeding the extractor an id puts the id back on a card (L4).
  const pool = createPoolStore({ client, logger, placeName: placeNames(loadCorpus()) });
  // Settings ride the relay, which P0.8 made atomic and fsynced-before-acknowledged — the
  // guarantee an allergy list needs, and the one XTrace does not offer (D-8).
  const settings = createSettingsClient({ url: config.relayUrl, token: config.relayToken, logger });
  const user = createUserStore({ client, settings, logger });
  const relay = createRelayClient({ url: config.relayUrl, token: config.relayToken, logger });
  const poolView = createPoolView({ relay, flags, logger });

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
  /**
   * The caller's flag store, for the same reason `liveGraph` takes one: X1 puts a
   * FlagStore on the CommandContext, and a graph that made its own would mean
   * `pass flags --set` mutated one store while every adapter read another. The CLI
   * acceptance gate drives real commands against this graph, so the toggle has to
   * be the same toggle.
   */
  flags?: FlagStore;
}

/**
 * A graph with no network, no API key and no XTrace credentials — what `gate:cli` runs.
 *
 * **Only the I/O leaves are stubbed.** `StubMemoryClient` (which really does round-trip
 * rows per scope) and `StubRelay` stand in for the two things that would otherwise open a
 * socket; `PoolStore`, `UserStore` and `PoolView` are the *real* M2/M3/M6 implementations
 * on top of them, and copy comes from the real L1 template narrator.
 *
 * That distinction is the difference between a gate that proves something and a gate that
 * proves the stubs agree with each other. `StubPoolView` in particular serves a static
 * baseline, so a confession written during the run could never change what Ask returns —
 * and "the cohort citation moved" is the one assertion the acceptance run exists to make.
 *
 * Flags start all-`live`: the implementations above the leaves are the real ones, so
 * reporting degraded would misdescribe which path the gate exercised.
 */
export function fixtureGraph(options: FixtureGraphOptions): AdapterGraph {
  const { logger } = options;
  const now = options.now ?? ((): Date => new Date('2026-07-25T19:00:00.000Z'));

  const flags =
    options.flags ??
    createFlagStore({ extraction: 'live', narrator: 'live', pool: 'live', demoMode: true }, logger);

  const client = new StubMemoryClient();
  const relay = new StubRelay(now);
  // The corpus is read once per graph, not per write: the pool renders reads as prose and
  // needs place NAMES, because feeding the extractor an id puts the id back on a card (L4).
  const pool = createPoolStore({ client, logger, placeName: placeNames(loadCorpus()) });
  // A Map, not the HTTP client: this graph must build with no config and open no socket.
  // Faithful rather than a pretence — a keyed store IS a Map, which is M11's whole argument.
  const user = createUserStore({ client, settings: new StubSettingsStore(), logger });
  const poolView = createPoolView({ relay, flags, logger });

  return {
    client,
    pool,
    user,
    relay,
    poolView,
    extractor: new StubExtractor(),
    // The real L1 narrator, not StubNarrator: template copy is the default production
    // path when no key is present, so the gate should exercise it.
    narrator: templateNarrator,
    flags,
    logger,
    settleWindowSeconds: 0, // Nothing settles asynchronously behind a stub client.
  };
}
