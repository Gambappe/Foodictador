import { describe, expect, it } from 'vitest';
import {
  SIGNALS,
  type AskContext,
  type MealLogEntry,
  type Place,
  type Read,
  type UsualProfile,
} from '../contracts/types.js';
import { NEUTRAL_FIT, SCORE_WEIGHTS } from './constants.js';
import {
  SIGNAL_POLARITY,
  candidates,
  contextScore,
  exclusionsFor,
  poolScore,
  rotationScore,
  scorePlaces,
  usualScore,
} from './score.js';

const NOW = '2026-07-25T19:00:00.000Z';

function place(overrides: Partial<Place> & { id: string }): Place {
  return {
    name: overrides.id,
    cuisine: 'mexican',
    priceBand: 2,
    tags: [],
    signatureDishes: [{ dishId: `${overrides.id}_dish`, name: 'dish', spiceLevel: 0 }],
    ...overrides,
  };
}

function read(overrides: Partial<Read> & { read_id: string }): Read {
  return {
    place: 'rosas',
    signal: 'trusted_safe_place',
    driver: 'spice_tolerance_low',
    cadence: 'weekly',
    weight: 0.8,
    ...overrides,
  };
}

/** spice_tolerance_low, budget_ceiling and portion_small are all relevant to this Usual. */
const usual: UsualProfile = {
  spiceTolerance: 1,
  budgetBand: 2,
  portionPref: 'small',
  soloComfort: true,
  giConstraint: false,
  offLimits: [],
};

const context: AskContext = { hour: 19, solo: true, weather: 'rain' };

/**
 * usualScore for a place that fails every sub-fit except the tolerated price stretch:
 * (spice 0 + price 0.5 + portion 0 + solo 0) / 4. Stated as a literal rather than
 * recomputed, so the test does not restate the formula it is checking.
 */
const WORST_USUAL_FIT = 0.125;

/** Five distinct reads at one place clear KFLOOR for a driver relevant to `usual`. */
function citableCohort(placeId: string, signal: Read['signal'], weight = 0.8): Read[] {
  return [1, 2, 3, 4, 5].map((n) =>
    read({ read_id: `${placeId}-${String(n)}`, place: placeId, signal, weight }),
  );
}

describe('polarity table (§3.4)', () => {
  it('covers every signal exactly once', () => {
    expect(Object.keys(SIGNAL_POLARITY).sort()).toEqual([...SIGNALS].sort());
  });

  it('scores pretends_preference at 0 — it informs driver matching, not the place', () => {
    expect(SIGNAL_POLARITY.pretends_preference).toBe(0);
  });

  it('splits the remaining signals into the documented halves', () => {
    const positive = SIGNALS.filter((signal) => SIGNAL_POLARITY[signal] === 1);
    const negative = SIGNALS.filter((signal) => SIGNAL_POLARITY[signal] === -1);
    expect([...positive].sort()).toEqual([
      'returns_despite_incident',
      'secret_default',
      'trusted_safe_place',
    ]);
    expect([...negative].sort()).toEqual([
      'never_ordered_again',
      'regret_after_order',
      'wanted_something_else',
    ]);
  });
});

describe('hard constraints', () => {
  it('excludes a gi-unsafe place for a gi-constrained diner', () => {
    const unsafe = place({ id: 'unsafe' });
    const safe = place({ id: 'safe', tags: ['gi_safe_options'] });
    const constrained = { ...usual, giConstraint: true };

    expect(exclusionsFor(unsafe, constrained, [])).toEqual([
      { placeId: 'unsafe', reason: 'gi_unsafe' },
    ]);
    expect(exclusionsFor(safe, constrained, [])).toEqual([]);
    expect(candidates([unsafe, safe], constrained, []).map((p) => p.id)).toEqual(['safe']);
  });

  it('tolerates exactly one price band above budget and no more', () => {
    const bands = [1, 2, 3, 4] as const;
    const ids = candidates(
      bands.map((band) => place({ id: `band${String(band)}`, priceBand: band })),
      usual, // budgetBand 2, so 3 is tolerated and 4 is not
      [],
    ).map((p) => p.id);
    expect(ids).toEqual(['band1', 'band2', 'band3']);
  });

  it('reports every violation a place commits, not just the first', () => {
    const bad = place({ id: 'bad', priceBand: 4, tags: [] });
    expect(exclusionsFor(bad, { ...usual, giConstraint: true }, []).map((e) => e.reason)).toEqual([
      'gi_unsafe',
      'over_budget',
    ]);
  });

  it('never ranks an excluded place', () => {
    const ranked = scorePlaces({
      reads: [],
      usual: { ...usual, giConstraint: true },
      log: [],
      corpus: [place({ id: 'unsafe' }), place({ id: 'safe', tags: ['gi_safe_options'] })],
      context,
      now: NOW,
    });
    expect(ranked.map((r) => r.place.id)).toEqual(['safe']);
  });
});

