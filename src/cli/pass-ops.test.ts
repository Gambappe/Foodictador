import { describe, expect, it } from 'vitest';

import { DEFAULT_FLAGS } from '../contracts/flags.js';
import { FIXTURE_NOW, corpusFixture, poolBaseline } from '../contracts/fixtures/index.js';
import { StubPoolView, StubRelay, StubUserStore } from '../contracts/stubs/index.js';
import { TemplateNarrator } from '../llm/template.js';
import { createFlagStore, createLogger } from '../config/index.js';
import { createNudge } from '../nudge/nudge.js';
import { sampleRead } from '../contracts/fixtures/index.js';
import { EXIT } from './render.js';
import { runAsk } from './ask.js';
import {
  NUDGE_SETTINGS_KEY,
  NUDGE_SETTINGS_PROFILE,
  nudgeHandler,
  runFlags,
  runNudgeArm,
  runProvision,
  runReset,
  runSeed,
} from './pass-ops.js';
import { parseNudgeState } from '../nudge/nudge.js';
import { fixtureGraph, type AdapterGraph } from '../config/wiring.js';
import { parseArgv } from './args.js';
import type { CommandContext } from './main.js';
import type { AppConfig } from '../config/env.js';

const silentLogger = createLogger(() => {});

describe('X7 pass provision', () => {
  it('provision --profile B then confit ask --profile B works on a fresh store', async () => {
    const userStore = new StubUserStore();
    const provisioned = await runProvision('B', { userStore, logger: silentLogger });
    expect(provisioned.data['provisioned']).toEqual(['B']);

    const asked = await runAsk({
      profile: 'B',
      userStore,
      poolView: new StubPoolView(poolBaseline),
      narrator: new TemplateNarrator(),
      corpus: corpusFixture,
      flags: { ...DEFAULT_FLAGS, narrator: 'template', demoMode: true },
      logger: silentLogger,
      now: FIXTURE_NOW,
    });
    expect(asked.exit ?? EXIT.ok).toBe(EXIT.ok);
    const card = asked.data['card'] as { poolCitation?: { k: number } };
    expect(card.poolCitation?.k).toBeGreaterThanOrEqual(5); // B's committed traits match the fixture pool
  });

  it('provision all writes both profiles; an unknown target is a usage error', async () => {
    const userStore = new StubUserStore();
    const all = await runProvision(undefined, { userStore, logger: silentLogger });
    expect(all.data['provisioned']).toEqual(['A', 'B']);
    expect(await userStore.usual('A')).not.toBeNull();
    expect(await userStore.usual('B')).not.toBeNull();

    const bad = await runProvision('C', { userStore, logger: silentLogger });
    expect(bad.exit).toBe(EXIT.usage);
  });
});

describe('X7 pass seed / reset', () => {
  it('seed surfaces the loader report; failures downgrade the exit code', async () => {
    const ok = await runSeed({
      relay: new StubRelay(),
      loadSeeds: () =>
        Promise.resolve({
          total: 220,
          relaySeeded: 220,
          poolLoaded: 220,
          failed: [],
          rerunDetected: false,
          warmAt: '2026-07-25T10:08:00.000Z',
        }),
    });
    expect(ok.exit ?? EXIT.ok).toBe(EXIT.ok);
    expect(ok.lines.join('\n')).toMatch(/220\/220 pooled/);
    expect(ok.lines.join('\n')).toMatch(/warm no earlier than/);

    const partial = await runSeed({
      relay: new StubRelay(),
      loadSeeds: () =>
        Promise.resolve({
          total: 220,
          relaySeeded: 220,
          poolLoaded: 218,
          failed: ['id-1', 'id-2'],
          rerunDetected: true,
          warmAt: '2026-07-25T10:08:00.000Z',
        }),
    });
    expect(partial.exit).toBe(EXIT.expectedFailure);
    expect(partial.lines.join('\n')).toMatch(/sweeper recovers.*id-1, id-2/);
    expect(partial.lines.join('\n')).toMatch(/Re-run detected/);
  });

  it('reset deletes every read and says so, with the count', async () => {
    const relay = new StubRelay();
    await relay.put(sampleRead);
    const result = await runReset({ relay, confirm: () => Promise.resolve(true) });
    expect((await relay.stats()).count).toBe(0);
    const printed = result.lines.join('\n');
    expect(printed).toMatch(/1 read\(s\) DELETED/);
    expect(printed).toMatch(/durable store/);
    expect(result.data).toMatchObject({ relay: 'cleared', deleted: 1 });
  });

  it('reset does NOT claim the pool survives — that copy was true and is now inverted', async () => {
    // The regression this locks. While the relay was a settle-window buffer,
    // reset discarded a few minutes of in-flight writes and printed "Pool records
    // remain … the census stays honest via read_id dedup". Under D-7 the relay IS
    // the pool, so that sentence reassures an operator about the one command that
    // empties it.
    const relay = new StubRelay();
    await relay.put(sampleRead);
    const printed = (
      await runReset({ relay, confirm: () => Promise.resolve(true) })
    ).lines.join('\n');
    expect(printed).not.toMatch(/Pool records remain/);
    expect(printed).not.toMatch(/stays honest/);
  });

  it('reset asks before deleting, and declining deletes nothing', async () => {
    const relay = new StubRelay();
    await relay.put(sampleRead);
    let asked = 0;
    const result = await runReset({
      relay,
      confirm: () => {
        asked += 1;
        return Promise.resolve(false);
      },
    });
    expect(asked).toBe(1);
    expect((await relay.stats()).count).toBe(1); // still there
    expect(result.exit).toBe(EXIT.expectedFailure);
    expect(result.data).toMatchObject({ relay: 'untouched', deleted: 0 });
  });

  it('--yes skips the prompt for scripted use', async () => {
    const relay = new StubRelay();
    await relay.put(sampleRead);
    let asked = 0;
    const result = await runReset({
      relay,
      yes: true,
      confirm: () => {
        asked += 1;
        return Promise.resolve(false); // would refuse, and is never consulted
      },
    });
    expect(asked).toBe(0);
    expect((await relay.stats()).count).toBe(0);
    expect(result.data).toMatchObject({ deleted: 1 });
  });
});

