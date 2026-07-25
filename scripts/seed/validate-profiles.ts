/**
 * Profile validator (S4). Both demo profiles must reference only real corpus
 * places and dishes (a dish must belong to the place it is logged at), carry
 * schema-valid Usuals, and B's meal log must be rich enough for K3 to fit at
 * least two real half-lives — the rotation beat depends on it.
 *
 * Run: `npx tsx scripts/seed/validate-profiles.ts`
 */

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import type { MealLogEntry, Place, UsualProfile } from '../../src/contracts/types.js';
import { fit } from '../../src/kernel/rotation.js';
import { loadCorpus } from './validate-corpus.js';

export interface DemoProfile {
  usual: UsualProfile;
  mealLog: MealLogEntry[];
}

const FELT = ['glad', 'fine', 'regret'] as const;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function validateProfile(raw: unknown, corpus: Place[], label: string): DemoProfile {
  const problems: string[] = [];
  const root = raw as { usual?: unknown; mealLog?: unknown };
  const usual = root?.usual as UsualProfile | undefined;
  const mealLog = root?.mealLog as MealLogEntry[] | undefined;
  if (usual === undefined || !Array.isArray(mealLog)) {
    throw new Error(`${label}: profile must be {usual, mealLog}`);
  }

  if (![0, 1, 2, 3].includes(usual.spiceTolerance)) problems.push('spiceTolerance must be 0..3');
  if (![1, 2, 3, 4].includes(usual.budgetBand)) problems.push('budgetBand must be 1..4');
  if (!['small', 'standard', 'large'].includes(usual.portionPref)) {
    problems.push('portionPref must be small|standard|large');
  }
  if (typeof usual.soloComfort !== 'boolean') problems.push('soloComfort must be boolean');
  if (typeof usual.giConstraint !== 'boolean') problems.push('giConstraint must be boolean');
  if (!Array.isArray(usual.offLimits) || usual.offLimits.some((t) => typeof t !== 'string')) {
    problems.push('offLimits must be an array of strings');
  }

  const placesById = new Map(corpus.map((place) => [place.id, place]));
  const checkReference = (placeId: string, dishId: string, where: string): void => {
    const place = placesById.get(placeId);
    if (place === undefined) {
      problems.push(`${where}: unknown place "${placeId}"`);
      return;
    }
    if (!place.signatureDishes.some((dish) => dish.dishId === dishId)) {
      problems.push(`${where}: dish "${dishId}" does not belong to "${placeId}"`);
    }
  };

  if (usual.defaultOrder !== undefined) {
    checkReference(usual.defaultOrder.placeId, usual.defaultOrder.dishId, 'defaultOrder');
  }
  mealLog.forEach((entry, index) => {
    const where = `mealLog[${index}]`;
    if (typeof entry.at !== 'string' || !DATE_RE.test(entry.at)) {
      problems.push(`${where}: "at" must be an ISO date (YYYY-MM-DD)`);
    }
    if (entry.felt !== undefined && !FELT.includes(entry.felt)) {
      problems.push(`${where}: felt must be glad|fine|regret`);
    }
    checkReference(entry.placeId, entry.dishId, where);
  });

  if (problems.length > 0) {
    throw new Error(`${label} validation failed:\n- ${problems.join('\n- ')}`);
  }
  return { usual, mealLog };
}

/** B is the near-tie account: K3 must fit ≥2 real half-lives from its log. */
export function assertFittable(profile: DemoProfile, label: string): void {
  const counts = new Map<string, number>();
  for (const entry of profile.mealLog) {
    counts.set(entry.dishId, (counts.get(entry.dishId) ?? 0) + 1);
  }
  const richDishes = [...counts.entries()].filter(([, n]) => n >= 3).map(([dishId]) => dishId);
  const halfLives = fit(profile.mealLog);
  const fitted = richDishes.filter((dishId) => typeof halfLives[dishId] === 'number');
  if (fitted.length < 2) {
    throw new Error(
      `${label}: meal log must yield >=2 fitted half-lives (>=3 observations each); got ${fitted.length}`,
    );
  }
}

export function loadProfiles(): { a: DemoProfile; b: DemoProfile } {
  const corpus = loadCorpus();
  const load = (name: string): unknown =>
    JSON.parse(readFileSync(new URL(`../../data/profiles/${name}.json`, import.meta.url), 'utf8'));
  const a = validateProfile(load('a'), corpus, 'profile A');
  const b = validateProfile(load('b'), corpus, 'profile B');
  assertFittable(b, 'profile B');
  return { a, b };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { a, b } = loadProfiles();
  process.stderr.write(
    `profiles OK: A logs ${a.mealLog.length} meals, B logs ${b.mealLog.length} (near-tie account, half-lives fittable)\n`,
  );
}