describe('the D-11 budget lift — evidence can lift the ceiling, the exclusion is not removed', () => {
  // budgetBand 2 + tolerance 1, so band 4 is over the wall for `usual` in every test here.
  const pricey = place({ id: 'pricey', priceBand: 4 });

  it('a citable cohort that includes the place lifts over_budget', () => {
    const reads = citableCohort('pricey', 'trusted_safe_place');
    expect(exclusionsFor(pricey, usual, reads)).toEqual([]);
    expect(candidates([pricey], usual, reads).map((p) => p.id)).toEqual(['pricey']);
  });

  it('a lifted place is actually ranked, not merely unexcluded', () => {
    const ranked = scorePlaces({
      reads: citableCohort('pricey', 'trusted_safe_place'),
      usual,
      log: [],
      corpus: [pricey, place({ id: 'cheap', priceBand: 1 })],
      context,
      now: NOW,
    });
    expect(ranked.map((r) => r.place.id).sort()).toEqual(['cheap', 'pricey']);
  });

  it('one read short of KFLOOR lifts nothing', () => {
    const four = citableCohort('pricey', 'trusted_safe_place').slice(0, 4);
    expect(exclusionsFor(pricey, usual, four)).toEqual([
      { placeId: 'pricey', reason: 'over_budget' },
    ]);
  });

  it('five copies of one read lift nothing — the floor counts people, not rows ([E20])', () => {
    const copies = citableCohort('pricey', 'trusted_safe_place').map((r) => ({
      ...r,
      read_id: 'same-read',
    }));
    expect(exclusionsFor(pricey, usual, copies)).toEqual([
      { placeId: 'pricey', reason: 'over_budget' },
    ]);
  });

  it('a cohort on a driver this Usual does not evidence lifts nothing', () => {
    // gi_constraint is matchable in general but not evidenced by `usual` (giConstraint
    // false), so five strangers with a constraint this diner does not share move nothing.
    const reads = citableCohort('pricey', 'trusted_safe_place').map((r) => ({
      ...r,
      driver: 'gi_constraint' as const,
    }));
    expect(exclusionsFor(pricey, usual, reads)).toEqual([
      { placeId: 'pricey', reason: 'over_budget' },
    ]);
  });

  it('a citable cohort at some other place lifts nothing here', () => {
    const reads = citableCohort('elsewhere', 'trusted_safe_place');
    expect(exclusionsFor(pricey, usual, reads)).toEqual([
      { placeId: 'pricey', reason: 'over_budget' },
    ]);
  });

  it('negative evidence lifts the wall too — and the pool term then holds it against the place', () => {
    // The lift deliberately ignores polarity: it stops the wall hiding evidence, it does
    // not endorse the place. Five regrets make pricey a candidate whose pool term is
    // below neutral, so it ranks like a place five people regret.
    const regrets = citableCohort('pricey', 'regret_after_order');
    expect(exclusionsFor(pricey, usual, regrets)).toEqual([]);
    const ranked = scorePlaces({
      reads: regrets,
      usual,
      log: [],
      corpus: [pricey],
      context,
      now: NOW,
    });
    expect(ranked[0]?.parts.pool).toBeLessThan(0.5);
  });

  it('giConstraint stays hard no matter how citable the cohort', () => {
    const constrained = { ...usual, giConstraint: true };
    const reads = citableCohort('pricey', 'trusted_safe_place');
    // over_budget is lifted; gi_unsafe stands alone and still excludes.
    expect(exclusionsFor(pricey, constrained, reads)).toEqual([
      { placeId: 'pricey', reason: 'gi_unsafe' },
    ]);
    expect(candidates([pricey], constrained, reads)).toEqual([]);
  });
});

