/**
 * D-9: **Confit does not screen allergens, and must never sound as though it does.**
 *
 * The product owner chose option (c) after the corpus was checked: `data/places.json` carries
 * six place tags — `quiet`, `counter_seating`, `late_night`, `small_plates`, `solo_friendly`,
 * `gi_safe_options` — and not one of them is an allergen. `Place` has no ingredient field, and
 * `signatureDishes` carries `spiceLevel` only. There is nothing to filter on, so rather than
 * ship a half-filter the product states the limitation.
 *
 * That decision is only worth anything if it survives contact with future copy edits, and copy
 * is the easiest thing in a codebase to soften. So this guard holds two lines:
 *
 * 1. **The disclaimer exists**, in the two places a user forms a belief about what off-limits
 *    covers — the editor where they type "shellfish", and the refusal where they learn the
 *    feature exists.
 * 2. **Nothing anywhere claims we check.** Substrate prose is the sharp edge here: `M14` feeds
 *    the extractor a sentence per read, and one of those sentences used to say a menu item was
 *    "genuinely unsafe" — which was measured coming back out of the live API as a
 *    card-bound induced claim. Confit asserting what is safe to eat, on the strength of an
 *    LLM's paraphrase of a stranger's confession, is the worst version of this failure.
 *
 * `offLimits` remains exactly what it was: a topic blocklist that gates RECORDING ([E24]). The
 * name is the trap — "off-limits" plus a free-text box reads as "keep me away from this" — and
 * `grep` finds it used nowhere in the ask path, so it filters no recommendation.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { lint } from '../../src/kernel/copylint.js';
import { REFUSAL_SCOPE } from '../../src/ui/confess/copy.js';
import { everyProseSentence } from '../../src/memory/readProse.js';
import { DRIVER_PHRASES } from '../../src/llm/catalog.js';
import type { Place } from '../../src/contracts/types.js';

function repoFile(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(`../../${relativePath}`, import.meta.url)), 'utf8');
}

/** Wording that would tell a user we vet food for safety. */
const IMPLIES_SCREENING = [
  /\bsafe to eat\b/i,
  /\bwe (?:check|screen|verify|vet)\b/i,
  /\ballergen-(?:free|safe)\b/i,
  /\bgenuinely unsafe\b/i,
  /\bguarantee\w*\b.{0,24}\ballerg/i,
];

describe('D-9: the corpus has no allergen data, so nothing may claim otherwise', () => {
  it('the corpus really does carry no allergen tag — the premise, checked not assumed', () => {
    // If someone later adds allergen tags, this goes red and the whole decision should be
    // revisited rather than this file quietly updated.
    const corpus = JSON.parse(repoFile('data/places.json')) as { places: Place[] };
    const tags = new Set(corpus.places.flatMap((place) => place.tags));
    expect([...tags].sort()).toEqual([
      'counter_seating',
      'gi_safe_options',
      'late_night',
      'quiet',
      'small_plates',
      'solo_friendly',
    ]);
    // And no place carries ingredient data an allergen filter could be built from.
    for (const place of corpus.places) {
      for (const dish of place.signatureDishes) {
        expect(Object.keys(dish).sort()).toEqual(['dishId', 'name', 'spiceLevel']);
      }
    }
  });

  it('the disclaimer names both halves: not recommendations, and not allergens', () => {
    // Both halves matter. "Not where it sends you" without the allergen sentence leaves a
    // reader to work out the consequence themselves, and the consequence is the point.
    expect(REFUSAL_SCOPE).toMatch(/not where it sends you/);
    expect(REFUSAL_SCOPE).toMatch(/allergens/i);
  });

  it('the disclaimer is rendered where a user types a topic, and where one is refused', () => {
    // Source-level, because a `data-testid` deleted in a refactor takes the sentence with it
    // and the component's own suite would go green again the moment the assertion went too.
    expect(repoFile('src/ui/settings/OffLimitsEditor.tsx')).toContain('off-limits-scope');
    expect(repoFile('src/ui/confess/ConfessScreen.tsx')).toContain('refusal-scope');
    expect(repoFile('src/cli/confess.ts')).toContain('REFUSAL_SCOPE');
  });

  it('no pool prose asserts a safety fact', () => {
    // The measured failure. `allergy_constraint` used to render as "something on the menu is
    // genuinely unsafe for them", that went to the extractor, and the live API synthesised it
    // into "...explained by something on the menu being genuinely unsafe" — bound for a card.
    for (const sentence of everyProseSentence()) {
      for (const pattern of IMPLIES_SCREENING) {
        expect(sentence, sentence).not.toMatch(pattern);
      }
    }
  });

  it('no card copy asserts a safety fact', () => {
    for (const phrase of Object.values(DRIVER_PHRASES)) {
      for (const pattern of IMPLIES_SCREENING) {
        expect(phrase, phrase).not.toMatch(pattern);
      }
    }
  });

  it('the disclaimer passes K5\'s lexicon like any other user-facing copy', () => {
    // U2's copy module is not covered by G3 (SL-28), so it is linted here rather than trusted.
    const verdict = lint(REFUSAL_SCOPE);
    expect(verdict.ok ? [] : verdict.hits).toEqual([]);
  });
});
