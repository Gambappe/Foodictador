import type { Narrator } from '../modules.js';
import type { CardCopy, NarratorFacts, RankedPlace } from '../types.js';

/** Deterministic template copy from facts alone — the `narrator: template` shape. */
export class StubNarrator implements Narrator {
  write(ranked: RankedPlace[], facts: NarratorFacts): Promise<CardCopy> {
    const pick = ranked[0];
    const name = pick ? pick.place.name : 'somewhere quiet';
    const base = facts.inducedClaim ?? `A quiet pattern in the pot points at ${name}.`;
    const copy: CardCopy = {
      reasonLine: facts.citation
        ? `${base} People who share ${facts.citation.driver.replaceAll('_', ' ')} said so — ${facts.citation.k} of them now.`
        : base,
    };
    if (facts.cohortMiss) {
      copy.cohortMissLine =
        "You're the first person to tell us this — it'll shape recommendations once a few more people do.";
    }
    const suppressed = facts.suppressions[0];
    if (suppressed) {
      copy.rotationLine = `Not ${suppressed.dishId.replaceAll('_', ' ')} — too soon, by your own pattern.`;
    }
    const usualNote = facts.usualNotes[0];
    if (usualNote !== undefined) copy.usualLine = usualNote;
    return Promise.resolve(copy);
  }
}
