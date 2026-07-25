import { globSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { templateNarrator } from '../llm/template.js';
import { createFlagStore } from './flagStore.js';
import { createLogger } from './logger.js';
import { fixtureGraph, liveGraph, type AdapterGraph } from './wiring.js';
import type { AppConfig } from './env.js';

function silentLogger(): { logger: ReturnType<typeof createLogger>; lines: string[] } {
  const lines: string[] = [];
  return { logger: createLogger((line) => lines.push(line)), lines };
}

const withKey: AppConfig = {
  xtraceBaseUrl: 'https://xtrace.invalid',
  xtraceApiKey: 'xk',
  relayUrl: 'https://relay.invalid',
  relayToken: 'rt',
  anthropicApiKey: 'sk-test',
  settleWindowSeconds: 480,
};

const withoutKey: AppConfig = { ...withKey, anthropicApiKey: null };

/** Every adapter the graph promises. A missing one is a command that cannot be wired. */
const ADAPTERS = [
  'client',
  'pool',
  'user',
  'relay',
  'poolView',
  'extractor',
  'narrator',
  'flags',
  'logger',
] as const satisfies readonly (keyof AdapterGraph)[];

describe('fixtureGraph', () => {
  it('provides every adapter', () => {
    const graph = fixtureGraph({ logger: silentLogger().logger });
    for (const key of ADAPTERS) expect(graph[key]).toBeDefined();
  });

  it('builds with no config at all — no URL, no key, no token', () => {
    // G5's acceptance criterion: green on a clean checkout with no network and no
    // ANTHROPIC_API_KEY. A fixture graph that needed an AppConfig could not deliver that.
    expect(() => fixtureGraph({ logger: silentLogger().logger })).not.toThrow();
  });

  it('drives a write and counts it back through the view', async () => {
    const graph = fixtureGraph({ logger: silentLogger().logger });
    const read = {
      read_id: '11111111-2222-4333-8444-555555555555',
      place: 'rosas_taqueria',
      signal: 'secret_default',
      driver: 'spice_tolerance_low',
      cadence: 'weekly',
      weight: 0.8,
    } as const;

    await graph.relay.put(read);
    const entries = await graph.relay.list();
    expect(entries.map((entry) => entry.read.read_id)).toContain(read.read_id);

    // Counted through the PoolView, which is the relay under D-7. Asserting it
    // through `pool` instead would test XTrace's induction feed and call it
    // counting — the confusion that produced the round-trip that never worked.
    await graph.pool.writeRead(read);
    const back = await graph.poolView.readsForDriver('spice_tolerance_low');
    expect(back.reads.map((r) => r.read_id)).toContain(read.read_id);
  });

  it('reports flags as live, because the stubs are the implementations', () => {
    // Marking a stub graph "degraded" would hide which path the gate exercised.
    const graph = fixtureGraph({ logger: silentLogger().logger });
    expect(graph.flags.get()).toMatchObject({ extraction: 'live', narrator: 'live' });
  });

  it('pins its clock so a fixture run is reproducible', async () => {
    const first = fixtureGraph({ logger: silentLogger().logger });
    const second = fixtureGraph({ logger: silentLogger().logger });
    const read = {
      read_id: '11111111-2222-4333-8444-555555555555',
      place: 'p',
      signal: 'secret_default',
      driver: 'spice_tolerance_low',
      cadence: 'weekly',
      weight: 0.5,
    } as const;
    await first.relay.put(read);
    await second.relay.put(read);
    const [a] = await first.relay.list();
    const [b] = await second.relay.list();
    expect(a?.received_at).toBe(b?.received_at);
  });
});

describe('liveGraph', () => {
  it('provides every adapter', () => {
    const graph = liveGraph(withKey, silentLogger().logger);
    for (const key of ADAPTERS) expect(graph[key]).toBeDefined();
  });

  it('carries the settle window through for the sweeper', () => {
    const graph = liveGraph({ ...withKey, settleWindowSeconds: 123 }, silentLogger().logger);
    expect(graph.settleWindowSeconds).toBe(123);
  });

  it('builds a working graph with no model key rather than throwing', () => {
    // P0.3 already flipped the flags for a missing key; a graph that threw here instead
    // would make the no-key path unrunnable, which is the path G5 must run.
    const { logger, lines } = silentLogger();
    const graph = liveGraph(withoutKey, logger);
    expect(graph.narrator).toBeDefined();
    expect(graph.extractor).toBeDefined();
    expect(graph.flags.get()).toMatchObject({ extraction: 'seeded', narrator: 'template' });
    expect(lines.join('\n')).toContain('no-api-key');
  });

  it('produces template copy when there is no model key', async () => {
    const graph = liveGraph(withoutKey, silentLogger().logger);
    const copy = await graph.narrator.write([], {
      suppressions: [],
      usualNotes: [],
      degradedPool: false,
    });
    // Reaching a real API would have thrown on the invalid host; template copy proves
    // the degrade path was chosen, not merely configured.
    expect(copy.reasonLine.length).toBeGreaterThan(0);
  });

  it('returns canned chips when there is no model key', async () => {
    const graph = liveGraph(withoutKey, silentLogger().logger);
    const proposed = await graph.extractor.propose('I pretend to like the hot sauce', []);
    expect(proposed).toBeDefined();
  });

  it('uses the caller\'s flag store rather than making its own', () => {
    // X1 puts a FlagStore in the CommandContext. A graph that built a second one would
    // mean `pass flags --set narrator=template` mutated one store while every adapter
    // read another — the toggle would appear to work and change nothing.
    const { logger } = silentLogger();
    const shared = createFlagStore(
      { extraction: 'live', narrator: 'live', pool: 'live', demoMode: false },
      logger,
    );
    const graph = liveGraph(withKey, logger, shared);
    expect(graph.flags).toBe(shared);

    shared.set('pool', 'relay-only', 'test');
    expect(graph.flags.get().pool).toBe('relay-only');
  });

  it('honours an operator toggle to template even when a key is present', () => {
    const { logger } = silentLogger();
    const shared = createFlagStore(
      { extraction: 'live', narrator: 'template', pool: 'live', demoMode: false },
      logger,
    );
    // Otherwise `pass flags --set narrator=template` would silently keep calling the model.
    const graph = liveGraph(withKey, logger, shared);
    expect(graph.narrator).toBe(templateNarrator);
  });
});

describe('no command builds its own adapters', () => {
  it('is the only module that constructs one', () => {
    // The whole point of P0.6: if a command reaches for a factory itself, the graph stops
    // being the single place wiring is reviewed, and the fixture path silently diverges
    // from the live one.
    const root = new URL('../', import.meta.url);
    const files = globSync('{cli,kernel}/**/*.ts', { cwd: fileURLToPath(root) }).filter(
      (name) => !name.endsWith('.test.ts'),
    );
    expect(files.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const name of files) {
      const source = readFileSync(fileURLToPath(new URL(name, root)), 'utf8');
      const buildsAnAdapter =
        /create(MemoryClient|PoolStore|UserStore|RelayClient|PoolView|FetchTransport)\s*\(/;
      if (buildsAnAdapter.test(source)) offenders.push(name);
    }
    expect(offenders).toEqual([]);
  });
});
