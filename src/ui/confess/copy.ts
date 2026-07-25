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

/**
 * What off-limits does NOT do (D-9). Shown with the refusal, because that is the moment a
 * user learns the feature exists and decides what it covers. "Off-limits" plus a free-text
 * box reads as "keep me away from this"; it gates RECORDING. Confit does not screen menus —
 * the corpus carries six place tags and none is an allergen — so the copy says so rather
 * than leaving a safety-shaped silence.
 */
export const REFUSAL_SCOPE =
  'Off-limits controls what Confit writes down, not where it sends you. Confit does not ' +
  'check menus for allergens.';

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

/**
 * The `your memory` receipt, which has THREE states rather than two (M20).
 *
 * A confession is buffered locally until several can share one ingest call, so at the moment
 * this renders it may be on this device and not in XTrace. Rendering that as "written" is the
 * same defect as `forget` printing "Deleted from Confit" over two skipped targets — the
 * product describing an outcome it did not have. D-10 named this consequence explicitly:
 * deferral is not loss, but the receipt has to say which it is.
 */
export const MEMORY_RECEIPT = {
  sent: 'written',
  held: 'held on this device until a few of yours can be sent together',
  /** Safe, but this screen's own action did not send it — see SL-49. */
  handedOff: 'written, alongside another confession being sent at the same time',
  failed: 'not written',
} as const;