describe('pool term', () => {
  it('is exactly neutral with no reads — absence of evidence is not evidence against', () => {
    expect(poolScore(place({ id: 'rosas' }), [], usual)).toBeCloseTo(0.5, 12);
  });

  it('rises above neutral for positive signals and falls below for regret', () => {
    const good = poolScore(place({ id: 'rosas' }), citableCohort('rosas', 'secret_default'), usual);
    const bad = poolScore(
      place({ id: 'rosas' }),
      citableCohort('rosas', 'regret_after_order'),
      usual,
    );
    expect(good).toBeGreaterThan(0.5);
    expect(bad).toBeLessThan(0.5);
    // Symmetric: the logistic of +x and -x straddle 0.5 equally.
    expect(good + bad).toBeCloseTo(1, 12);
  });

  it('ignores pretends_preference, leaving the place neutral', () => {
    const reads = citableCohort('rosas', 'pretends_preference');
    expect(poolScore(place({ id: 'rosas' }), reads, usual)).toBeCloseTo(0.5, 12);
  });

  it('ignores reads at other places', () => {
    const elsewhere = citableCohort('other', 'secret_default');
    expect(poolScore(place({ id: 'rosas' }), elsewhere, usual)).toBeCloseTo(0.5, 12);
  });

  it('ignores a sub-floor cohort, so a thin pool cannot move a score', () => {
    const four = citableCohort('rosas', 'secret_default').slice(0, 4);
    expect(poolScore(place({ id: 'rosas' }), four, usual)).toBeCloseTo(0.5, 12);
  });

  it('ignores a cohort whose driver is irrelevant to this Usual', () => {
    const reads = citableCohort('rosas', 'secret_default').map((r) => ({
      ...r,
      driver: 'crowd_aversion' as const,
    }));
    expect(poolScore(place({ id: 'rosas' }), reads, usual)).toBeCloseTo(0.5, 12);
  });

  it('saturates the per-read cohort multiplier at POOL_K_SATURATION', () => {
    // The logistic is invertible, so the underlying pool sum can be recovered and the
    // multiplier checked directly. Small weights keep the sum away from the tails where
    // floating point would swallow the difference.
    const logit = (p: number): number => Math.log(p / (1 - p));
    const cohortOf = (size: number): Read[] =>
      Array.from({ length: size }, (_, n) =>
        read({
          read_id: `s${String(size)}-${String(n)}`,
          place: 'rosas',
          signal: 'secret_default',
          weight: 0.05,
        }),
      );
    const sumFor = (size: number): number =>
      logit(poolScore(place({ id: 'rosas' }), cohortOf(size), usual));

    // At k=8 the multiplier is exactly 1 and stays there, so the sum grows strictly
    // linearly in cohort size beyond that point: 40 reads is 5x the sum of 8.
    expect(sumFor(40) / sumFor(8)).toBeCloseTo(5, 6);

    // Below saturation the multiplier is k/8, so growth is super-linear: doubling from
    // 4 to 8 reads more than doubles the sum.
    expect(sumFor(8) / sumFor(4)).toBeGreaterThan(2);
  });
});

