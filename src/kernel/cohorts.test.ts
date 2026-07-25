import { describe, expect, it } from 'vitest';
import { DRIVERS, type Read, type UsualProfile } from '../contracts/types.js';
import { KFLOOR, UNMATCHABLE_DRIVERS, census, matched, missed } from './cohorts.js';

/** A read with sane defaults; override only what the case is about. */
function read(overrides: Partial<Read> & { read_id: string }): Read {
  return {
    place: 'rosas_taqueria',
    signal: 'regret_after_order',
    driver: 'spice_tolerance_low',
    cadence: 'weekly',
    weight: 0.5,
    ...overrides,
  };
}

/** A Usual for whom spice_tolerance_low, budget_ceiling and portion_small are relevant. */
const spiceAverse: UsualProfile = {
  spiceTolerance: 1,
  budgetBand: 2,
  portionPref: 'small',
  soloComfort: false,
  giConstraint: false,
  offLimits: [],
};

/** A Usual for whom none of the mappable drivers are relevant. */
const unconstrained: UsualProfile = {
  spiceTolerance: 3,
  budgetBand: 4,
  portionPref: 'large',
  soloComfort: false,
  giConstraint: false,
  offLimits: [],
};

const fiveDistinct = [
  read({ read_id: 'r1', place: 'a' }),
  read({ read_id: 'r2', place: 'b' }),
  read({ read_id: 'r3', place: 'c' }),
  read({ read_id: 'r4', place: 'd' }),
  read({ read_id: 'r5', place: 'e' }),
];

describe('dedup on read_id — the [E20] invariant', () => {
  it('does NOT reach k>=5 from four reads plus a duplicate', () => {
    // The case that motivated giving the read an id at all. A read sits in both the pool
    // and the relay for the whole settle window, so the union contains it twice.
    const fourPlusDuplicate = [
      read({ read_id: 'r1', place: 'a' }),
      read({ read_id: 'r2', place: 'b' }),
      read({ read_id: 'r3', place: 'c' }),
      read({ read_id: 'r4', place: 'd' }),
      read({ read_id: 'r1', place: 'a' }),
    ];
    expect(fourPlusDuplicate).toHaveLength(5);

    const [stat] = census(fourPlusDuplicate);
    expect(stat?.k).toBe(4);
    expect(matched(spiceAverse, fourPlusDuplicate)).toEqual([]);
  });

  it('DOES reach k>=5 from five identical-but-distinct reads', () => {
    // Two people can legitimately file the same five fields. Field equality must not
    // collapse them; only a shared read_id may.
    const identicalFields = ['r1', 'r2', 'r3', 'r4', 'r5'].map((id) => read({ read_id: id }));
    const [stat] = census(identicalFields);
    expect(stat?.k).toBe(5);
    expect(matched(spiceAverse, identicalFields)).toHaveLength(1);
  });

  it('keeps the first occurrence when a read_id appears twice with different fields', () => {
    // Documented behaviour: callers union pool-then-relay so the canonical copy wins.
    const divergent = [
      read({ read_id: 'r1', place: 'pool_copy' }),
      read({ read_id: 'r1', place: 'relay_copy' }),
    ];
    expect(census(divergent)[0]?.placeIds).toEqual(['pool_copy']);
  });
});

describe('census', () => {
  it('returns nothing for no reads', () => {
    expect(census([])).toEqual([]);
  });

  it('groups by driver and reports k, meanWeight and distinct places', () => {
    const stats = census([
      read({ read_id: 'r1', driver: 'spice_tolerance_low', place: 'b', weight: 0.2 }),
      read({ read_id: 'r2', driver: 'spice_tolerance_low', place: 'a', weight: 0.4 }),
      read({ read_id: 'r3', driver: 'spice_tolerance_low', place: 'a', weight: 0.9 }),
      read({ read_id: 'r4', driver: 'crowd_aversion', place: 'c', weight: 1 }),
    ]);

    expect(stats).toHaveLength(2);
    const spice = stats.find((stat) => stat.driver === 'spice_tolerance_low');
    expect(spice?.k).toBe(3);
    expect(spice?.meanWeight).toBeCloseTo(0.5, 10);
    expect(spice?.placeIds).toEqual(['a', 'b']); // deduped and sorted
    expect(stats.find((stat) => stat.driver === 'crowd_aversion')?.k).toBe(1);
  });

  it('omits drivers with no reads rather than inventing a k:0 row', () => {
    const drivers = census([read({ read_id: 'r1' })]).map((stat) => stat.driver);
    expect(drivers).toEqual(['spice_tolerance_low']);
  });

  it('is order-independent: shuffling the input does not change the output', () => {
    const forward = census(fiveDistinct);
    const reversed = census([...fiveDistinct].reverse());
    expect(reversed).toEqual(forward);
  });

  it('orders cohorts by the canonical driver vocabulary, not by insertion', () => {
    // crowd_aversion is last in DRIVERS, spice_tolerance_low first.
    const stats = census([
      read({ read_id: 'r1', driver: 'crowd_aversion' }),
      read({ read_id: 'r2', driver: 'spice_tolerance_low' }),
    ]);
    expect(stats.map((stat) => stat.driver)).toEqual(['spice_tolerance_low', 'crowd_aversion']);
  });
});

