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
import { runFlags, runNudgeArm, runProvision, runReset, runSeed } from './pass-ops.js';

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

  it('reset empties the relay and says what it did NOT clear', async () => {
    const relay = new StubRelay();
    await relay.put(sampleRead);
    expect((await relay.stats()).count).toBe(1);
    const result = await runReset({ relay });
    expect((await relay.stats()).count).toBe(0);
    expect(result.lines.join('\n')).toMatch(/Relay cleared/);
    expect(result.lines.join('\n')).toMatch(/Pool records remain/);
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
