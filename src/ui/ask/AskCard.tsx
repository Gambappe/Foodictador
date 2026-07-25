/**
 * The Ask card (U3) — the one screen a judge actually reads.
 *
 * This component renders a `Card` and nothing else. It computes no scores, counts no
 * cohorts and calls no store: K4 ranked, K6 counted, L1/L3 wrote the prose, X3 assembled
 * the object. If a variant here needs a fact the `Card` does not carry, that fact belongs
 * in the kernel first (DAG §7 U1).
 *
 * Two invariants are structural rather than stylistic, and both are asserted in the tests
 * beside this file:
 *
 *  1. **A confession never reaches the DOM.** `Card` has no field carrying prose — the
 *     citation is `{driver, k}` by contract (design v0.8 §7, [E25]) — so the guarantee
 *     holds as long as this component renders only `Card` fields and never accepts free
 *     text from a caller. That is why there is no `children`, no `extra`, and no
 *     `dangerouslySetInnerHTML` anywhere in this file.
 *  2. **A cohort below KFLOOR is never cited.** X3 and both narrators already floor it;
 *     this is the last of the four places that can put a number on a screen, and the
 *     floor is cheap here (design v0.8 §7 [C4]/[E10]). A sub-floor citation renders as
 *     the cohort-miss line instead of a smaller number.
 */

import { KFLOOR } from '../../kernel/cohorts.js';
import { CATALOG, DRIVER_PHRASES } from '../../llm/catalog.js';
import type { Card } from '../../contracts/types.js';

export interface AskCardProps {
  card: Card;
}

/** The citation chip: a driver phrase and a count, never a sentence from the pool. */
function Citation({ driver, k }: { driver: string; k: number }) {
  return (
    <p
      data-testid="cohort-citation"
      className="mt-3 inline-block rounded-full bg-pot/10 px-3 py-1 text-sm text-pot"
    >
      people with {driver} · {k} of them
    </p>
  );
}

function CohortMiss() {
  return (
    <p data-testid="cohort-miss" className="mt-3 text-sm text-muted">
      {CATALOG.cohort_miss}
    </p>
  );
}

export function AskCard({ card }: AskCardProps) {
  // The floor, applied where the number would be drawn. `citable` is false for a
  // citation that should never have arrived, and the miss line stands in for it.
  const citation = card.poolCitation;
  const citable = citation !== undefined && citation.k >= KFLOOR;
  const showMiss = card.cohortMiss !== undefined || (citation !== undefined && !citable);

  return (
    <article aria-labelledby="ask-pick" className="rounded-lg border border-muted/20 p-5">
      <h1 id="ask-pick" className="text-2xl font-semibold">
        {card.pick.name}
      </h1>
      <p data-testid="reason-line" className="mt-2">
        {card.reasonLine}
      </p>

      {citable && citation ? (
        <Citation driver={DRIVER_PHRASES[citation.driver]} k={citation.k} />
      ) : null}
      {showMiss ? <CohortMiss /> : null}

      {card.rotationLine !== undefined ? (
        <p data-testid="rotation-line" className="mt-3 text-muted">
          {card.rotationLine}
        </p>
      ) : null}
      {card.usualLine !== undefined ? (
        <p data-testid="usual-line" className="mt-1 text-muted">
          {card.usualLine}
        </p>
      ) : null}
      {/*
        The user's own pattern (M16, D-8's second input). After the Usual, because both
        describe the reader and what they told us should be read before what has been
        inferred about them. The catalog frames it "From what you have told us:" — it is
        XTrace's paraphrase of an extraction of their confessions, and the verbatim text is
        not retrievable to quote, so it is attributed rather than asserted.
      */}
      {card.personalLine !== undefined ? (
        <p data-testid="personal-line" className="mt-1 text-muted">
          {card.personalLine}
        </p>
      ) : null}

      {card.degradedPool === true ? (
        <p data-testid="degraded-disclosure" className="mt-3 text-sm text-refusal">
          {CATALOG.degraded_pool}
        </p>
      ) : null}

      {card.runnersUp.length > 0 ? (
        <section aria-labelledby="runners-up-heading" className="mt-5 border-t border-muted/20 pt-3">
          <h2 id="runners-up-heading" className="text-sm font-medium text-muted">
            Also considered
          </h2>
          <ul data-testid="runners-up" className="mt-1 text-sm text-muted">
            {card.runnersUp.map((runner) => (
              <li key={runner.place.id} className="flex justify-between">
                <span>{runner.place.name}</span>
                {/* Scores shown honestly and small — plan v1.0 §7 Lane E. */}
                <span>{runner.score.toFixed(3)}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </article>
  );
}
