/**
 * Corpus validator (S1). Fails loudly on schema violations, duplicate slugs,
 * or a signature dish id used by two places — the corpus is hand-curated data,
 * and a silent inconsistency here surfaces as a wrong card on stage.
 *
 * Run: `npx tsx scripts/seed/validate-corpus.ts [path]` (defaults to data/places.json).
 */

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import type { Place, PlaceTag } from '../../src/contracts/types.js';

const TAGS: readonly PlaceTag[] = [
  'late_night',
  'counter_seating',
  'solo_friendly',
  'quiet',
  'gi_safe_options',
  'small_plates',
];
const SLUG_RE = /^[a-z][a-z0-9_]*$/;
export const CORPUS_SIZE = 40;

/** Returns the validated places, or throws listing every problem found. */
export function validateCorpus(raw: unknown, expectedSize: number = CORPUS_SIZE): Place[] {
  const problems: string[] = [];
  const root = raw as { places?: unknown };
  if (!Array.isArray(root?.places)) {
    throw new Error('corpus: root must be {"places": [...]}');
  }
  const places = root.places as Place[];
  if (places.length !== expectedSize) {
    problems.push(`expected exactly ${expectedSize} places, found ${places.length}`);
  }

  const slugs = new Set<string>();
  const dishOwners = new Map<string, string>();

  places.forEach((place, index) => {
    const where = `places[${index}] (${String((place as { id?: unknown }).id ?? '?')})`;
    if (typeof place.id !== 'string' || !SLUG_RE.test(place.id)) {
      problems.push(`${where}: id must be a lowercase slug`);
    } else if (slugs.has(place.id)) {
      problems.push(`${where}: duplicate slug`);
    } else {
      slugs.add(place.id);
    }
    if (typeof place.name !== 'string' || place.name.trim() === '') {
      problems.push(`${where}: name must be non-empty`);
    }
    if (typeof place.cuisine !== 'string' || place.cuisine.trim() === '') {
      problems.push(`${where}: cuisine must be non-empty`);
    }
    if (![1, 2, 3, 4].includes(place.priceBand)) {
      problems.push(`${where}: priceBand must be 1..4`);
    }
    if (!Array.isArray(place.tags) || place.tags.some((tag) => !TAGS.includes(tag))) {
      problems.push(`${where}: tags must come from the closed tag set`);
    }
    if (!Array.isArray(place.signatureDishes) || place.signatureDishes.length === 0) {
      problems.push(`${where}: needs at least one signature dish`);
      return;
    }
    for (const dish of place.signatureDishes) {
      if (typeof dish.dishId !== 'string' || !SLUG_RE.test(dish.dishId)) {
        problems.push(`${where}: dish id "${String(dish.dishId)}" must be a lowercase slug`);
        continue;
      }
      const owner = dishOwners.get(dish.dishId);
      if (owner !== undefined && owner !== place.id) {
        problems.push(`dish "${dish.dishId}" is claimed by both "${owner}" and "${place.id}"`);
      }
      dishOwners.set(dish.dishId, place.id);
      if (typeof dish.name !== 'string' || dish.name.trim() === '') {
        problems.push(`${where}: dish "${dish.dishId}" needs a name`);
      }
      if (![0, 1, 2, 3].includes(dish.spiceLevel)) {
        problems.push(`${where}: dish "${dish.dishId}" spiceLevel must be 0..3`);
      }
    }
  });

  if (problems.length > 0) {
    throw new Error(`corpus validation failed:\n- ${problems.join('\n- ')}`);
  }
  return places;
}

export function loadCorpus(path: string = defaultCorpusPath()): Place[] {
  return validateCorpus(JSON.parse(readFileSync(path, 'utf8')));
}

export function defaultCorpusPath(): string {
  return new URL('../../data/places.json', import.meta.url).pathname;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const path = process.argv[2] ?? defaultCorpusPath();
  const places = loadCorpus(path);
  process.stderr.write(`corpus OK: ${places.length} places, all slugs and dish ids unique\n`);
}
