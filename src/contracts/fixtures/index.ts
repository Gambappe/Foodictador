/**
 * Typed access to the frozen fixtures. JSON is loaded with fs at import time (no
 * bundler-specific JSON-module syntax, so node, tsx and vitest all agree), and the
 * shapes are pinned by contracts.test.ts rather than trusted.
 */
import { readFileSync } from 'node:fs';

import type { MealLogEntry, Place, Read, UsualProfile } from '../types.js';

function loadJson<T>(relativePath: string): T {
  return JSON.parse(readFileSync(new URL(relativePath, import.meta.url), 'utf8')) as T;
}

export interface CannedConfession {
  keyword: string;
  text: string;
  chips: Omit<Read, 'read_id'>;
  confidence: number;
}

export const poolBaseline: Read[] = loadJson<{ reads: Read[] }>('./pool-baseline.json').reads;

export const corpusFixture: Place[] = loadJson<{ places: Place[] }>('./corpus-fixture.json').places;

export const cannedConfessions: CannedConfession[] = loadJson<{
  confessions: CannedConfession[];
}>('./canned-confessions.json').confessions;

/** The canonical six-field read — contracts.test.ts pins its keys to READ_KEYS. */
export const sampleRead: Read = {
  read_id: '00000000-0000-4000-8000-00000000feed',
  place: 'rosas_taqueria',
  signal: 'returns_despite_incident',
  driver: 'companion_constraint',
  cadence: 'weekly',
  weight: 0.81,
};

/**
 * A fixture Usual whose traits map onto the baseline pool deliberately:
 * spiceTolerance 1 → spice_tolerance_low (k=5, citable),
 * budgetBand 2 → budget_ceiling (k=4, cohort-miss),
 * soloComfort → solo_comfort (k=6, citable).
 */
export const sampleUsual: UsualProfile = {
  spiceTolerance: 1,
  budgetBand: 2,
  portionPref: 'standard',
  soloComfort: true,
  giConstraint: false,
  offLimits: [],
  defaultOrder: { placeId: 'quiet_counter', dishId: 'bibimbap' },
};

/** Meal log with shoyu_ramen twice inside seven days of 2026-07-25 (rotation fodder). */
export const sampleMealLog: MealLogEntry[] = [
  { dishId: 'shoyu_ramen', placeId: 'noodle_shrine', at: '2026-07-19', felt: 'glad' },
  { dishId: 'shoyu_ramen', placeId: 'noodle_shrine', at: '2026-07-23', felt: 'fine' },
  { dishId: 'al_pastor', placeId: 'rosas_taqueria', at: '2026-07-01', felt: 'glad' },
  { dishId: 'al_pastor', placeId: 'rosas_taqueria', at: '2026-07-10', felt: 'glad' },
  { dishId: 'al_pastor', placeId: 'rosas_taqueria', at: '2026-07-18', felt: 'glad' },
  { dishId: 'bibimbap', placeId: 'quiet_counter', at: '2026-06-28', felt: 'glad' },
  { dishId: 'bibimbap', placeId: 'quiet_counter', at: '2026-07-08', felt: 'fine' },
  { dishId: 'bibimbap', placeId: 'quiet_counter', at: '2026-07-16', felt: 'glad' },
];

export const FIXTURE_NOW = '2026-07-25T19:00:00.000Z';
