/**
 * Rotation — satiation curves and suppressions (K3). Pure kernel: no I/O, and
 * `now` is a parameter in every signature — never a clock read.
 *
 * The model is plan v1.0 §3.5 verbatim:
 *   appetite(d, t) = 100 · (1 − 2^(−Δdays / halfLife(d)))
 * recommended above 60. The half-life is fitted per dish from repeat intervals
 * in the meal log when there are ≥3 observations; otherwise the dish inherits
 * the seeded median (the one number the pool can seed for a cold user,
 * design v0.8 §8).
 */

import type { MealLogEntry, Suppression } from '../contracts/types.js';
import type { Rotation } from '../contracts/modules.js';

/** §3.5's acceptance line: a dish is recommendable once appetite clears this. */
export const APPETITE_RECOMMEND_THRESHOLD = 60;

/** Inherited when a dish has <3 observations and no seeded median is provided. */
export const DEFAULT_HALF_LIFE_DAYS = 3;

/**
 * Fitted half-lives are clamped here so a dish logged twice in one day cannot
 * produce a zero half-life and a NaN appetite.
 */
export const MIN_HALF_LIFE_DAYS = 0.25;

/** Suppression reason KEY — prose comes from L1's linted catalog, never from here. */
export const REASON_EATEN_TWICE_RECENTLY = 'eaten_twice_recently';

/** Days inside which a second serving of the same dish suppresses it. */
const SUPPRESSION_WINDOW_DAYS = 7;

const DAY_MS = 86_400_000;

function parseDay(at: string): number {
  const ms = Date.parse(at);
  if (Number.isNaN(ms)) {
    throw new Error(`rotation: unparseable meal-log date ${JSON.stringify(at)}`);
  }
  return ms;
}

function daysBetween(earlier: string, later: string): number {
  return (parseDay(later) - parseDay(earlier)) / DAY_MS;
}

function median(sortedAscending: number[]): number {
  const mid = sortedAscending.length / 2;
  const upper = sortedAscending[Math.floor(mid)];
  const lower = sortedAscending[Math.ceil(mid) - 1];
  if (upper === undefined || lower === undefined) {
    throw new Error('rotation: median of an empty list');
  }
  return (upper + lower) / 2;
}

/**
 * Half-life per dish id. ≥3 observations → the median inter-observation gap in
 * days (clamped to MIN_HALF_LIFE_DAYS); fewer → the seeded median for that
 * dish, falling back to DEFAULT_HALF_LIFE_DAYS.
 */
export function fit(
  log: MealLogEntry[],
  seededMedians?: Record<string, number>,
): Record<string, number> {
  const datesByDish = new Map<string, string[]>();
  for (const entry of log) {
    datesByDish.set(entry.dishId, [...(datesByDish.get(entry.dishId) ?? []), entry.at]);
  }

  const halfLives: Record<string, number> = {};
  for (const [dishId, dates] of datesByDish) {
    if (dates.length >= 3) {
      const sorted = [...dates].sort((a, b) => parseDay(a) - parseDay(b));
      const gaps: number[] = [];
      for (let i = 1; i < sorted.length; i++) {
        const prev = sorted[i - 1];
        const curr = sorted[i];
        if (prev !== undefined && curr !== undefined) gaps.push(daysBetween(prev, curr));
      }
      halfLives[dishId] = Math.max(MIN_HALF_LIFE_DAYS, median(gaps.sort((a, b) => a - b)));
    } else {
      halfLives[dishId] = seededMedians?.[dishId] ?? DEFAULT_HALF_LIFE_DAYS;
    }
  }
  return halfLives;
}

/**
 * Dishes eaten at least twice inside the trailing seven days of `now`, each
 * carrying a reason key. Entries dated after `now` are outside the window —
 * the caller's clock is the only clock.
 */
export function suppressions(log: MealLogEntry[], now: string): Suppression[] {
  const recentCounts = new Map<string, number>();
  for (const entry of log) {
    const age = daysBetween(entry.at, now);
    if (age >= 0 && age <= SUPPRESSION_WINDOW_DAYS) {
      recentCounts.set(entry.dishId, (recentCounts.get(entry.dishId) ?? 0) + 1);
    }
  }
  return [...recentCounts.entries()]
    .filter(([, count]) => count >= 2)
    .map(([dishId]) => ({ dishId, reasonKey: REASON_EATEN_TWICE_RECENTLY }));
}

/**
 * §3.5 verbatim: 100 · (1 − 2^(−Δdays/halfLife)). A never-eaten dish is full
 * appetite (100); Δdays is clamped at 0 so a future-dated entry cannot push
 * appetite negative.
 */
export function appetite(dishId: string, log: MealLogEntry[], now: string): number {
  const eaten = log
    .filter((entry) => entry.dishId === dishId)
    .map((entry) => entry.at)
    .sort((a, b) => parseDay(a) - parseDay(b));
  const last = eaten[eaten.length - 1];
  if (last === undefined) return 100;

  const halfLife = fit(log)[dishId] ?? DEFAULT_HALF_LIFE_DAYS;
  const deltaDays = Math.max(0, daysBetween(last, now));
  return 100 * (1 - 2 ** (-deltaDays / halfLife));
}

export const rotation: Rotation = { fit, suppressions, appetite };
