import { describe, expect, it } from 'vitest';
import { DEMO_CONTEXT } from '../contracts/types.js';
import type {
  AskContext,
  CardCopy,
  MealLogEntry,
  Place,
  Read,
  UsualProfile,
} from '../contracts/types.js';
import type { Flags } from '../contracts/flags.js';
import { KFLOOR } from './cohorts.js';
import { RUNNERS_UP_COUNT, assembleCard, planAsk, type RankedAskPlan } from './askEngine.js';

const NOW = '2026-07-25T19:00:00.000Z';

function place(overrides: Partial<Place> & { id: string }): Place {
  return {
    name: overrides.id,
    cuisine: 'mexican',
    priceBand: 2,
    tags: ['small_plates', 'solo_friendly'],
    signatureDishes: [{ dishId: `${overrides.id}_dish`, name: 'dish', spiceLevel: 0 }],
    ...overrides,
  };
}

function read(overrides: Partial<Read> & { read_id: string }): Read {
  return {
    place: 'alpha',
    signal: 'secret_default',
    driver: 'spice_tolerance_low',
    cadence: 'weekly',
    weight: 0.8,
    ...overrides,
  };
}

const usual: UsualProfile = {
  spiceTolerance: 1,
  budgetBand: 2,
  portionPref: 'small',
  soloComfort: true,
  giConstraint: false,
  offLimits: [],
};

const flags: Flags = {
  extraction: 'live',
  narrator: 'live',
  pool: 'live',
  demoMode: false,
};

const context: AskContext = { hour: 19, solo: true, weather: 'rain' };

const corpus = [place({ id: 'alpha' }), place({ id: 'bravo' }), place({ id: 'charlie' })];

function baseInput(): Parameters<typeof planAsk>[0] {
  return { reads: [], usual, log: [], corpus, flags, now: NOW, context };
}

/** n distinct reads at one place on a driver relevant to `usual`. */
function cohort(n: number, placeId = 'alpha', signal: Read['signal'] = 'secret_default'): Read[] {
  return Array.from({ length: n }, (_, i) =>
    read({ read_id: `${placeId}-${String(i)}`, place: placeId, signal }),
  );
}

/** Narrow to the ranked variant, failing the test rather than casting if it is not. */
function ranked(result: ReturnType<typeof planAsk>): RankedAskPlan {
  if (result.kind !== 'ranked') throw new Error(`expected a ranked plan, got ${result.kind}`);
  return result;
}

describe('no_candidates', () => {
  it('is a variant of the result, not an exception', () => {
    // A gi-constrained diner in a corpus with no safe options.
    const result = planAsk({ ...baseInput(), usual: { ...usual, giConstraint: true } });
    expect(result.kind).toBe('no_candidates');
    expect(result.scores).toEqual({});
  });

  it('still reports why every place was excluded', () => {
    const result = planAsk({ ...baseInput(), usual: { ...usual, giConstraint: true } });
    expect(result.exclusions.map((e) => e.placeId).sort()).toEqual(['alpha', 'bravo', 'charlie']);
    expect(new Set(result.exclusions.map((e) => e.reason))).toEqual(new Set(['gi_unsafe']));
  });
});

describe('the D-11 budget lift, seen from the plan', () => {
  // Exclusion report and ranking are computed by two call sites; this pins that they
  // agree about who was lifted — the property the D-11 comment in planAsk claims.
  const pricey = place({ id: 'pricey', priceBand: 4 });

  it('with no evidence, the over-budget place is excluded and unscored', () => {
    const result = planAsk({ ...baseInput(), corpus: [...corpus, pricey] });
    expect(result.exclusions).toEqual([{ placeId: 'pricey', reason: 'over_budget' }]);
    expect(Object.keys(result.scores)).not.toContain('pricey');
  });

  it('with a citable cohort at the place, it leaves the exclusion list AND enters the scores', () => {
    const result = planAsk({
      ...baseInput(),
      corpus: [...corpus, pricey],
      reads: cohort(KFLOOR, 'pricey'),
    });
    expect(result.exclusions).toEqual([]);
    expect(Object.keys(result.scores)).toContain('pricey');
  });
});

describe('context handling', () => {
  it('pins DEMO_CONTEXT under demoMode, ignoring any context passed', () => {
    const midnight: AskContext = { hour: 2, solo: false, weather: 'clear' };
    const pinned = planAsk({
      ...baseInput(),
      flags: { ...flags, demoMode: true },
      context: midnight,
    });
    const explicit = planAsk({ ...baseInput(), context: DEMO_CONTEXT });
    expect(ranked(pinned).scores).toEqual(ranked(explicit).scores);
  });

  it('refuses to guess a context outside demoMode', () => {
    // Silently falling back to the demo's rainy 19:00 would make a real recommendation
    // quietly wrong, which is worse than failing loudly.
    const noContext: Parameters<typeof planAsk>[0] = {
      reads: [],
      usual,
      log: [],
      corpus,
      flags,
      now: NOW,
    };
    expect(() => planAsk(noContext)).toThrow(/context is required/);
  });
});

