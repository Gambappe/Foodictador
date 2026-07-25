/**
 * G3 — copy-linter regression (design v0.8 §9, [C9]).
 *
 * Every string the product can render comes from L1's catalog or the template
 * narrator over it; this suite pushes all of them through the K5 linter, plus
 * one case per banned lexicon entry — so extending the lexicon without fixing
 * the copy fails HERE, in CI, not on a card.
 */
import { describe, expect, it } from 'vitest';

import { corpusFixture } from '../../src/contracts/fixtures/index.js';
import type { NarratorFacts, RankedPlace } from '../../src/contracts/types.js';
import { lint } from '../../src/kernel/copylint.js';
import { BANNED_LEXICON } from '../../src/kernel/lexicon.js';
import {
  CATALOG,
  DRIVER_PHRASES,
  USUAL_PHRASES,
  renderTemplate,
  type CatalogKey,
} from '../../src/llm/catalog.js';
import { TemplateNarrator } from '../../src/llm/template.js';

/** Benign slot values for rendering every template. */
const SLOTS: Record<string, string> = {
  pick: "Rosa's Taqueria",
  claim: 'Hygiene complaints under-predict loyalty here.',
  k: '6',
  driverPhrase: 'your real spice tolerance',
  dish: 'shoyu ramen',
};

function ranked(): RankedPlace[] {
  return corpusFixture.slice(0, 3).map((place, i) => ({
    place,
    score: 0.8 - i * 0.02,
    parts: { pool: 0.3, usual: 0.2, rotation: 0.2, context: 0.1 },
  }));
}

function baseFacts(): NarratorFacts {
  return { suppressions: [], usualNotes: [], degradedPool: false };
}

/** Every card variant the template narrator can produce — the narrator fixtures. */
const FACT_VARIANTS: Array<[string, NarratorFacts]> = [
  ['plain', baseFacts()],
  ['cited', { ...baseFacts(), citation: { driver: 'spice_tolerance_low', k: 6 } }],
  ['induced', { ...baseFacts(), poolClaim: 'Hygiene complaints under-predict loyalty here.' }],
  [
    'induced + cited',
    {
      ...baseFacts(),
      poolClaim: 'The lunch menu is the honest menu here.',
      citation: { driver: 'budget_ceiling', k: 7 },
    },
  ],
  ['cohort miss', { ...baseFacts(), cohortMiss: { driver: 'crowd_aversion' } }],
  [
    'suppression',
    { ...baseFacts(), suppressions: [{ dishId: 'shoyu_ramen', reasonKey: 'eaten_twice_recently' }] },
  ],
  [
    'unknown suppression key',
    { ...baseFacts(), suppressions: [{ dishId: 'al_pastor', reasonKey: 'some_future_reason' }] },
  ],
  ['degraded pool', { ...baseFacts(), degradedPool: true }],
];

describe('G3: every catalog template is linter-clean', () => {
  for (const key of Object.keys(CATALOG) as CatalogKey[]) {
    it(`template "${key}"`, () => {
      expect(lint(renderTemplate(key, SLOTS))).toEqual({ ok: true });
    });
  }
});

describe('G3: every driver phrase is linter-clean', () => {
  for (const [driver, phrase] of Object.entries(DRIVER_PHRASES)) {
    it(`phrase for ${driver}`, () => {
      expect(lint(phrase)).toEqual({ ok: true });
    });
  }
});

describe('G3: every template-narrator output variant is linter-clean', () => {
  const narrator = new TemplateNarrator();
  for (const [label, facts] of FACT_VARIANTS) {
    it(`variant: ${label}`, async () => {
      const copy = await narrator.write(ranked(), facts);
      for (const line of [copy.reasonLine, copy.rotationLine, copy.usualLine, copy.cohortMissLine]) {
        if (line !== undefined) expect(lint(line)).toEqual({ ok: true });
      }
    });
  }
});

describe('G3: one case per banned lexicon entry', () => {
  // Extending the lexicon adds a case here automatically; a term the linter
  // stops catching (e.g. a regression in inflection handling) fails by name.
  for (const term of BANNED_LEXICON) {
    it(`"${term}" is caught inside a card-shaped sentence`, () => {
      const result = lint(`A quiet pick tonight — about your ${term}, mostly.`);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.hits).toContain(term);
    });
  }
});

describe('G3: the acceptance cases', () => {
  it('a deliberately inserted streak line fails', () => {
    expect(lint("you're on a 3-day streak").ok).toBe(false);
  });

  it('lints every usual-line phrase', () => {
    // Defect SL-21: these ten strings are card copy but live outside CATALOG, so this
    // guard's CATALOG sweep never reached them. The first fix only added a sweep to L1's
    // own suite, which left G3 — the task whose whole job is catching unlinted copy —
    // still blind to them. A budget or portion phrase is exactly where `weight` or
    // `portion control` would appear.
    for (const [key, phrase] of Object.entries(USUAL_PHRASES)) {
      expect(lint(phrase), `${key}: ${phrase}`).toEqual({ ok: true });
    }
  });

  it('a realistic dirty card line names every term that fired', () => {
    const result = lint('Great progress — a guilt-free pick that fits your diet.');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.hits).toEqual(expect.arrayContaining(['progress', 'guilt', 'diet']));
  });
});
