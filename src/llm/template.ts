/**
 * Template narrator (L1) — deterministic card copy from facts alone.
 *
 * This is both the `narrator: template` degrade path (design v0.8 §6: degraded
 * copy, never a wrong pick) and the fixture the whole suite narrates with, so
 * it lands before the live narrator. Same inputs → byte-identical output; no
 * model call, no clock, no randomness. Facts only — this module never sees
 * confession prose, and every string it emits comes from the K5-linted catalog.
 */

import type { Narrator } from '../contracts/modules.js';
import type { CardCopy, NarratorFacts, RankedPlace } from '../contracts/types.js';
import { CATALOG, DRIVER_PHRASES, renderTemplate } from './catalog.js';

/** Display form of a dish id — the narrator has no corpus to look names up in. */
function dishName(dishId: string): string {
  return dishId.replaceAll('_', ' ');
}

function reasonLine(ranked: RankedPlace[], facts: NarratorFacts): string {
  const pick = ranked[0]?.place.name ?? 'Somewhere quiet';
  const claim = facts.inducedClaim;
  const citation = facts.citation;

  let line: string;
  if (citation && claim !== undefined) {
    line = renderTemplate('reason_induced_cited', {
      claim,
      pick,
      k: String(citation.k),
      driverPhrase: DRIVER_PHRASES[citation.driver],
    });
  } else if (citation) {
    line = renderTemplate('reason_cohort_cited', {
      pick,
      k: String(citation.k),
      driverPhrase: DRIVER_PHRASES[citation.driver],
    });
  } else if (claim !== undefined) {
    line = renderTemplate('reason_induced', { claim, pick });
  } else {
    line = renderTemplate('reason_plain', { pick });
  }

  // The card discloses a degraded pool (§6 flags table); the disclosure copy
  // lives in the catalog so it is linted with everything else.
  if (facts.degradedPool) line = `${line} ${CATALOG.degraded_pool}`;
  return line;
}

export class TemplateNarrator implements Narrator {
  write(ranked: RankedPlace[], facts: NarratorFacts): Promise<CardCopy> {
    const copy: CardCopy = { reasonLine: reasonLine(ranked, facts) };

    if (facts.cohortMiss) copy.cohortMissLine = CATALOG.cohort_miss;

    const suppressed = facts.suppressions[0];
    if (suppressed) {
      const slots = { dish: dishName(suppressed.dishId) };
      copy.rotationLine =
        suppressed.reasonKey === 'eaten_twice_recently'
          ? renderTemplate('rotation_eaten_twice_recently', slots)
          : renderTemplate('rotation_generic', slots);
    }

    // Usual notes arrive as already-formed facts from the Ask engine; the first
    // one is the card's usual line verbatim. G3 lints engine-produced notes.
    const usualNote = facts.usualNotes[0];
    if (usualNote !== undefined) copy.usualLine = usualNote;

    return Promise.resolve(copy);
  }
}

export const templateNarrator: Narrator = new TemplateNarrator();