describe('usual term', () => {
  it('rewards a place whose dishes sit inside the spice tolerance', () => {
    const mild = place({
      id: 'mild',
      signatureDishes: [{ dishId: 'd1', name: 'd', spiceLevel: 0 }],
      tags: ['small_plates', 'solo_friendly'],
    });
    const fiery = place({
      id: 'fiery',
      signatureDishes: [{ dishId: 'd2', name: 'd', spiceLevel: 3 }],
      tags: ['small_plates', 'solo_friendly'],
    });
    expect(usualScore(mild, usual)).toBeGreaterThan(usualScore(fiery, usual));
  });

  it('stays within [0,1] at both extremes', () => {
    const best = place({
      id: 'best',
      priceBand: 1,
      tags: ['small_plates', 'solo_friendly'],
      signatureDishes: [{ dishId: 'd', name: 'd', spiceLevel: 0 }],
    });
    const worst = place({
      id: 'worst',
      priceBand: 3,
      tags: [],
      signatureDishes: [{ dishId: 'd', name: 'd', spiceLevel: 3 }],
    });
    expect(usualScore(best, usual)).toBe(1);
    expect(usualScore(worst, usual)).toBeCloseTo(WORST_USUAL_FIT, 12);
  });

  it('is neutral on preferences the diner does not hold', () => {
    // A large-portion, non-solo diner: those two sub-fits contribute NEUTRAL_FIT, so
    // tags cannot swing the term.
    const relaxed: UsualProfile = { ...usual, portionPref: 'large', soloComfort: false };
    const tagged = place({ id: 'a', tags: ['small_plates', 'solo_friendly'] });
    const bare = place({ id: 'b', tags: [] });
    expect(usualScore(tagged, relaxed)).toBe(usualScore(bare, relaxed));
  });
});


describe('rotation term', () => {
  const dish = { dishId: 'ramen', name: 'ramen', spiceLevel: 0 as const };
  const ramen = place({ id: 'ramen_place', signatureDishes: [dish] });

  it('is 1 for a never-eaten dish', () => {
    expect(rotationScore(ramen, [], NOW)).toBe(1);
  });

  it('drops to the suppressed score for a dish eaten twice this week', () => {
    const log: MealLogEntry[] = [
      { dishId: 'ramen', placeId: 'ramen_place', at: '2026-07-24T19:00:00.000Z' },
      { dishId: 'ramen', placeId: 'ramen_place', at: '2026-07-22T19:00:00.000Z' },
    ];
    expect(rotationScore(ramen, log, NOW)).toBeLessThan(1);
  });

  it('drops when any single signature dish is unrecommendable', () => {
    const two = place({
      id: 'two',
      signatureDishes: [dish, { dishId: 'other', name: 'other', spiceLevel: 0 }],
    });
    const log: MealLogEntry[] = [
      { dishId: 'ramen', placeId: 'two', at: '2026-07-25T18:00:00.000Z' },
    ];
    expect(rotationScore(two, log, NOW)).toBeLessThan(1);
  });
});

describe('context term', () => {
  it('is neutral when the context raises no cue', () => {
    const noon: AskContext = { hour: 12, solo: false, weather: 'clear' };
    expect(contextScore(place({ id: 'a', tags: [] }), noon)).toBe(NEUTRAL_FIT);
  });

  it('does not mark a place down for lacking a cue the context never raised', () => {
    const noon: AskContext = { hour: 12, solo: false, weather: 'clear' };
    const lateOnly = place({ id: 'late', tags: ['late_night'] });
    expect(contextScore(lateOnly, noon)).toBe(contextScore(place({ id: 'plain' }), noon));
  });

  it('scores the share of applicable cues met', () => {
    const lateSoloRain: AskContext = { hour: 23, solo: true, weather: 'rain' };
    const all = place({ id: 'all', tags: ['late_night', 'solo_friendly', 'quiet'] });
    const one = place({ id: 'one', tags: ['late_night'] });
    const none = place({ id: 'none', tags: [] });
    expect(contextScore(all, lateSoloRain)).toBe(1);
    expect(contextScore(one, lateSoloRain)).toBeCloseTo(1 / 3, 12);
    expect(contextScore(none, lateSoloRain)).toBe(0);
  });
});

