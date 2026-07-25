import { describe, expect, it } from 'vitest';

import { DEFAULT_FLAGS } from '../contracts/flags.js';
import {
  FIXTURE_NOW,
  corpusFixture,
  poolBaseline,
  sampleMealLog,
  sampleUsual,
} from '../contracts/fixtures/index.js';
import type { UsualProfile } from '../contracts/types.js';
import { StubPoolView, StubUserStore } from '../contracts/stubs/index.js';
import { TemplateNarrator } from '../llm/template.js';
import { createLogger } from '../config/logger.js';
import { EXIT } from './render.js';
import { runAsk, type AskDeps } from './ask.js';

/**
 * X3's acceptance runs against the P0.2 FIXTURE pool, not the S2 seed — the
 * near-tie assertions belong to G4. Fixture structure: spice_tolerance_low k=5
 * (citable), solo_comfort k=6 (citable), budget_ceiling k=4 (miss material).
 */
async function askWith(overrides?: {
  usual?: UsualProfile;
  degraded?: boolean;
  log?: typeof sampleMealLog;
}) {
  const logLines: string[] = [];
  const userStore = new StubUserStore();
  await userStore.setUsual('B', overrides?.usual ?? sampleUsual);
  await userStore.setMealLog('B', overrides?.log ?? sampleMealLog);
  const deps: AskDeps = {
    profile: 'B',
    userStore,
    poolView: new StubPoolView(poolBaseline, overrides?.degraded ?? false),
    narrator: new TemplateNarrator(),
    corpus: corpusFixture,
    flags: { ...DEFAULT_FLAGS, narrator: 'template', demoMode: true },
    logger: createLogger((line) => logLines.push(line)),
    now: FIXTURE_NOW,
    inducedClaim: () => Promise.resolve('Hygiene complaints under-predict loyalty here.'),
  };
  return { result: await runAsk(deps), logLines };
}

describe('X3 confit ask', () => {
  it('a fixture cohort at k>=5 produces a citation, never below the floor', async () => {
    const { result } = await askWith();
    const card = result.data['card'] as { poolCitation?: { driver: string; k: number } };
    expect(result.exit ?? EXIT.ok).toBe(EXIT.ok);
    expect(card.poolCitation).toBeDefined();
    expect(card.poolCitation?.k).toBeGreaterThanOrEqual(5);
    expect(card.poolCitation?.driver).toBe('solo_comfort'); // k=6 beats k=5, deterministic
    // The rendered chip carries the DRIVER_PHRASES wording and the count. This assertion
    // used to require `solo comfort × 6` — the enum token with its underscore swapped for
    // a space — which meant a test was actively LOCKING IN defect SL-30 rather than
    // missing it. K5's banned lexicon applies to what reaches a card, and a test that
    // demands the banned form is worse than no test.
    expect(result.lines.some((l) => l.includes('a seat for one by choice'))).toBe(true);
    expect(result.lines.some((l) => l.includes('6 of them'))).toBe(true);
    for (const line of result.lines) expect(line).not.toMatch(/solo comfort|solo_comfort/);
  });

  it('a driver matching only a k=4 cohort produces the cohort-miss line, exit 0', async () => {
    // This usual matches ONLY budget_ceiling (k=4 in the fixture pool).
    const { result } = await askWith({
      usual: { ...sampleUsual, spiceTolerance: 3, soloComfort: false, budgetBand: 2 },
    });
    expect(result.exit ?? EXIT.ok).toBe(EXIT.ok); // a miss is a normal card
    const card = result.data['card'] as {
      poolCitation?: unknown;
      cohortMiss?: { driver: string };
    };
    expect(card.poolCitation).toBeUndefined();
    expect(card.cohortMiss).toEqual({ driver: 'budget_ceiling' });
    expect(result.lines.some((l) => l.includes('first person to tell us this'))).toBe(true);
  });

  it('--json data includes the full score map over every candidate', async () => {
    const { result } = await askWith();
    const card = result.data['card'] as { scores: Record<string, number> };
    // sampleUsual has no gi constraint and budget 2 → band-3 ember_and_ash survives (stretch)
    expect(Object.keys(card.scores).length).toBeGreaterThanOrEqual(5);
    for (const score of Object.values(card.scores)) {
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    }
  });

  it('degraded: true from the PoolView is disclosed in output and payload', async () => {
    const { result } = await askWith({ degraded: true });
    const card = result.data['card'] as { degradedPool?: boolean };
    expect(card.degradedPool).toBe(true);
    expect(result.lines.some((l) => l.includes('pool degraded'))).toBe(true);
  });

  it('the rotation suppression from the fixture log reaches the card', async () => {
    const { result } = await askWith();
    const card = result.data['card'] as { rotationLine?: string };
    expect(card.rotationLine).toMatch(/shoyu ramen/); // eaten twice in the fixture week
  });

  it('never prints a confession and never prints a sub-floor count', async () => {
    const { result } = await askWith();
    const text = result.lines.join('\n');
    expect(text).not.toMatch(/never post|breakup|stomach/i); // canned confession fragments
    expect(text).not.toMatch(/× [1-4]\b/); // no citation chip below the floor
  });

  it('an unprovisioned profile exits 3 with instructions, not a crash', async () => {
    const logLines: string[] = [];
    const deps: AskDeps = {
      profile: 'ghost',
      userStore: new StubUserStore(),
      poolView: new StubPoolView(poolBaseline),
      narrator: new TemplateNarrator(),
      corpus: corpusFixture,
      flags: { ...DEFAULT_FLAGS, demoMode: true },
      logger: createLogger((line) => logLines.push(line)),
      now: FIXTURE_NOW,
    };
    const result = await runAsk(deps);
    expect(result.exit).toBe(EXIT.environment);
    expect(result.lines[0]).toMatch(/provision/);
  });

  it('a failing induction degrades to a card without the claim, logged', async () => {
    const logLines: string[] = [];
    const userStore = new StubUserStore();
    await userStore.setUsual('B', sampleUsual);
    await userStore.setMealLog('B', sampleMealLog);
    const result = await runAsk({
      profile: 'B',
      userStore,
      poolView: new StubPoolView(poolBaseline),
      narrator: new TemplateNarrator(),
      corpus: corpusFixture,
      flags: { ...DEFAULT_FLAGS, demoMode: true },
      logger: createLogger((line) => logLines.push(line)),
      now: FIXTURE_NOW,
      inducedClaim: () => Promise.reject(new Error('induction 503')),
    });
    expect(result.exit ?? EXIT.ok).toBe(EXIT.ok);
    expect(logLines.some((l) => l.includes('induction unavailable'))).toBe(true);
  });
});
