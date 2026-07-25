import { describe, expect, it } from 'vitest';

import { fit } from '../../src/kernel/rotation.js';
import { loadCorpus } from './validate-corpus.js';
import { assertFittable, loadProfiles, validateProfile } from './validate-profiles.js';

const corpus = loadCorpus();

describe('S4 demo profiles', () => {
  it('both committed profiles validate; B yields at least two fitted half-lives', () => {
    const { a, b } = loadProfiles();
    expect(a.usual.offLimits).toEqual([]);
    expect(b.usual.offLimits).toEqual([]);
    const halfLives = fit(b.mealLog);
    const fitted = Object.keys(halfLives).filter(
      (dishId) => b.mealLog.filter((e) => e.dishId === dishId).length >= 3,
    );
    expect(fitted.length).toBeGreaterThanOrEqual(2);
  });

  it("B's traits map onto pooled drivers and its demo week carries a suppression", () => {
    const { b } = loadProfiles();
    expect(b.usual.spiceTolerance).toBeLessThanOrEqual(1); // → spice_tolerance_low
    expect(b.usual.budgetBand).toBeLessThanOrEqual(2); // → budget_ceiling
    expect(b.usual.soloComfort).toBe(true); // → solo_comfort
    const demoWeekRamen = b.mealLog.filter(
      (e) => e.dishId === 'shoyu_ramen' && e.at >= '2026-07-19' && e.at <= '2026-07-25',
    );
    expect(demoWeekRamen.length).toBeGreaterThanOrEqual(2); // rotation beat is live
  });

  it('rejects a profile referencing an unknown dish id', () => {
    const { b } = loadProfiles();
    const broken = {
      usual: b.usual,
      mealLog: [{ dishId: 'phantom_dish', placeId: 'noodle_shrine', at: '2026-07-01' }],
    };
    expect(() => validateProfile(broken, corpus, 'broken')).toThrow(
      /dish "phantom_dish" does not belong to "noodle_shrine"/,
    );
  });

  it('rejects a dish logged at the wrong place and an unknown place', () => {
    const { b } = loadProfiles();
    const wrongPlace = {
      usual: b.usual,
      mealLog: [{ dishId: 'shoyu_ramen', placeId: 'rosas_taqueria', at: '2026-07-01' }],
    };
    expect(() => validateProfile(wrongPlace, corpus, 'x')).toThrow(/does not belong to/);

    const noPlace = {
      usual: b.usual,
      mealLog: [{ dishId: 'shoyu_ramen', placeId: 'nowhere', at: '2026-07-01' }],
    };
    expect(() => validateProfile(noPlace, corpus, 'x')).toThrow(/unknown place "nowhere"/);
  });

  it('rejects bad usual domains, bad dates, and bad felt values', () => {
    const { b } = loadProfiles();
    expect(() =>
      validateProfile({ usual: { ...b.usual, spiceTolerance: 9 }, mealLog: [] }, corpus, 'x'),
    ).toThrow(/spiceTolerance/);
    expect(() =>
      validateProfile(
        { usual: b.usual, mealLog: [{ dishId: 'pho_ga', placeId: 'phos_deep', at: 'yesterday' }] },
        corpus,
        'x',
      ),
    ).toThrow(/ISO date/);
    expect(() =>
      validateProfile(
        {
          usual: b.usual,
          mealLog: [{ dishId: 'pho_ga', placeId: 'phos_deep', at: '2026-07-01', felt: 'meh' }],
        },
        corpus,
        'x',
      ),
    ).toThrow(/felt/);
  });

  it('assertFittable rejects a log with fewer than two rich dishes', () => {
    const thin = {
      usual: loadProfiles().b.usual,
      mealLog: [
        { dishId: 'pho_ga', placeId: 'phos_deep', at: '2026-07-01' },
        { dishId: 'pho_ga', placeId: 'phos_deep', at: '2026-07-08' },
      ],
    };
    expect(() => assertFittable(thin, 'thin')).toThrow(/>=2 fitted half-lives/);
  });
});
