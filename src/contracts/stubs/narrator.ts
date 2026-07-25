import type { Narrator } from '../modules.js';
import type { CardCopy, NarratorFacts, RankedPlace } from '../types.js';
import { KFLOOR } from '../../kernel/cohorts.js';

/** Deterministic template copy from facts alone — the `narrator: template` shape. */
export class StubNarrator implements Narrator {
  write(ranked: RankedPlace[], facts: NarratorFacts): Promise<CardCopy> {
    const pick = ranked[0];
    const name = pick ? pick.place.name : 'somewhere quiet';
    const base = facts.poolClaim ?? `A quiet pattern in the pot points at ${name}.`;
    // Sub-floor citations are never rendered, even by a stub — X2/X3 mock-start
    // against this file, so a k=2 sentence here is a k=2 sentence on a card (SL-06).
    const citation = facts.citation && facts.citation.k >= KFLOOR ? facts.citation : undefined;
    const copy: CardCopy = {
      reasonLine: citation
        ? `${base} People who share ${citation.driver.replaceAll('_', ' ')} said so — ${citation.k} of them now.`
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
