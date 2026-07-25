import type { AskEngine, AskInput } from '../modules.js';
import type { Card } from '../types.js';
import { StubCohorts, driversForUsual } from './cohorts.js';

/**
 * Deterministic fixture card: first corpus place wins, next two are runners-up.
 * Exists so every front end renders something sensible before K4/L-lane land.
 */
export class StubAskEngine implements AskEngine {
  private readonly cohorts = new StubCohorts();

  ask(input: AskInput): Card {
    const [pick, ...rest] = input.corpus;
    if (!pick) throw new Error('stub ask engine needs a non-empty corpus');
    const matched = this.cohorts.matched(input.usual, input.reads);
    const scores: Record<string, number> = {};
    input.corpus.forEach((place, i) => {
      scores[place.id] = Number((0.52 - i * 0.01).toFixed(4));
    });
    const citation = matched[0];
    const card: Card = {
      pick,
      reasonLine: citation
        ? `Skipping the obvious picks — people who share ${citation.driver.replaceAll('_', ' ')} steered us here, ${citation.k} strong.`
        : `A quiet pattern in the pot points at ${pick.name}.`,
      runnersUp: rest.slice(0, 2).map((place, i) => ({ place, score: 0.51 - i * 0.02 })),
      scores,
    };
    if (citation) {
      card.poolCitation = { driver: citation.driver, k: citation.k };
    } else {
      const firstWanted = driversForUsual(input.usual)[0];
      if (firstWanted) card.cohortMiss = { driver: firstWanted };
    }
    if (input.degradedPool === true) card.degradedPool = true;
    return card;
  }
}
