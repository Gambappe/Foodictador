import { describe, expect, it } from 'vitest';

import { corpusFixture } from '../contracts/fixtures/index.js';
import type { NarratorFacts, RankedPlace } from '../contracts/types.js';
import { lint } from '../kernel/copylint.js';
import { CATALOG, DRIVER_PHRASES, renderTemplate, usualLineFor, type CatalogKey } from './catalog.js';
import { USUAL_NOTE_KEYS } from '../kernel/askEngine.js';
import { USUAL_PHRASES } from './catalog.js';
import { TemplateNarrator, templateNarrator } from './template.js';

/** Benign slot values for lint-rendering every template. */
const LINT_SLOTS: Record<string, string> = {
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

function facts(overrides: Partial<NarratorFacts> = {}): NarratorFacts {
  return { suppressions: [], usualNotes: [], degradedPool: false, ...overrides };
}

describe('L1 catalog is linter-clean', () => {
  for (const key of Object.keys(CATALOG) as CatalogKey[]) {
    it(`template "${key}" passes the K5 linter`, () => {
      expect(lint(renderTemplate(key, LINT_SLOTS))).toEqual({ ok: true });
    });
  }

  for (const [driver, phrase] of Object.entries(DRIVER_PHRASES)) {
    it(`driver phrase for ${driver} passes the K5 linter`, () => {
      expect(lint(phrase)).toEqual({ ok: true });
    });
  }

  it('renderTemplate throws on a missing slot rather than emitting a half-rendered card', () => {
    expect(() => renderTemplate('reason_cohort_cited', { pick: 'X' })).toThrow(
      /missing slot "driverPhrase"/,
    );
  });
});

describe('L1 template narrator', () => {
  const narrator = new TemplateNarrator();

  it('same inputs produce byte-identical copy across runs and instances', async () => {
    const input = facts({
      citation: { driver: 'spice_tolerance_low', k: 6 },
      poolClaim: 'Hygiene complaints under-predict loyalty here.',
      suppressions: [{ dishId: 'shoyu_ramen', reasonKey: 'eaten_twice_recently' }],
      usualNotes: ['The counter seat you always take.'],
    });
    const first = await narrator.write(ranked(), input);
    const second = await narrator.write(ranked(), input);
    const third = await new TemplateNarrator().write(ranked(), input);
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('never cites a cohort below KFLOOR — the floor holds on the template path too', async () => {
    const copy = await narrator.write(ranked(), facts({ citation: { driver: 'budget_ceiling', k: 2 } }));
    expect(copy.reasonLine).not.toContain('2 of them');
    expect(copy.reasonLine).not.toContain('budget ceiling');
    // Falls through to the plain variant rather than citing a cohort of two.
    expect(copy.reasonLine).toContain('a quiet fit');
  });

  it('cites the cohort by phrase and count, never the enum token', async () => {
    const copy = await narrator.write(ranked(), facts({ citation: { driver: 'spice_tolerance_low', k: 6 } }));
    expect(copy.reasonLine).toContain('6');
    expect(copy.reasonLine).toContain('your real spice tolerance');
    expect(copy.reasonLine).not.toContain('spice_tolerance_low');
  });

  it('leads with the induced claim when both claim and citation exist', async () => {
    const copy = await narrator.write(
      ranked(),
      facts({
        citation: { driver: 'gi_constraint', k: 5 },
        poolClaim: 'Hygiene complaints under-predict loyalty here.',
      }),
    );
    expect(copy.reasonLine.startsWith('Hygiene complaints')).toBe(true);
    expect(copy.reasonLine).toContain('5 people');
  });

  it('renders the first-teller line on a cohort miss', async () => {
    const copy = await narrator.write(ranked(), facts({ cohortMiss: { driver: 'crowd_aversion' } }));
    expect(copy.cohortMissLine).toBe(CATALOG.cohort_miss);
  });

  it("renders K3's eaten_twice_recently rotation line with the dish named", async () => {
    const copy = await narrator.write(
      ranked(),
      facts({ suppressions: [{ dishId: 'shoyu_ramen', reasonKey: 'eaten_twice_recently' }] }),
    );
    expect(copy.rotationLine).toBe('Not shoyu ramen — twice this week already, and you turn on it by the third.');
  });

  it('an unknown reason key falls back to the generic rotation line instead of throwing', async () => {
    const copy = await narrator.write(
      ranked(),
      facts({ suppressions: [{ dishId: 'pho', reasonKey: 'some_future_reason' }] }),
    );
    expect(copy.rotationLine).toBe('Not pho — too soon, by your own pattern.');
  });

  it('appends the degraded-pool disclosure from the catalog', async () => {
    const copy = await narrator.write(ranked(), facts({ degradedPool: true }));
    expect(copy.reasonLine.endsWith(CATALOG.degraded_pool)).toBe(true);
  });

  it('renders usual-note KEYS into prose, never the key itself', async () => {
    // The test this replaces fed prose into usualNotes and asserted it came back
    // verbatim. The Ask engine only ever puts KEYS there, so the old test passed while
    // the real integration put `spice_tolerance_low` on the card.
    const copy = await narrator.write(
      ranked(),
      facts({ usualNotes: ['spice_tolerance_low', 'portion_small'] }),
    );
    expect(copy.usualLine).toBe('Nothing that fights back and small plates.');
    expect(copy.usualLine).not.toContain('_');
  });

  it('renders a phrase for every key in the engine vocabulary', () => {
    // Record<UsualNoteKey, string> already makes a missing phrase a compile error; this
    // catches the other half — a phrase that is present but is just the key echoed back.
    for (const key of USUAL_NOTE_KEYS) {
      const line = usualLineFor([key]);
      expect(line).toBeDefined();
      expect(line).not.toContain(key);
    }
  });

  it('omits the usual line rather than emitting an unknown key', async () => {
    const copy = await narrator.write(ranked(), facts({ usualNotes: ['not_a_real_key'] }));
    expect(copy.usualLine).toBeUndefined();
  });

  it('never lets a raw key reach any card line', async () => {
    // The invariant the defect broke: an underscore in user-facing copy means an
    // identifier escaped. Checked across every line the narrator can produce.
    const copy = await templateNarrator.write(
      ranked(),
      facts({
        citation: { driver: 'budget_ceiling', k: 7 },
        suppressions: [{ dishId: 'al_pastor', reasonKey: 'eaten_twice_recently' }],
        usualNotes: [...USUAL_NOTE_KEYS],
        degradedPool: true,
      }),
    );
    for (const line of [copy.reasonLine, copy.rotationLine, copy.usualLine, copy.cohortMissLine]) {
      if (line === undefined) continue;
      expect(line).not.toMatch(/[a-z]_[a-z]/);
    }
  });

  it('does not select the induced template for an empty claim', async () => {
    // Independent of the engine's own guard: '' must never produce " X is where that
    // leads tonight." — a sentence that opens with a space and has no antecedent.
    for (const empty of ['', '  ']) {
      const copy = await narrator.write(ranked(), facts({ poolClaim: empty }));
      expect(copy.reasonLine.startsWith(' ')).toBe(false);
      expect(copy.reasonLine).not.toContain('that leads');
    }
  });

  it('still writes a reason line with an empty ranking', async () => {
    const copy = await narrator.write([], facts());
    expect(copy.reasonLine.length).toBeGreaterThan(0);
    expect(lint(copy.reasonLine)).toEqual({ ok: true });
  });

  it('every produced line in a fully-loaded card passes the K5 linter', async () => {
    const copy = await templateNarrator.write(
      ranked(),
      facts({
        citation: { driver: 'budget_ceiling', k: 7 },
        poolClaim: 'The lunch menu is the honest menu here.',
        cohortMiss: { driver: 'sensory_shift' },
        suppressions: [{ dishId: 'al_pastor', reasonKey: 'eaten_twice_recently' }],
        usualNotes: ['portion_small', 'solo_comfortable'],
        degradedPool: true,
      }),
    );
    const lines = [copy.reasonLine, copy.rotationLine, copy.usualLine, copy.cohortMissLine];
    for (const line of lines) {
      if (line === undefined) throw new Error('expected every line to be present');
      expect(lint(line)).toEqual({ ok: true });
    }
  });
});

describe('the usual-line phrases are linted too', () => {
  it('passes every phrase through K5', () => {
    // Defect SL-21: these ten strings are user-facing card copy but sit outside CATALOG,
    // so G3's catalog sweep never reached them — the same blind spot SL-02 described,
    // re-created by the fix for SL-01. `weight` and `portion control` are in the banned
    // lexicon and a budget or portion phrase is exactly where they would appear.
    for (const [key, phrase] of Object.entries(USUAL_PHRASES)) {
      expect(lint(phrase), `${key}: ${phrase}`).toEqual({ ok: true });
    }
  });

  it('ignores inherited object keys rather than indexing a function out of the prototype', () => {
    // Defect SL-18: the filter used `note in USUAL_PHRASES`, and `in` walks the prototype
    // chain — 'toString' passed it, then threw on .charAt; a mixed array printed
    // "function toString() { [native code] }" onto a card.
    for (const hostile of ['toString', 'constructor', 'valueOf', '__proto__', 'hasOwnProperty']) {
      expect(usualLineFor([hostile])).toBeUndefined();
    }
    expect(usualLineFor(['portion_small', 'toString'])).toBe('Small plates.');
  });
});
