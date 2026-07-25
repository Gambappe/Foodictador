/**
 * Bounding substrate prose before it reaches a card (L5).
 *
 * With all three D-8 inputs live, a card's reason line was measured carrying a
 * seventeen-place, ~200-word paragraph — XTrace synthesis interpolated whole into a
 * frame design v0.8 §5 sized at four lines. Neither claim is ours to rewrite (both
 * are already extraction-then-synthesis, twice removed from anyone's words), and
 * sending them to a model to shorten would add a third layer of paraphrase — the
 * `withPersonalLine` note in narrator.ts says why that is worst exactly where drift
 * matters most. So this is SELECTION, never rewriting:
 *
 *  - sentences are kept or dropped whole, in their original relative order — an
 *    order-preserving selection, never a rewording (a dropped register sentence may
 *    sit between two kept ones, but no kept sentence is altered or reordered);
 *  - the substrate's episode register ("The conversation centered on…", "The session
 *    ended by…") reads as a transcript summary, not a recommendation — those
 *    sentences are dropped when anything substantive remains, kept when nothing does
 *    (a thin claim beats none);
 *  - the budget is two sentences and ~240 characters, whichever bites first;
 *  - a claim whose first usable sentence alone exceeds the hard cap is DROPPED, not
 *    cut mid-sentence: an ellipsis in the middle of synthesis misquotes it, and the
 *    card is built to stand without a claim (safeClaim's degrade path).
 */

export const CLAIM_SENTENCE_BUDGET = 2;
export const CLAIM_CHAR_BUDGET = 240;
/** A single sentence longer than this cannot be printed without a mid-sentence cut. */
export const CLAIM_HARD_MAX = 360;

/**
 * Transcript-summary openers measured leaking out of the substrate's episodes (L5).
 * Matched at sentence start, lowercased. Selection only — a sentence is dropped or
 * kept whole, never reworded.
 */
const EPISODE_REGISTER = [
  'the conversation',
  'the session',
  'the dialogue',
  'the exchange',
  'the discussion',
  'the messages',
  'this conversation',
  'this session',
] as const;

export function splitSentences(text: string): string[] {
  return text
    .trim()
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

function isEpisodeRegister(sentence: string): boolean {
  const lowered = sentence.toLowerCase().replace(/^["'“”]+/, '');
  return EPISODE_REGISTER.some((opener) => lowered.startsWith(opener));
}

/**
 * The claim a card may carry: an order-preserving, verbatim selection of the input's
 * sentences, register-framed ones dropped when possible, bounded by the budgets
 * above. `''` means "do not print this claim" — the same signal the substrate uses
 * for absence.
 */
export function clampClaim(claim: string): string {
  const sentences = splitSentences(claim);
  if (sentences.length === 0) return '';

  const substantive = sentences.filter((s) => !isEpisodeRegister(s));
  const candidates = substantive.length > 0 ? substantive : sentences;

  const first = candidates[0];
  if (first === undefined || first.length > CLAIM_HARD_MAX) return '';

  const taken: string[] = [first];
  let chars = first.length;
  for (const sentence of candidates.slice(1)) {
    if (taken.length >= CLAIM_SENTENCE_BUDGET) break;
    if (chars + 1 + sentence.length > CLAIM_CHAR_BUDGET) break;
    taken.push(sentence);
    chars += 1 + sentence.length;
  }
  return taken.join(' ');
}
