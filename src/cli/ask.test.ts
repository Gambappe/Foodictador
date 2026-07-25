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
  inducedClaim?: () => Promise<string>;
  personalClaim?: () => Promise<string>;
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
    inducedClaim:
      overrides?.inducedClaim ??
      (() => Promise.resolve('Hygiene complaints under-predict loyalty here.')),
    personalClaim: overrides?.personalClaim ?? (() => Promise.resolve('')),
  };
  return { result: await runAsk(deps), logLines, lines: logLines };
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
    // Names WHICH synthesis failed. There are two now (D-8: the pool's and the user's own),
    // and "induction unavailable" would leave an operator guessing which substrate scope.
    expect(logLines.some((l) => l.includes('pool synthesis unavailable'))).toBe(true);
  });
});

describe('X3 ask — the induced claim is the one card line Confit did not write (L4)', () => {
  it('drops a claim carrying a raw identifier, and keeps the rest of the card', async () => {
    // Seen live on the first real card after M11 made `ask` reachable: the claim read
    // 'The key context was that the driver was "spice_tolerance_low"', and `template.ts`
    // interpolates it into a LINTED template — so the sentence around it was checked and
    // the sentence itself never was. K5's banned lexicon, in front of a user.
    const { result } = await askWith({
      inducedClaim: () =>
        Promise.resolve('The key context was that the driver was "spice_tolerance_low".'),
    });
    for (const line of result.lines) expect(line, line).not.toMatch(/[a-z]+_[a-z]+/);
    // Dropped, not scrubbed — and the card still stands, because it is built to.
    const card = result.data['card'] as { reasonLine: string; poolCitation?: unknown };
    expect(card.reasonLine.length).toBeGreaterThan(0);
    expect(card.poolCitation).toBeDefined();
  });

  it('drops a claim carrying K5 banned lexicon', async () => {
    const { result, lines } = await askWith({
      inducedClaim: () => Promise.resolve('People here are on a 3-day streak of good choices.'),
    });
    expect(result.lines.join('\n')).not.toContain('3-day streak');
    expect(lines.some((l) => l.includes('pool claim dropped'))).toBe(true);
  });

  it('keeps a clean claim — the guard is not simply refusing everything', async () => {
    const claim =
      'People who eat here most weeks tend to regret the order and blame the kitchen.';
    const { result } = await askWith({ inducedClaim: () => Promise.resolve(claim) });
    expect(result.lines.join('\n')).toContain('regret the order');
  });
});

describe('X3 ask — D-8\'s second input: the user\'s own synthesis (M16)', () => {
  const MINE = 'you keep going back to the places you complain about most.';

  it('renders the personal claim as its OWN line, attributed', () => {
    // Not folded into the reason line like the pool claim. The reason line explains the
    // PICK; this says something about the reader, and merging them would make a claim about
    // a person read as a justification for a restaurant.
    return askWith({ personalClaim: () => Promise.resolve(MINE) }).then(({ result }) => {
      const card = result.data['card'] as { personalLine?: string; reasonLine: string };
      expect(card.personalLine).toBe(`From what you have told us: ${MINE}`);
      expect(card.reasonLine).not.toContain(MINE);
      expect(result.lines.join('\n')).toContain(MINE);
    });
  });

  it('is attributed, not asserted', async () => {
    // Two layers of paraphrase (extraction, then synthesis) and the verbatim confession is
    // not retrievable to quote — the owner ruled claims need not be quotable yet. So the
    // copy frames it as reported rather than stating it about the reader as fact.
    const { result } = await askWith({ personalClaim: () => Promise.resolve(MINE) });
    const card = result.data['card'] as { personalLine?: string };
    expect(card.personalLine).toMatch(/^From what you have told us:/);
  });

  it('an empty claim produces no line — there is no floor, so thin is expected', async () => {
    // The owner ruled no minimum confession count: "let's see what happens". A user with one
    // confession gets whatever one supports, including nothing, and nothing must render as
    // absence rather than as an empty line or the word "undefined".
    const { result } = await askWith({ personalClaim: () => Promise.resolve('') });
    const card = result.data['card'] as { personalLine?: string };
    expect(card.personalLine).toBeUndefined();
    expect(result.lines.join('\n')).not.toContain('From what you have told us');
    expect(result.lines.join('\n')).not.toContain('undefined');
  });

  it('goes through the SAME lint gate as the pool claim', async () => {
    // One implementation for both, because they are the same risk: substrate text bound for
    // a card. And this is the one where a leaked identifier would be describing the reader.
    const { result, lines } = await askWith({
      personalClaim: () => Promise.resolve('your driver is spice_tolerance_low, apparently.'),
    });
    const card = result.data['card'] as { personalLine?: string };
    expect(card.personalLine).toBeUndefined();
    expect(lines.some((l) => l.includes('personal claim dropped'))).toBe(true);
    for (const line of result.lines) expect(line, line).not.toMatch(/[a-z]+_[a-z]+/);
  });

  it('a failing personal synthesis does not take the card down', async () => {
    const { result, lines } = await askWith({
      personalClaim: () => Promise.reject(new Error('scope unreachable')),
    });
    expect(result.exit ?? EXIT.ok).toBe(EXIT.ok);
    expect((result.data['card'] as { reasonLine: string }).reasonLine.length).toBeGreaterThan(0);
    expect(lines.some((l) => l.includes('personal synthesis unavailable'))).toBe(true);
  });

  it('the two claims are independent — one failing leaves the other', async () => {
    const { result } = await askWith({
      inducedClaim: () => Promise.reject(new Error('pool unreachable')),
      personalClaim: () => Promise.resolve(MINE),
    });
    const card = result.data['card'] as { personalLine?: string };
    expect(card.personalLine).toContain(MINE);
  });

  it('the personal line follows the Usual, so declared reads before inferred', async () => {
    const { result } = await askWith({ personalClaim: () => Promise.resolve(MINE) });
    const joined = result.lines;
    const usualAt = joined.findIndex((l) => l.includes('Fine to eat alone'));
    const personalAt = joined.findIndex((l) => l.includes('From what you have told us'));
    expect(usualAt).toBeGreaterThanOrEqual(0);
    expect(personalAt).toBeGreaterThan(usualAt);
  });
});
