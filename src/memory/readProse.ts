/**
 * Rendering a read as English, for the induction feed (M14).
 *
 * XTrace extracts prose. It does not store payloads. So the pool ingest's job is not to
 * preserve a read — the relay does that under DAG §4 D-7 — but to give the extractor
 * something worth extracting from. The operational guide's R4 is explicit: *"Prose, not
 * notation. Structured notation extracted 0 facts from 8 complete records. Render
 * structured data to sentences first."*
 *
 * Before D-7 this was impossible: the pool ingest had to be `JSON.stringify(read)` because
 * `readsForDriver` parsed it back out. D-7 deleted that path, so the payload is free and
 * nothing downstream depends on its shape.
 *
 * **Measured, not assumed.** Twelve reads through the live API in three configurations, the
 * induction query being the one `confit ask` actually issues:
 *
 * | configuration | distinct places in one claim | texts leaking a raw id |
 * | --- | --- | --- |
 * | one POST per read, JSON (before) | 2 | 12 |
 * | batched into one conversation, JSON | 4 | 3 |
 * | batched into one conversation, **prose** | 4 | **0** |
 *
 * Two separate effects, which is why M12 and M14 ship together. Batching is what produces a
 * claim spanning several people's reads at all — ungrouped, the episode says *"The session
 * consisted of a single structured signal about Harbor Greens"*, a paraphrase of one read
 * wearing a crowd's clothes. Prose is what stops `spice_tolerance_low` and
 * `regret_after_order` coming back out and landing on a card (defect L4, since nothing lints
 * the induced claim).
 *
 * ## Three constraints on every sentence here
 *
 * 1. **Third person, plural-ish, never second.** `DRIVER_PHRASES` in the L1 catalog says
 *    "your real spice tolerance" because it addresses the diner. This text describes
 *    *strangers* to an extractor, and a claim synthesised from "your" sentences comes back
 *    addressing the reader about other people's meals.
 * 2. **Place NAMES, not ids.** The measurement above is entirely about this: feed
 *    `rosas_taqueria` and the induced claim contains `rosas_taqueria`.
 * 3. **Clean under K5's lexicon.** Whatever goes in can come back out onto a card, so this
 *    copy is held to the same bar as the catalog. `readProse.test.ts` lints every possible
 *    sentence, which is finite: signals × drivers × cadences.
 */

import { CADENCES, DRIVERS, SIGNALS, type Cadence, type Driver, type Read, type Signal } from '../contracts/types.js';

/** What the diner did, third person. */
const SIGNAL_PROSE: Record<Signal, string> = {
  regret_after_order: 'regretted the order afterwards',
  never_ordered_again: 'never ordered that again',
  returns_despite_incident: 'went back anyway after something went wrong',
  pretends_preference: 'said they loved it when they did not',
  secret_default: 'quietly orders the same thing every time',
  trusted_safe_place: 'treats the place as the safe choice',
  wanted_something_else: 'wanted something else and ordered this instead',
};

/** Why, third person. Deliberately NOT the catalog's second-person `DRIVER_PHRASES`. */
const DRIVER_PROSE: Record<Driver, string> = {
  spice_tolerance_low: 'their real tolerance for heat is lower than they let on',
  budget_ceiling: 'there is a ceiling on what they will spend that they do not mention',
  portion_small: 'they want a smaller plate than they are given',
  solo_comfort: 'they are eating alone and would rather that went unremarked',
  gi_constraint: 'their stomach decides the menu',
  // NOT "genuinely unsafe" (D-9). This prose is fed to an extractor and can come back as an
  // induced claim on a card — measured live: "a repeated pattern in which people's ordering
  // behavior was explained by something on the menu being genuinely unsafe". Confit does not
  // screen allergens, so a card must never sound as though it knows what is safe to eat.
  // Describes the avoidance, asserts nothing about safety.
  allergy_constraint: 'there is something on the menu they have to avoid',
  sensory_shift: 'what tasted right to them has changed',
  companion_constraint: 'they were ordering around someone else at the table',
  emotional_exclusion: 'the place carries something they would rather not revisit',
  acclaim_skeptic: 'they do not trust what the place is praised for',
  crowd_aversion: 'the room being full is the problem, not the food',
};

/** How often, as a phrase that reads inside a sentence. */
const CADENCE_PROSE: Record<Cadence, string> = {
  once: 'went once',
  rarely: 'rarely goes',
  monthly: 'goes about monthly',
  weekly: 'goes most weeks',
  daily: 'goes most days',
};

/**
 * `place` is an id by contract; the extractor must never see one. A lookup that misses is a
 * corpus/pool disagreement, so the caller decides what to do — this module will not quietly
 * substitute the id and undo the whole point of the file.
 */
export type PlaceName = (placeId: string) => string | undefined;

/** Builds a lookup from a corpus. Kept here so callers do not each re-derive it. */
export function placeNames(corpus: readonly { id: string; name: string }[]): PlaceName {
  const byId = new Map(corpus.map((place) => [place.id, place.name]));
  return (placeId) => byId.get(placeId);
}

/**
 * One read, one sentence pair. Returns `null` when the place is unknown, because emitting the
 * id would put it back on the card via the induced claim.
 */
export function readToProse(read: Read, placeName: PlaceName): string | null {
  const name = placeName(read.place);
  if (name === undefined || name === '') return null;
  return (
    `Someone who ${CADENCE_PROSE[read.cadence]} to ${name} ${SIGNAL_PROSE[read.signal]}. ` +
    `What is really going on is that ${DRIVER_PROSE[read.driver]}.`
  );
}

/** Every sentence this module can emit, for the copy linter to walk. Finite by construction. */
export function everyProseSentence(): string[] {
  const out: string[] = [];
  for (const signal of SIGNALS) {
    for (const driver of DRIVERS) {
      for (const cadence of CADENCES) {
        const sentence = readToProse(
          {
            read_id: '00000000-0000-4000-8000-000000000000',
            place: 'p',
            signal,
            driver,
            cadence,
            weight: 0.5,
          },
          () => 'The Quiet Counter',
        );
        if (sentence !== null) out.push(sentence);
      }
    }
  }
  return out;
}