describe('the pick and its runners-up', () => {
  it('picks the top-scoring place and keeps exactly RUNNERS_UP_COUNT behind it', () => {
    const result = ranked(planAsk(baseInput()));
    expect(result.pick.id).toBe(result.ranked[0]?.place.id);
    expect(result.runnersUp).toHaveLength(RUNNERS_UP_COUNT);
    expect(result.runnersUp.map((r) => r.place.id)).toEqual(
      result.ranked.slice(1, 1 + RUNNERS_UP_COUNT).map((r) => r.place.id),
    );
  });

  it('does not invent runners-up that do not exist', () => {
    const result = ranked(planAsk({ ...baseInput(), corpus: [place({ id: 'only' })] }));
    expect(result.runnersUp).toEqual([]);
  });

  it('treats an empty corpus as no candidates rather than throwing', () => {
    // Reachable if S1's corpus fails to load; X3 must get a result it can render.
    expect(planAsk({ ...baseInput(), corpus: [] }).kind).toBe('no_candidates');
  });

  it('scores every candidate, keyed by place id', () => {
    const result = ranked(planAsk(baseInput()));
    expect(Object.keys(result.scores).sort()).toEqual(['alpha', 'bravo', 'charlie']);
  });

  it('is reproducible for identical input', () => {
    expect(planAsk(baseInput())).toEqual(planAsk(baseInput()));
  });

  it('does not mutate its input — the kernel purity guarantee', () => {
    const input = { ...baseInput(), reads: cohort(KFLOOR), log: [] };
    const snapshot = structuredClone(input);
    planAsk(input);
    expect(input).toEqual(snapshot);
  });
});

describe('citation and cohort miss', () => {
  it('cites nothing when there are no reads', () => {
    const { facts } = ranked(planAsk(baseInput()));
    expect(facts.citation).toBeUndefined();
    expect(facts.cohortMiss).toBeUndefined();
  });

  it('cites a cohort at the floor', () => {
    const { facts } = ranked(planAsk({ ...baseInput(), reads: cohort(KFLOOR) }));
    expect(facts.citation).toEqual({ driver: 'spice_tolerance_low', k: KFLOOR });
    expect(facts.cohortMiss).toBeUndefined();
  });

  it('reports a miss instead of a citation below the floor', () => {
    const { facts } = ranked(planAsk({ ...baseInput(), reads: cohort(KFLOOR - 1) }));
    expect(facts.citation).toBeUndefined();
    expect(facts.cohortMiss).toEqual({ driver: 'spice_tolerance_low' });
  });

  it('never emits a citation and a miss together', () => {
    for (const size of [0, 1, 4, 5, 9]) {
      const { facts } = ranked(planAsk({ ...baseInput(), reads: cohort(size) }));
      expect(facts.citation !== undefined && facts.cohortMiss !== undefined).toBe(false);
    }
  });

  it('cites the largest citable cohort when several qualify', () => {
    const reads = [
      ...cohort(5, 'alpha'),
      ...cohort(7, 'bravo').map((r) => ({ ...r, driver: 'portion_small' as const })),
    ];
    expect(ranked(planAsk({ ...baseInput(), reads })).facts.citation).toEqual({
      driver: 'portion_small',
      k: 7,
    });
  });

  it('cites nothing for a driver no Usual can evidence, however large', () => {
    // DAG §4 D-5: six drivers have no UsualProfile field, so they are inert. Asserted
    // here so the gap stays visible at the engine boundary too.
    const reads = cohort(20).map((r) => ({ ...r, driver: 'companion_constraint' as const }));
    const { facts } = ranked(planAsk({ ...baseInput(), reads }));
    expect(facts.citation).toBeUndefined();
    expect(facts.cohortMiss).toBeUndefined();
  });
});

