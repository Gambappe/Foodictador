import type { Rotation } from '../modules.js';
import type { MealLogEntry, Suppression } from '../types.js';

const DAY_MS = 86_400_000;
const DEFAULT_HALF_LIFE_DAYS = 3;

function daysBetween(earlier: string, later: string): number {
  return (Date.parse(later) - Date.parse(earlier)) / DAY_MS;
}

/** Fixture-grade rotation: real formula shape, crude fitting. K3 replaces it. */
export class StubRotation implements Rotation {
  fit(log: MealLogEntry[], seededMedians?: Record<string, number>): Record<string, number> {
    const byDish = new Map<string, string[]>();
    for (const entry of log) {
      byDish.set(entry.dishId, [...(byDish.get(entry.dishId) ?? []), entry.at]);
    }
    const halfLives: Record<string, number> = {};
    for (const [dishId, dates] of byDish) {
      const sorted = [...dates].sort();
      if (sorted.length >= 3) {
        const gaps: number[] = [];
        for (let i = 1; i < sorted.length; i++) {
          const prev = sorted[i - 1];
          const curr = sorted[i];
          if (prev !== undefined && curr !== undefined) gaps.push(daysBetween(prev, curr));
        }
        const mid = gaps.sort((a, b) => a - b)[Math.floor(gaps.length / 2)];
        halfLives[dishId] = mid ?? DEFAULT_HALF_LIFE_DAYS;
      } else {
        halfLives[dishId] = seededMedians?.[dishId] ?? DEFAULT_HALF_LIFE_DAYS;
      }
    }
    return halfLives;
  }

  suppressions(log: MealLogEntry[], now: string): Suppression[] {
    const recentCounts = new Map<string, number>();
    for (const entry of log) {
      const age = daysBetween(entry.at, now);
      if (age >= 0 && age <= 7) recentCounts.set(entry.dishId, (recentCounts.get(entry.dishId) ?? 0) + 1);
    }
    return [...recentCounts.entries()]
      .filter(([, count]) => count >= 2)
      .map(([dishId]) => ({ dishId, reasonKey: 'eaten_twice_recently' }));
  }

  appetite(dishId: string, log: MealLogEntry[], now: string): number {
    const eaten = log.filter((e) => e.dishId === dishId).map((e) => e.at).sort();
    const last = eaten[eaten.length - 1];
    if (last === undefined) return 100;
    const halfLife = this.fit(log)[dishId] ?? DEFAULT_HALF_LIFE_DAYS;
    const delta = Math.max(0, daysBetween(last, now));
    return 100 * (1 - 2 ** (-delta / halfLife));
  }
}
