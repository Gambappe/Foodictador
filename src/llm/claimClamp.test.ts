import { describe, expect, it } from 'vitest';

import {
  CLAIM_CHAR_BUDGET,
  CLAIM_HARD_MAX,
  CLAIM_SENTENCE_BUDGET,
  clampClaim,
  splitSentences,
} from './claimClamp.js';

// The measured L5 shape: episode-register framing around substantive synthesis.
const LEAKY =
  'The conversation centered on repeated dining signals across several venues. ' +
  'People who keep a low spice tolerance quietly settle at Noodle Shrine and Harbor Greens. ' +
  'Regret clusters where the room is loud rather than where the food is wrong. ' +
  'The session ended by reinforcing the pattern across seventeen places.';

describe('L5 clampClaim — selection, never paraphrase', () => {
  it('keeps at most two sentences, drops the episode register, preserves order', () => {
    const out = clampClaim(LEAKY);
    expect(out).toBe(
      'People who keep a low spice tolerance quietly settle at Noodle Shrine and Harbor Greens. ' +
        'Regret clusters where the room is loud rather than where the food is wrong.',
    );
  });

  it('every output sentence is verbatim from the input — nothing is reworded', () => {
    const out = clampClaim(LEAKY);
    for (const sentence of splitSentences(out)) {
      expect(LEAKY).toContain(sentence);
    }
  });

  it('a short claim passes through untouched', () => {
    const short = 'Hygiene complaints under-predict loyalty here.';
    expect(clampClaim(short)).toBe(short);
  });

  it('an all-register claim survives thin rather than dying', () => {
    const register = 'The session consisted of a single structured signal about Harbor Greens.';
    expect(clampClaim(register)).toBe(register);
  });

  it('the character budget stops the second sentence', () => {
    const first = `People settle where the counter faces the kitchen and nobody asks questions${'!'.repeat(1)}`;
    const second = `${'Loyalty compounds quietly in rooms like that and the pattern holds across every venue measured this month'}.`;
    const padded = `${first} ${second} A third sentence never survives.`;
    const out = clampClaim(padded);
    expect(splitSentences(out).length).toBeLessThanOrEqual(CLAIM_SENTENCE_BUDGET);
    expect(out.length).toBeLessThanOrEqual(Math.max(first.length, CLAIM_CHAR_BUDGET));
  });

  it('a first sentence over the hard cap drops the claim — no mid-sentence cuts, ever', () => {
    const run = `People regret ${Array.from({ length: 40 }, (_, i) => `venue number ${String(i)}`).join(', ')} and everything in between.`;
    expect(run.length).toBeGreaterThan(CLAIM_HARD_MAX);
    expect(clampClaim(run)).toBe('');
    expect(clampClaim('')).toBe('');
  });

  it('the seventeen-place paragraph comes out at most two sentences', () => {
    const paragraph = `${LEAKY} ${LEAKY} ${LEAKY}`;
    const out = clampClaim(paragraph);
    expect(splitSentences(out).length).toBeLessThanOrEqual(2);
    expect(out.length).toBeLessThanOrEqual(CLAIM_CHAR_BUDGET + CLAIM_HARD_MAX);
  });
});
