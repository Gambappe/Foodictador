/**
 * Copy linter (K5). Pure kernel: no I/O, no clock.
 *
 * Scans user-facing copy for the banned lexicon (design v0.8 §9). Every card
 * and nudge string passes through here before render; G3 regresses the whole
 * L1 catalog through it in CI, one case per lexicon entry.
 */

import { BANNED_LEXICON } from './lexicon.js';

export type LintResult = { ok: true } | { ok: false; hits: string[] };

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Word-boundary match with common inflections, so "3-day streak", "dieting",
 * "guilt-free" and "portion-controlled" (doubled final consonant) all fire
 * while "underscored" and "dietary" do not. Multi-word terms match across a
 * space or a hyphen.
 */
function termPattern(term: string): RegExp {
  const flexible = escapeRegExp(term).replace(/ /g, '[ -]');
  const lastChar = term.slice(-1);
  const doubled = /[a-z]/.test(lastChar) ? `${escapeRegExp(lastChar)}?` : '';
  return new RegExp(`\\b${flexible}(?:${doubled}(?:s|es|ed|ing|y))?\\b`, 'iu');
}

const PATTERNS = BANNED_LEXICON.map((term) => ({ term, pattern: termPattern(term) }));

/** `hits` names every lexicon term that fired, so a violation is actionable. */
export function lint(text: string): LintResult {
  const hits = PATTERNS.filter(({ pattern }) => pattern.test(text)).map(({ term }) => term);
  return hits.length === 0 ? { ok: true } : { ok: false, hits };
}
