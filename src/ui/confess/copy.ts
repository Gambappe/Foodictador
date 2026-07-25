/**
 * Confess-screen copy (U2).
 *
 * Not shared with X2's CLI strings, deliberately. Design v0.8 §5 asks for "something in
 * the shape of" both halves rather than one exact sentence, and a screen and a terminal
 * line legitimately word the same promise differently. What must not drift is the
 * MEANING, so the test asserts both halves are present rather than matching a string —
 * wording is free, dropping a half is not.
 *
 * Importing the CLI's constants instead would make the UI depend on the other front end;
 * the UI imports the core, not its sibling (DAG §7 U1).
 */

/** [E27]: both halves, above the button, every time. */
export const CONSENT = {
  words: 'Your words go to your private Confit memory, which Confit holds and can read.',
  fields: 'Only the five fields above enter the pot, with nothing linking them to you.',
} as const;

/**
 * The blocked-topic refusal. Plain and non-judgemental (§9), and it names all three
 * destinations because [E24]'s whole point is that off-limits means nowhere — a refusal
 * that only mentioned the pot would restate the bug the design doc fixed.
 */
export const REFUSAL =
  'That touches a topic you marked off-limits, so nothing was recorded — not the pot, ' +
  'not the relay, not your own memory.';

/** Shown when a chip is struck: the pot takes all five fields or none. */
export const STRUCK_NOTICE =
  'A struck field means there is nothing to add to the pot — the pot only ever takes all ' +
  'five together. Your words still go to your own memory.';

/**
 * Chip labels. Keys are the schema's field names; values are what a diner reads.
 *
 * `weight` is labelled **strength** (SL-28), matching X2's CLI for the same reason: the
 * read's fifth field is called `weight`, `weight` is in K5's banned lexicon because
 * design v0.8 §9 forbids the product commenting on it, and a diner reading "weight 0.8"
 * next to their own confession is exactly what §9 rules out. The field name is a schema
 * detail; it stays `weight` in the payload and never appears in the UI.
 */
export const CHIP_LABELS = {
  place: 'place',
  signal: 'signal',
  driver: 'driver',
  cadence: 'cadence',
  weight: 'strength',
} as const;
