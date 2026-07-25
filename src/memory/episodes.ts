/**
 * Getting an episode out of a non-deterministic search (M13).
 *
 * ## What was measured
 *
 * The pool and personal claims both need an EPISODE — the cross-record synthesis — and both
 * asked for one by sending `top_k` and `episode_slots`. Probed live against a scope holding
 * 220 seeded reads, seven parameter combinations, one query:
 *
 * ```
 * top_k=40 episode_slots=4   13 rows, 3 episodes, first episode at index 10
 * no episode_slots           13 rows, 3 episodes, first episode at index 10
 * episode_slots=0            13 rows, 3 episodes, first episode at index 10
 * episode_slots=99           13 rows, 3 episodes, first episode at index 10
 * top_k=5  episode_slots=4   13 rows, 3 episodes, first episode at index 10
 * top_k=1  episode_slots=1   13 rows, 3 episodes, first episode at index 10
 * ```
 *
 * **Neither parameter is honoured.** `top_k=1` returns thirteen rows. `episode_slots=0` and
 * `episode_slots=99` are indistinguishable. `limit`, `size`, `max_results`, `n`, `per_page` and
 * every type/kind filter tried are inert too, and all of them return `200` — which is the R3
 * hazard in the operational guide, arriving on the parameter the code was relying on most.
 *
 * So `PERSONAL_TOP_K = 40` never carried a guarantee. There is no truncation to have headroom
 * against, and there is no way to ask the server for more episodes.
 *
 * ## The second measurement, which is the useful one
 *
 * The same request repeated six times:
 *
 * ```
 * 13/3E  13/3E  11/2E  13/3E  13/3E  11/2E
 * ```
 *
 * **The search is non-deterministic.** That is normally bad news, and here it is the lever: a
 * call that returns no episode is not proof the scope holds none. Retrying is not superstition
 * or a workaround for a flake — it samples a distribution the substrate genuinely has, and it
 * is the only client-side reservation available once the parameters turn out to be inert.
 *
 * So: ask, and if no episode comes back, ask again — bounded, and logged so a thin claim is
 * attributable rather than mysterious. Facts are never retried for, because a scope with facts
 * and no episodes is a real state (one confession cannot be synthesised across anything) and
 * by the product owner's ruling there is no floor to reach.
 *
 * The parameters are still sent. They cost nothing, they are what the API documents, and if
 * the server starts honouring them the behaviour improves rather than breaking. What changed is
 * that nothing DEPENDS on them any more.
 */

import type { MemoryClient } from '../contracts/modules.js';
import type { MemoryRow } from '../contracts/types.js';
import type { Logger } from '../config/logger.js';

/**
 * Attempts at getting an episode, including the first.
 *
 * Three, not one and not ten. One is the defect. The measured miss rate on a populated scope
 * was 0 in 6, so a second attempt already covers a scope that is merely thin; a third is for
 * the tail. Beyond that the cost is real (each is a live search) and the conclusion is the
 * same — a scope that returns no episode three times over does not have one worth citing.
 */
export const EPISODE_ATTEMPTS = 3;

/** Wide enough that truncation is not the reason an episode is missing — see the head note. */
export const SEARCH_TOP_K = 40;
export const SEARCH_EPISODE_SLOTS = 4;

export interface EpisodeSearch {
  client: MemoryClient;
  logger: Logger;
  /** Names the caller in log lines, so a thin claim is attributable to a tier. */
  label: string;
}

/**
 * The rows behind one claim: every episode found, and how many facts came with them.
 *
 * Returns episodes rather than a single claim so the caller decides what to do with several —
 * the pool takes the first, and a future caller might merge.
 */
export interface EpisodeResult {
  episodes: MemoryRow[];
  /** How many fact rows came back — kept as a count because the logs report it as one. */
  facts: number;
  /**
   * The fact rows themselves (D-14).
   *
   * A fact is one sentence the extractor lifted from one confession; an episode is the
   * synthesis across several. The card wants the episode. AFFINITY wants both, and mostly the
   * facts: measured, a profile's episode was "a candid admission of a recurring pattern" — a
   * true summary that named none of the four cuisines the diner had actually talked about, so
   * scoring on the episode alone silently discarded what they said.
   */
  factRows: MemoryRow[];
  attempts: number;
}

export async function searchForEpisodes(
  deps: EpisodeSearch,
  scope: string,
  query: string,
): Promise<EpisodeResult> {
  let facts = 0;
  let factRows: MemoryRow[] = [];
  for (let attempt = 1; attempt <= EPISODE_ATTEMPTS; attempt++) {
    const rows = await deps.client.search(scope, query, {
      topK: SEARCH_TOP_K,
      episodeSlots: SEARCH_EPISODE_SLOTS,
    });
    const episodes = rows.filter((row) => row.kind === 'episode' && row.content !== '');
    facts = rows.length - episodes.length;
    // Captured on EVERY attempt, not only the one that found an episode: a pass that returned
    // facts and no episode still saw the diner's sentences, and affinity wants them even when
    // the card gets no claim (D-14).
    factRows = rows.filter((row) => row.kind !== 'episode' && row.content !== '');
    if (episodes.length > 0) {
      if (attempt > 1) {
        deps.logger.line(
          `${deps.label}: found an episode on attempt ${String(attempt)} of ` +
            `${String(EPISODE_ATTEMPTS)} — the search is non-deterministic, so an empty first ` +
            `answer is not an empty scope (M13)`,
        );
      }
      return { episodes, facts, factRows, attempts: attempt };
    }
  }
  deps.logger.line(
    `${deps.label}: no episode after ${String(EPISODE_ATTEMPTS)} attempts over ` +
      `${String(facts)} fact(s) — the scope has nothing synthesised across records yet`,
  );
  return { episodes: [], facts, factRows, attempts: EPISODE_ATTEMPTS };
}
