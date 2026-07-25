/**
 * Card fixtures for the Ask screen (U3).
 *
 * One builder plus named variants, so a test names the variant it renders rather than
 * assembling a `Card` inline and quietly drifting from the contract. Every fixture is a
 * real `Card`, so a contract change breaks these at compile time.
 */

import type { Card, Place } from '../../contracts/types.js';

const ROSAS: Place = {
  id: 'rosas_taqueria',
  name: "Rosa's Taqueria",
  cuisine: 'mexican',
  priceBand: 2,
  tags: ['solo_friendly'],
  signatureDishes: [{ dishId: 'al_pastor', name: 'Al pastor', spiceLevel: 2 }],
};

const QUIET_COUNTER: Place = {
  id: 'quiet_counter',
  name: 'Quiet Counter',
  cuisine: 'korean',
  priceBand: 2,
  tags: ['counter_seating', 'solo_friendly'],
  signatureDishes: [{ dishId: 'bibimbap', name: 'Bibimbap', spiceLevel: 1 }],
};

const NOODLE_SHRINE: Place = {
  id: 'noodle_shrine',
  name: 'Noodle Shrine',
  cuisine: 'japanese',
  priceBand: 1,
  tags: ['quiet'],
  signatureDishes: [{ dishId: 'shoyu_ramen', name: 'Shoyu ramen', spiceLevel: 0 }],
};

export function cardFixture(overrides: Partial<Card> = {}): Card {
  return {
    pick: ROSAS,
    reasonLine: "Rosa's Taqueria — people with your real spice tolerance keep steering the same way.",
    runnersUp: [
      { place: QUIET_COUNTER, score: 0.7312 },
      { place: NOODLE_SHRINE, score: 0.7195 },
    ],
    scores: { rosas_taqueria: 0.7488, quiet_counter: 0.7312, noodle_shrine: 0.7195 },
    ...overrides,
  };
}

/** The peak beat: a citable cohort, named by driver and count. */
export const CITED_CARD: Card = cardFixture({
  poolCitation: { driver: 'spice_tolerance_low', k: 6 },
  rotationLine: 'Not ramen — twice this week already, and you turn on it by the third.',
  usualLine: 'Nothing that fights back and small plates.',
});

/** The rehearsed failure: a driver nobody else has reported yet. */
export const MISS_CARD: Card = cardFixture({
  cohortMiss: { driver: 'crowd_aversion' },
});

/** XTrace unavailable: counts stay live, the pool claim is cached, and the card says so. */
export const DEGRADED_CARD: Card = cardFixture({
  poolCitation: { driver: 'gi_constraint', k: 5 },
  degradedPool: true,
});

/** Neither citation nor miss — The Usual and Rotation carry the pick on their own. */
export const PLAIN_CARD: Card = cardFixture({
  reasonLine: "Rosa's Taqueria — a quiet fit for how you actually eat.",
  usualLine: 'Fine to eat alone.',
});