describe('matched — citable cohorts only', () => {
  it('defaults to the k>=5 privacy floor', () => {
    expect(KFLOOR).toBe(5);
    expect(matched(spiceAverse, fiveDistinct.slice(0, 4))).toEqual([]);
    expect(matched(spiceAverse, fiveDistinct)).toHaveLength(1);
  });

  it('honours an explicit floor', () => {
    expect(matched(spiceAverse, fiveDistinct.slice(0, 4), 4)).toHaveLength(1);
    expect(matched(spiceAverse, fiveDistinct, 6)).toEqual([]);
  });

  it.each([0, -1, 1.5, Number.NaN])(
    'refuses a floor of %s rather than widening the guarantee',
    (floor) => {
      // A floor below 1 would make a cohort of one citable — the re-identification this
      // module exists to prevent. Both entry points must refuse it.
      expect(() => matched(spiceAverse, fiveDistinct, floor)).toThrow(/kFloor/);
      expect(() => missed(spiceAverse, fiveDistinct, floor)).toThrow(/kFloor/);
    },
  );

  it('never returns a sub-floor cohort, at any cohort size', () => {
    // The privacy guarantee stated as an invariant rather than as example cases: across
    // every size either side of the floor, nothing citable is ever below it, and the
    // citable/miss split is exactly the floor.
    for (let size = 1; size <= 8; size += 1) {
      const reads = Array.from({ length: size }, (_, index) =>
        read({ read_id: `r${String(index)}`, place: `p${String(index)}` }),
      );
      const citable = matched(spiceAverse, reads);
      expect(citable.every((stat) => stat.k >= KFLOOR)).toBe(true);
      expect(citable.length > 0).toBe(size >= KFLOOR);
      expect(missed(spiceAverse, reads).length > 0).toBe(size < KFLOOR);
    }
  });

  it('excludes cohorts irrelevant to this Usual even when they clear the floor', () => {
    // Same five reads, a user whose Usual gives no evidence for the driver.
    expect(matched(unconstrained, fiveDistinct)).toEqual([]);
  });

  it.each([
    ['spice_tolerance_low', { spiceTolerance: 1 }, { spiceTolerance: 2 }],
    ['budget_ceiling', { budgetBand: 2 }, { budgetBand: 3 }],
    ['portion_small', { portionPref: 'small' }, { portionPref: 'standard' }],
    ['solo_comfort', { soloComfort: true }, { soloComfort: false }],
    ['gi_constraint', { giConstraint: true }, { giConstraint: false }],
  ] as const)('matches %s on the Usual field that evidences it', (driver, yes, no) => {
    const reads = fiveDistinct.map((r) => ({ ...r, driver }));
    expect(matched({ ...unconstrained, ...yes }, reads)).toHaveLength(1);
    expect(matched({ ...unconstrained, ...no }, reads)).toEqual([]);
  });
});

describe('missed — cohort-miss candidates', () => {
  it('returns relevant cohorts below the floor', () => {
    const stats = missed(spiceAverse, fiveDistinct.slice(0, 4));
    expect(stats).toHaveLength(1);
    expect(stats[0]?.k).toBe(4);
  });

  it('is disjoint from matched, so a miss can never be cited', () => {
    for (const size of [0, 1, 4, 5, 6]) {
      const reads = fiveDistinct.slice(0, size);
      const citable = matched(spiceAverse, reads).map((stat) => stat.driver);
      const misses = missed(spiceAverse, reads).map((stat) => stat.driver);
      expect(citable.filter((driver) => misses.includes(driver))).toEqual([]);
    }
  });

  it('excludes cohorts irrelevant to this Usual', () => {
    expect(missed(unconstrained, fiveDistinct.slice(0, 4))).toEqual([]);
  });
});

describe('the UsualProfile contract gap', () => {
  it('names the six drivers no Usual can evidence', () => {
    // Recorded as a test so the gap is visible in CI rather than only in a comment.
    // Resolving it is an integrator call: extend UsualProfile, or derive relevance from
    // the user's own reads.
    expect([...UNMATCHABLE_DRIVERS]).toEqual([
      'allergy_constraint',
      'sensory_shift',
      'companion_constraint',
      'emotional_exclusion',
      'acclaim_skeptic',
      'crowd_aversion',
    ]);
    expect(UNMATCHABLE_DRIVERS.length + 5).toBe(DRIVERS.length);
  });

  it('cannot cite an unmatchable driver however large its cohort', () => {
    for (const driver of UNMATCHABLE_DRIVERS) {
      const big = Array.from({ length: 20 }, (_, index) =>
        read({ read_id: `r${String(index)}`, driver }),
      );
      expect(matched(spiceAverse, big)).toEqual([]);
      expect(missed(spiceAverse, big)).toEqual([]);
    }
  });
});
