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
import { KFLOOR } from '../kernel/cohorts.js';
import { CATALOG, DRIVER_PHRASES, renderTemplate, usualLineFor } from './catalog.js';

/** Display form of a dish id — the narrator has no corpus to look names up in. */
function dishName(dishId: string): string {
  return dishId.replaceAll('_', ' ');
}

/**
 * The citation floor, enforced at the choke point every narrator path ends in:
 * live-narrator fallbacks (flag, transport failure, double rejection) all
 * delegate here, so a cohort below KFLOOR is never cited on ANY exit — not
 * just the model path (design v0.8 §7 [C4]; K6's matched() is the authoritative
 * producer, this is the last line).
 */
function flooredCitation(facts: NarratorFacts): NarratorFacts['citation'] {
  return facts.citation && facts.citation.k >= KFLOOR ? facts.citation : undefined;
}

function reasonLine(ranked: RankedPlace[], facts: NarratorFacts): string {
  const pick = ranked[0]?.place.name ?? 'Somewhere quiet';
  const claim = facts.poolClaim;
  const citation = flooredCitation(facts);

  let line: string;
  if (citation && hasText(claim)) {
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
  } else if (hasText(claim)) {
    line = renderTemplate('reason_induced', { claim, pick });
  } else {
    line = renderTemplate('reason_plain', { pick });
  }

  // The card discloses a degraded pool (§6 flags table); the disclosure copy
  // lives in the catalog so it is linted with everything else.
  if (facts.degradedPool) line = `${line} ${CATALOG.degraded_pool}`;
  return line;
}

/**
 * Present AND non-empty. M2 returns '' for "no induced claim", so a defined-check alone
 * selects the induced template for a claim that does not exist.
 */
function hasText(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== '';
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

    // Usual notes are KEYS from the Ask engine, never copy. Rendering note[0] verbatim
    // put `spice_tolerance_low` on the card for every user on the default template path.
    const usualLine = usualLineFor(facts.usualNotes);
    if (usualLine !== undefined) copy.usualLine = usualLine;

    // The personal claim gets its OWN line, not a slot in the reason line (M16). The reason
    // line explains the pick; this says something about the reader, and merging them would
    // make a claim about a person read as a justification for a restaurant.
    if (hasText(facts.personalClaim)) {
      copy.personalLine = renderTemplate('personal_pattern', { claim: facts.personalClaim });
    }

    return Promise.resolve(copy);
  }
}

export const templateNarrator: Narrator = new TemplateNarrator();