describe('X7 pass flags', () => {
  it('--set narrator=template is visible to a subsequent ask (template copy used)', async () => {
    const lines: string[] = [];
    const flags = createFlagStore(DEFAULT_FLAGS, createLogger((l) => lines.push(l)));
    const result = runFlags('narrator=template', flags);
    expect(result.lines[0]).toBe('narrator: live → template');
    expect(flags.get().narrator).toBe('template');
    expect(lines).toEqual(['flag narrator live→template reason=operator']);

    // the subsequent ask consumes the flipped flags snapshot
    const userStore = new StubUserStore();
    await runProvision('B', { userStore, logger: silentLogger });
    const asked = await runAsk({
      profile: 'B',
      userStore,
      poolView: new StubPoolView(poolBaseline),
      narrator: new TemplateNarrator(), // what the live narrator delegates to under this flag
      corpus: corpusFixture,
      flags: flags.get(),
      logger: silentLogger,
      now: FIXTURE_NOW,
    });
    expect(asked.exit ?? EXIT.ok).toBe(EXIT.ok);
  });

  it('shows current flags without --set; rejects unknown keys, bad values, malformed input', () => {
    const flags = createFlagStore(DEFAULT_FLAGS, silentLogger);
    expect(runFlags(undefined, flags).lines).toContain('narrator = live');
    expect(runFlags('vibe=chill', flags).exit).toBe(EXIT.usage);
    expect(runFlags('narrator=shouty', flags).exit).toBe(EXIT.usage);
    expect(runFlags('narrator', flags).exit).toBe(EXIT.usage);
    expect(runFlags('demoMode=true', flags).lines[0]).toBe('demoMode: false → true');
  });

  it('setting a flag to its current value reports no change', () => {
    const flags = createFlagStore(DEFAULT_FLAGS, silentLogger);
    expect(runFlags('pool=live', flags).lines[0]).toMatch(/already live — no change/);
  });
});

describe('X7 pass nudge', () => {
  it('arming twice in the same day never yields two fires', () => {
    const nudge = createNudge();
    nudge.setOptIn(true);
    expect(runNudgeArm(nudge, true).lines[0]).toMatch(/Nudge armed\./);
    expect(nudge.maybeFire(FIXTURE_NOW)).toBe(true); // first fire
    runNudgeArm(nudge, true); // second arm, same day
    expect(nudge.maybeFire(FIXTURE_NOW)).toBe(false); // once per local day, no double-fire
  });

  it('arming without opt-in warns; missing --arm is a usage error', () => {
    const nudge = createNudge();
    expect(runNudgeArm(nudge, true).lines[0]).toMatch(/Opt-in is off/);
    expect(runNudgeArm(nudge, false).exit).toBe(EXIT.usage);
  });
});

