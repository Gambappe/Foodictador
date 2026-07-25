import type { Narrator } from '../modules.js';
// The privacy floor has ONE owner (SL-06).
import { KFLOOR } from '../../kernel/cohorts.js';
import type { CardCopy, NarratorFacts, RankedPlace } from '../types.js';

/** Deterministic template copy from facts alone — the `narrator: template` shape. */
export class StubNarrator implements Narrator {
  write(ranked: RankedPlace[], facts: NarratorFacts): Promise<CardCopy> {
    const pick = ranked[0];
    const name = pick ? pick.place.name : 'somewhere quiet';
    const base = facts.poolClaim ?? `A quiet pattern in the pot points at ${name}.`;
    // Floored, like the real TemplateNarrator (SL-06). An unfloored stub renders a citation
    // for a cohort of one — and a citation IS the identification risk the floor exists to
    // stop, so a stub that skips it teaches every suite using it that k=1 is printable.
    const citable = facts.citation !== undefined && facts.citation.k >= KFLOOR;
    const copy: CardCopy = {
      reasonLine:
        citable && facts.citation
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