describe('scorePlaces', () => {
  const corpus = [
    place({ id: 'alpha', tags: ['small_plates', 'solo_friendly', 'quiet'] }),
    place({ id: 'bravo', tags: ['small_plates', 'solo_friendly'] }),
    place({ id: 'charlie', tags: [] }),
  ];

  it('weights the terms exactly as §3.4 states', () => {
    const total =
      SCORE_WEIGHTS.pool + SCORE_WEIGHTS.usual + SCORE_WEIGHTS.rotation + SCORE_WEIGHTS.context;
    expect(total).toBeCloseTo(1, 12);
  });

  it('produces the exact expected score for a fixture case, to 4 decimals', () => {
    // alpha: no reads -> pool 0.5; usual = (spice 1 + price 1 + portion 1 + solo 1)/4 = 1;
    // rotation 1 (never eaten); context = quiet met, solo met, not late -> 2/2 = 1.
    // score = 0.40*0.5 + 0.25*1 + 0.20*1 + 0.15*1 = 0.80
    const alpha = place({ id: 'alpha', tags: ['small_plates', 'solo_friendly', 'quiet'] });
    const [top] = scorePlaces({ reads: [], usual, log: [], corpus: [alpha], context, now: NOW });
    expect(top?.score).toBeCloseTo(0.8, 4);
  });

  it('has parts that reconstruct the score under the documented weights', () => {
    for (const ranked of scorePlaces({ reads: [], usual, log: [], corpus, context, now: NOW })) {
      const recomputed =
        SCORE_WEIGHTS.pool * ranked.parts.pool +
        SCORE_WEIGHTS.usual * ranked.parts.usual +
        SCORE_WEIGHTS.rotation * ranked.parts.rotation +
        SCORE_WEIGHTS.context * ranked.parts.context;
      expect(ranked.score).toBeCloseTo(recomputed, 12);
    }
  });

  it('is order-independent: shuffling the corpus does not change the ranking', () => {
    const input = { reads: [], usual, log: [], context, now: NOW };
    const forward = scorePlaces({ ...input, corpus }).map((r) => r.place.id);
    const reversed = scorePlaces({ ...input, corpus: [...corpus].reverse() }).map(
      (r) => r.place.id,
    );
    expect(reversed).toEqual(forward);
  });

  it('breaks ties by place slug ascending', () => {
    // Three identical places differing only in id: the order is alphabetical.
    const identical = ['zulu', 'alpha', 'mike'].map((id) => place({ id, tags: [] }));
    const ranked = scorePlaces({ reads: [], usual, log: [], corpus: identical, context, now: NOW });
    const ids = ranked.map((r) => r.place.id);
    expect(ids).toEqual(['alpha', 'mike', 'zulu']);
  });

  it('ranks highest score first', () => {
    const ranked = scorePlaces({ reads: [], usual, log: [], corpus, context, now: NOW });
    const scores = ranked.map((r) => r.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it('lets a citable cohort of regret push a place down the ranking', () => {
    // The mechanism the demo's peak depends on: pool evidence reorders a near-tie.
    const input = { usual, log: [], corpus, context, now: NOW };
    const before = scorePlaces({ ...input, reads: [] }).map((r) => r.place.id);
    const after = scorePlaces({
      ...input,
      reads: citableCohort('alpha', 'regret_after_order', 1),
    }).map((r) => r.place.id);
    expect(before[0]).toBe('alpha');
    expect(after.indexOf('alpha')).toBeGreaterThan(before.indexOf('alpha'));
  });

  it('returns an empty ranking when every place is excluded', () => {
    // Reachable in practice: a gi-constrained diner in a corpus with no safe options.
    // X3 has to render something for this, so it must not throw here.
    const ranked = scorePlaces({
      reads: [],
      usual: { ...usual, giConstraint: true },
      log: [],
      corpus: [place({ id: 'a' }), place({ id: 'b' })],
      context,
      now: NOW,
    });
    expect(ranked).toEqual([]);
  });

  it('is reproducible: identical input scores identically every time', () => {
    // The property a rehearsal depends on — the same demo run twice must rank the same.
    const input = {
      reads: citableCohort('alpha', 'secret_default'),
      usual,
      log: [],
      corpus,
      context,
      now: NOW,
    };
    expect(scorePlaces(input)).toEqual(scorePlaces(input));
  });

  it('scores every term inside [0,1]', () => {
    for (const ranked of scorePlaces({
      reads: citableCohort('alpha', 'secret_default'),
      usual,
      log: [],
      corpus,
      context,
      now: NOW,
    })) {
      for (const value of Object.values(ranked.parts)) {
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
      }
      expect(ranked.score).toBeGreaterThanOrEqual(0);
      expect(ranked.score).toBeLessThanOrEqual(1);
    }
  });
});