describe('facts handed to the narrator', () => {
  it('carries no confession prose — only keys, counts and place data', () => {
    const { facts } = ranked(planAsk({ ...baseInput(), reads: cohort(KFLOOR) }));
    const serialised = JSON.stringify(facts);
    expect(serialised).not.toMatch(/confess|prose|sentence/i);
    // usualNotes and suppressions are keys, matching Suppression.reasonKey's convention.
    for (const note of facts.usualNotes) expect(note).toMatch(/^[a-z0-9_]+$/);
    for (const entry of facts.suppressions) expect(entry.reasonKey).toMatch(/^[a-z0-9_]+$/);
  });

  it('derives usual notes from the profile', () => {
    const { facts } = ranked(planAsk(baseInput()));
    expect(facts.usualNotes).toEqual([
      'spice_tolerance_low',
      'budget_band_2',
      'portion_small',
      'solo_comfortable',
    ]);
  });

  it('emits no notes for a profile with nothing notable', () => {
    const plain: UsualProfile = {
      spiceTolerance: 3,
      budgetBand: 4,
      portionPref: 'standard',
      soloComfort: false,
      giConstraint: false,
      offLimits: [],
    };
    expect(ranked(planAsk({ ...baseInput(), usual: plain })).facts.usualNotes).toEqual([]);
  });

  it('reports a suppression even when it belongs to a place that was not picked', () => {
    // The rotation line explains what the diner did NOT get (design v0.8 §5: "Not ramen —
    // twice this week already"), so filtering suppressions to the pick would delete the
    // fact the line is made of.
    const log: MealLogEntry[] = [
      { dishId: 'charlie_dish', placeId: 'charlie', at: '2026-07-24T19:00:00.000Z' },
      { dishId: 'charlie_dish', placeId: 'charlie', at: '2026-07-22T19:00:00.000Z' },
    ];
    const result = ranked(planAsk({ ...baseInput(), log }));
    expect(result.pick.id).not.toBe('charlie');
    expect(result.facts.suppressions.map((s) => s.dishId)).toContain('charlie_dish');
  });

  it('reports no suppressions when nothing is suppressed', () => {
    expect(ranked(planAsk(baseInput())).facts.suppressions).toEqual([]);
  });

  it('takes degradedPool from the input when given', () => {
    expect(ranked(planAsk({ ...baseInput(), degradedPool: true })).facts.degradedPool).toBe(true);
  });

  it('falls back to the pool flag when degradedPool is not reported', () => {
    const relayOnly = { ...baseInput(), flags: { ...flags, pool: 'relay-only' as const } };
    expect(ranked(planAsk(relayOnly)).facts.degradedPool).toBe(true);
    expect(ranked(planAsk(baseInput())).facts.degradedPool).toBe(false);
  });

  it('treats an empty induced claim as no claim at all', () => {
    // M2's poolClaim() returns '' for "nothing found". Testing !== undefined let it
    // through, and the narrator then selected the induced reason template — producing a
    // headline sentence starting with a space and referring to a vanished antecedent.
    for (const empty of ['', '   ']) {
      expect(ranked(planAsk({ ...baseInput(), poolClaim: empty })).facts.poolClaim)
        .toBeUndefined();
    }
  });

  it('passes an induced claim through, since a pure engine cannot fetch one', () => {
    const claim = 'hygiene complaints under-predict loyalty here';
    expect(ranked(planAsk({ ...baseInput(), poolClaim: claim })).facts.poolClaim).toBe(claim);
  });
});

describe('assembleCard', () => {
  const copy: CardCopy = {
    reasonLine: 'Skipping three of the highest-rated places nearby.',
    rotationLine: 'Not ramen — twice this week already.',
    usualLine: 'Small plates, counter seating.',
  };

  it('joins the plan and the copy into a Card', () => {
    const askPlan = ranked(planAsk({ ...baseInput(), reads: cohort(KFLOOR) }));
    const card = assembleCard(askPlan, copy);

    expect(card.pick).toEqual(askPlan.pick);
    expect(card.reasonLine).toBe(copy.reasonLine);
    expect(card.rotationLine).toBe(copy.rotationLine);
    expect(card.usualLine).toBe(copy.usualLine);
    expect(card.poolCitation).toEqual({ driver: 'spice_tolerance_low', k: KFLOOR });
    expect(card.cohortMiss).toBeUndefined();
    expect(card.runnersUp).toEqual(askPlan.runnersUp);
    expect(card.scores).toEqual(askPlan.scores);
    expect(card.degradedPool).toBe(false);
  });

  it('carries pool degradation onto the card so it can be disclosed', () => {
    const askPlan = ranked(planAsk({ ...baseInput(), degradedPool: true }));
    expect(assembleCard(askPlan, copy).degradedPool).toBe(true);
  });

  it('carries a cohort miss through when there was no citation', () => {
    const askPlan = ranked(planAsk({ ...baseInput(), reads: cohort(KFLOOR - 1) }));
    const card = assembleCard(askPlan, copy);
    expect(card.poolCitation).toBeUndefined();
    expect(card.cohortMiss).toEqual({ driver: 'spice_tolerance_low' });
  });

  it('omits optional copy the narrator did not write, rather than emitting undefined', () => {
    const askPlan = ranked(planAsk(baseInput()));
    const card = assembleCard(askPlan, { reasonLine: 'Just this.' });
    expect('rotationLine' in card).toBe(false);
    expect('usualLine' in card).toBe(false);
  });

  it('never puts a sub-floor cohort on the card', () => {
    for (const size of [1, 2, 3, 4]) {
      const askPlan = ranked(planAsk({ ...baseInput(), reads: cohort(size) }));
      expect(assembleCard(askPlan, copy).poolCitation).toBeUndefined();
    }
  });
});
