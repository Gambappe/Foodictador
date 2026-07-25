import { describe, expect, it } from 'vitest';

import { lint } from './copylint.js';
import { BANNED_LEXICON, type BannedTerm } from './lexicon.js';

/** One realistic sentence per banned term — every one must be caught. */
const REALISTIC: Record<BannedTerm, string> = {
  calorie: 'That bowl is only 400 calories, a lighter choice.',
  kcal: 'Roughly 550 kcal for the set menu.',
  weight: 'A good pick if you are watching your weight this month.',
  diet: 'Fits nicely into your diet plan.',
  burn: 'A brisk walk after will burn it right off.',
  cheat: 'Save this one for your cheat day.',
  guilt: 'A guilt-free dessert to finish.',
  streak: "You're on a 3-day streak of good choices.",
  score: 'Your healthy-eating score went up today.',
  points: 'That meal is only four points.',
  goal: 'One step closer to your goal.',
  progress: 'Great progress this week — keep it up.',
  quantity: 'Try a smaller quantity next time.',
  'portion control': 'Excellent portion control tonight.',
  'daily total': 'That brings your daily total to 1,800.',
  skinny: 'The skinny option comes with a side salad.',
};

describe('K5 lint catches every banned term in a realistic sentence', () => {
  for (const term of BANNED_LEXICON) {
    it(`catches "${term}" and names it in hits`, () => {
      const result = lint(REALISTIC[term]);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.hits).toContain(term);
    });
  }

  it('catches inflections and hyphenated forms', () => {
    expect(lint('A portion-controlled plate keeps things simple.')).toEqual({
      ok: false,
      hits: ['portion control'],
    });
    expect(lint('No more dieting for me.')).toEqual({ ok: false, hits: ['diet'] });
    expect(lint('Two streaks running at once.')).toEqual({ ok: false, hits: ['streak'] });
  });
});

describe('K5 clean card copy passes', () => {
  const clean = [
    "Rosa's Taqueria — people who share your spice tolerance keep coming back. Six of them.",
    'Not ramen — twice this week already, and you turn on it by the third.',
    "You're the first person to tell us this — it'll shape recommendations once a few more people do.",
    'A quiet counter seat and the soup set. Rain outside; this is the warm answer.',
  ];
  for (const text of clean) {
    it(`passes: "${text.slice(0, 44)}…"`, () => {
      expect(lint(text)).toEqual({ ok: true });
    });
  }

  it('does not fire inside unrelated words', () => {
    // "dietary" is not "diet", "underscored" is not "score".
    expect(lint('The menu underscored its dietary range.')).toEqual({ ok: true });
  });
});

describe('K5 hits name the term that fired', () => {
  it('reports multiple distinct hits from one string', () => {
    const result = lint('A guilt-free cheat day for your streak.');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.hits).toEqual(expect.arrayContaining(['guilt', 'cheat', 'streak']));
  });
});