describe('N2: nudge state survives the process', () => {
  const config: AppConfig = {
    xtraceBaseUrl: 'http://localhost:1',
    xtraceApiKey: 'k',
    relayUrl: 'http://localhost:2',
    relayToken: 't',
    anthropicApiKey: null,
    settleWindowSeconds: 480,
    proseBufferPath: '/tmp/confit-n2-test-buffer',
  };

  function ctx(graph: AdapterGraph, args: string[], sink?: string[]): CommandContext {
    const logger = createLogger((line) => sink?.push(line));
    return {
      argv: parseArgv(args),
      config,
      flags: createFlagStore({ ...DEFAULT_FLAGS }, logger),
      logger,
      graph,
    };
  }

  it('state loads from the store, not from a fresh default — opt-in survives', async () => {
    const graph = fixtureGraph({ logger: silentLogger });
    await graph.settings.put(NUDGE_SETTINGS_PROFILE, NUDGE_SETTINGS_KEY, {
      optedIn: true,
      silenced: false,
      armed: false,
      lastFiredDay: null,
    });
    // A fresh default would warn "Opt-in is off" — this invocation must not,
    // because the store says this device opted in. That is the load, proven.
    const result = await nudgeHandler(ctx(graph, ['pass', 'nudge', '--arm']));
    expect(result.lines[0]).toBe('Nudge armed.');
    expect(result.lines[0]).not.toMatch(/Opt-in is off/);
  });

  it('an arm in one invocation is stored for the next (SL-23 closed)', async () => {
    const graph = fixtureGraph({ logger: silentLogger });
    await nudgeHandler(ctx(graph, ['pass', 'nudge', '--arm']));
    const stored = await graph.settings.get(NUDGE_SETTINGS_PROFILE, NUDGE_SETTINGS_KEY);
    expect(parseNudgeState(stored)).toMatchObject({ armed: true });
    // And a second invocation — a brand-new in-memory Nudge — sees it.
    const again = await nudgeHandler(ctx(graph, ['pass', 'nudge', '--arm']));
    expect((again.data['state'] as { armed: boolean }).armed).toBe(true);
  });

  it('malformed stored state starts fresh, and says so in the log', async () => {
    const graph = fixtureGraph({ logger: silentLogger });
    await graph.settings.put(NUDGE_SETTINGS_PROFILE, NUDGE_SETTINGS_KEY, { armed: 'yes' });
    const log: string[] = [];
    const result = await nudgeHandler(ctx(graph, ['pass', 'nudge', '--arm'], log));
    expect(result.lines[0]).toMatch(/Opt-in is off/); // fresh default, not a half-parse
    expect(log.some((line) => line.includes('malformed'))).toBe(true);
    // And the store now holds a VALID state again — the command self-heals it.
    const healed = await graph.settings.get(NUDGE_SETTINGS_PROFILE, NUDGE_SETTINGS_KEY);
    expect(parseNudgeState(healed)).not.toBeNull();
  });

  it('a usage error mutates nothing and writes nothing', async () => {
    const graph = fixtureGraph({ logger: silentLogger });
    const before = { optedIn: true, silenced: true, armed: false, lastFiredDay: null };
    await graph.settings.put(NUDGE_SETTINGS_PROFILE, NUDGE_SETTINGS_KEY, before);
    const result = await nudgeHandler(ctx(graph, ['pass', 'nudge']));
    expect(result.exit).not.toBeUndefined();
    expect(await graph.settings.get(NUDGE_SETTINGS_PROFILE, NUDGE_SETTINGS_KEY)).toEqual(before);
  });
});

describe('N2: parseNudgeState is strict at the boundary', () => {
  it('accepts exactly the persisted shape', () => {
    const state = { optedIn: true, silenced: false, armed: true, lastFiredDay: '2026-07-25' };
    expect(parseNudgeState(state)).toEqual(state);
    expect(parseNudgeState({ ...state, lastFiredDay: null })).toMatchObject({ lastFiredDay: null });
  });

  it('rejects every half-shape rather than guessing', () => {
    expect(parseNudgeState(null)).toBeNull();
    expect(parseNudgeState('armed')).toBeNull();
    expect(parseNudgeState([])).toBeNull();
    expect(parseNudgeState({ optedIn: true, silenced: false, armed: true })).toBeNull(); // no lastFiredDay
    expect(parseNudgeState({ optedIn: 1, silenced: false, armed: true, lastFiredDay: null })).toBeNull();
    expect(parseNudgeState({ optedIn: true, silenced: false, armed: true, lastFiredDay: 5 })).toBeNull();
  });
});
