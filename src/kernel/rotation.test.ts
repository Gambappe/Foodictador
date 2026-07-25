import { describe, expect, it, vi } from 'vitest';

import { FIXTURE_NOW, sampleMealLog } from '../contracts/fixtures/index.js';
import type { MealLogEntry } from '../contracts/types.js';
import {
  DEFAULT_HALF_LIFE_DAYS,
  MIN_HALF_LIFE_DAYS,
  REASON_EATEN_TWICE_RECENTLY,
  appetite,
  fit,
  rotation,
  suppressions,
} from './rotation.js';

function entry(dishId: string, at: string): MealLogEntry {
  return { dishId, placeId: 'somewhere', at };
}

describe('K3 suppressions', () => {
  it('a dish eaten twice in seven days is suppressed, with a reason key not prose', () => {
    // sampleMealLog has shoyu_ramen on 07-19 and 07-23; FIXTURE_NOW is 07-25.
    const result = suppressions(sampleMealLog, FIXTURE_NOW);
    expect(result).toContainEqual({ dishId: 'shoyu_ramen', reasonKey: REASON_EATEN_TWICE_RECENTLY });
  });

  it('one serving inside the window does not suppress', () => {
    expect(suppressions([entry('pho', '2026-07-24')], FIXTURE_NOW)).toEqual([]);
  });

  it('two servings both older than seven days do not suppress', () => {
    const log = [entry('pho', '2026-07-10'), entry('pho', '2026-07-12')];
    expect(suppressions(log, FIXTURE_NOW)).toEqual([]);
  });

  it('the boundary day counts: eaten exactly seven days ago plus today suppresses', () => {
    const log = [entry('pho', '2026-07-18T19:00:00.000Z'), entry('pho', '2026-07-25T18:00:00.000Z')];
    expect(suppressions(log, FIXTURE_NOW)).toHaveLength(1);
  });

  it('entries dated after now sit outside the window', () => {
    const log = [entry('pho', '2026-07-24'), entry('pho', '2026-07-30')];
    expect(suppressions(log, FIXTURE_NOW)).toEqual([]);
  });
});

describe('K3 fit', () => {
  it('fits the median repeat interval with ≥3 observations', () => {
    const log = [entry('pho', '2026-07-01'), entry('pho', '2026-07-10'), entry('pho', '2026-07-18')];
    // Gaps are 9 and 8 days — median 8.5.
    expect(fit(log)['pho']).toBeCloseTo(8.5, 10);
  });

  it('a dish with 2 observations inherits the seeded median without throwing', () => {
    const log = [entry('pho', '2026-07-01'), entry('pho', '2026-07-10')];
    expect(fit(log, { pho: 5 })['pho']).toBe(5);
  });

  it('falls back to the default half-life with no seeded median', () => {
    const log = [entry('pho', '2026-07-01')];
    expect(fit(log)['pho']).toBe(DEFAULT_HALF_LIFE_DAYS);
  });

  it('same-day repeats clamp to the minimum half-life instead of zero', () => {
    const log = [entry('pho', '2026-07-10'), entry('pho', '2026-07-10'), entry('pho', '2026-07-10')];
    expect(fit(log)['pho']).toBe(MIN_HALF_LIFE_DAYS);
  });

  it('throws naming an unparseable date rather than fitting garbage', () => {
    const log = [entry('pho', 'not-a-date'), entry('pho', '2026-07-10'), entry('pho', '2026-07-12')];
    expect(() => fit(log)).toThrow(/unparseable meal-log date "not-a-date"/);
  });

  it('fits sampleMealLog: at least two dishes get fitted half-lives', () => {
    const halfLives = fit(sampleMealLog);
    // al_pastor gaps 9,8 → 8.5; bibimbap gaps 10,8 → 9.
    expect(halfLives['al_pastor']).toBeCloseTo(8.5, 10);
    expect(halfLives['bibimbap']).toBeCloseTo(9, 10);
  });
});

describe('K3 appetite', () => {
  const log = [entry('pho', '2026-07-01'), entry('pho', '2026-07-08'), entry('pho', '2026-07-15')];

  it('is monotonically increasing in Δdays', () => {
    let previous = -1;
    for (let day = 0; day <= 21; day++) {
      const now = new Date(Date.parse('2026-07-15T12:00:00.000Z') + day * 86_400_000).toISOString();
      const value = appetite('pho', log, now);
      expect(value).toBeGreaterThan(previous);
      previous = value;
    }
  });

  it('is 50 exactly one half-life after the last serving', () => {
    // Gaps 7,7 → half-life 7. Seven days after 07-15 the curve reads 50.
    expect(appetite('pho', log, '2026-07-22')).toBeCloseTo(50, 10);
  });

  it('a never-eaten dish has full appetite', () => {
    expect(appetite('mystery_dish', log, FIXTURE_NOW)).toBe(100);
  });

  it('a future-dated last serving clamps Δdays at zero, not negative', () => {
    expect(appetite('pho', [entry('pho', '2026-07-30')], FIXTURE_NOW)).toBe(0);
  });

  it('stays in [0, 100)', () => {
    for (const now of ['2026-07-15', '2026-07-16', '2026-09-01', '2027-07-15']) {
      const value = appetite('pho', log, now);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(100);
    }
  });
});

describe('K3 module discipline', () => {
  it('exports the Rotation interface shape', () => {
    expect(rotation).toEqual({ fit, suppressions, appetite });
  });

  it('never reads the clock — every path answers with Date.now sabotaged', () => {
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => {
      throw new Error('rotation read the clock');
    });
    try {
      const log = [entry('pho', '2026-07-20'), entry('pho', '2026-07-23')];
      expect(() => fit(log)).not.toThrow();
      expect(() => suppressions(log, FIXTURE_NOW)).not.toThrow();
      expect(() => appetite('pho', log, FIXTURE_NOW)).not.toThrow();
    } finally {
      spy.mockRestore();
    }
  });
});
