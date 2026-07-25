/**
 * Banned lexicon (K5). Data only — logic lives in copylint.ts, so lane G can
 * extend this list without touching the linter.
 *
 * Design v0.8 §9: the product never comments on quantity, weight, calories or
 * "progress", and contains no streak, score or daily total anywhere. This list
 * is the union of that vocabulary and plan v1.0 §9's linter list. Multi-word
 * entries match across spaces or hyphens ("portion control" fires on
 * "portion-controlled" too).
 */
export const BANNED_LEXICON = [
  'calorie',
  'kcal',
  'weight',
  'diet',
  'burn',
  'cheat',
  'guilt',
  'streak',
  'score',
  'points',
  'goal',
  'progress',
  'quantity',
  'portion control',
  'daily total',
  'skinny',
] as const;

export type BannedTerm = (typeof BANNED_LEXICON)[number];
