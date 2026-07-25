import { describe, expect, it } from 'vitest';

import { CADENCES, DRIVERS, SIGNALS, type Read } from '../contracts/types.js';
import { lint } from '../kernel/copylint.js';
import { everyProseSentence, placeNames, readToProse } from './readProse.js';

const CORPUS = [
  { id: 'rosas_taqueria', name: "Rosa's Taqueria" },
  { id: 'quiet_counter', name: 'The Quiet Counter' },
];
const names = placeNames(CORPUS);

function read(over: Partial<Read> = {}): Read {
  return {
    read_id: '00000000-0000-4000-8000-00000000feed',
    place: 'rosas_taqueria',
    signal: 'regret_after_order',
    driver: 'spice_tolerance_low',
    cadence: 'weekly',
    weight: 0.8,
    ...over,
  };
}

describe('readToProse', () => {
  it('renders a read as two English sentences naming the place', () => {
    expect(readToProse(read(), names)).toBe(
      "Someone who goes most weeks to Rosa's Taqueria regretted the order afterwards. " +
        'What is really going on is that their real tolerance for heat is lower than they let on.',
    );
  });

  it('never emits a place id, a read_id, or a weight', () => {
    // The measured failure: feed the extractor `rosas_taqueria` and the induced claim
    // comes back carrying `rosas_taqueria`, which lands on a card (L4). The read_id and
    // the weight are simply of no use to induction, and the read_id identifies the read.
    const sentence = readToProse(read(), names) ?? '';
    expect(sentence).not.toContain('rosas_taqueria');
    expect(sentence).not.toContain('00000000-0000-4000-8000-00000000feed');
    expect(sentence).not.toContain('0.8');
  });

  it('returns null for an unknown place rather than falling back to the id', () => {
    // Falling back would silently undo the point of the module, everywhere at once.
    expect(readToProse(read({ place: 'not_in_corpus' }), names)).toBeNull();
    expect(readToProse(read(), () => '')).toBeNull();
    expect(readToProse(read(), () => undefined)).toBeNull();
  });

  it('has a phrase for every enum value — no combination renders undefined', () => {
    // `Record<Signal, string>` makes a missing key a type error, but a typo in a VALUE is
    // invisible to the compiler, and an unrendered enum arrives as the literal word
    // "undefined" in a sentence handed to an extractor.
    for (const signal of SIGNALS) {
      for (const driver of DRIVERS) {
        for (const cadence of CADENCES) {
          const sentence = readToProse(read({ signal, driver, cadence }), names);
          expect(sentence, `${signal}/${driver}/${cadence}`).not.toBeNull();
          expect(sentence, `${signal}/${driver}/${cadence}`).not.toContain('undefined');
        }
      }
    }
  });
});

describe('every sentence this module can emit', () => {
  const sentences = everyProseSentence();

  it('covers the whole enum product', () => {
    expect(sentences).toHaveLength(SIGNALS.length * DRIVERS.length * CADENCES.length);
  });

  it('passes K5\'s copy linter, because it can come back out onto a card', () => {
    // Whatever goes into the pool can be synthesised into the induced claim, and nothing
    // lints that claim on the way out (L4). So this copy is held to the catalog's bar on
    // the way IN — the one place we control.
    const failures: string[] = [];
    for (const sentence of sentences) {
      const result = lint(sentence);
      // Narrowed rather than cast: `hits` only exists on the failing arm of LintResult.
      if (!result.ok) failures.push(`${result.hits.join(',')} in "${sentence}"`);
    }
    expect(failures).toEqual([]);
  });

  it('carries no enum token in any sentence', () => {
    for (const sentence of sentences) {
      expect(sentence, sentence).not.toMatch(/[a-z]+_[a-z]+/);
    }
  });

  it('is written in the third person, not the second', () => {
    // The L1 catalog says "your real spice tolerance" because it addresses the diner.
    // This text describes strangers TO AN EXTRACTOR; a claim synthesised from "your"
    // sentences comes back addressing the reader about other people's meals.
    for (const sentence of sentences) {
      expect(sentence, sentence).not.toMatch(/\byou\b|\byour\b|\byou're\b/i);
    }
  });

  it('reads as complete sentences', () => {
    for (const sentence of sentences) {
      expect(sentence, sentence).toMatch(/^[A-Z]/);
      expect(sentence, sentence).toMatch(/\.$/);
      expect(sentence, sentence).not.toMatch(/\s{2,}/);
    }
  });
});

describe('placeNames', () => {
  it('resolves ids it knows and returns undefined for the rest', () => {
    expect(names('quiet_counter')).toBe('The Quiet Counter');
    expect(names('nope')).toBeUndefined();
  });

  it('works against the committed corpus, so every seeded read is renderable', async () => {
    // The seed artifact and the corpus are separate files; if a read names a place the
    // corpus dropped, `writeReads` silently skips it and induction loses a read. Better to
    // learn that here than from a thinner claim on stage.
    const { loadCorpus } = await import('../../scripts/seed/validate-corpus.js');
    const { readSeedArtifact } = await import('../../scripts/seed/load-seeds.js');
    const corpusNames = placeNames(loadCorpus());
    const unrenderable = readSeedArtifact().filter((r) => readToProse(r, corpusNames) === null);
    expect(unrenderable.map((r) => r.place)).toEqual([]);
  });
});
