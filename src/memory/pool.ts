/**
 * PoolStore (M2) — the XTrace side of the collective pool at
 * `user_id: "confit:pool"`. **Induction only, under DAG §4 D-7.**
 *
 * The counting query used to live here. It is gone, and its absence is the
 * point: gate zero ingested one read and got back five prose facts
 * ("User's place is rosas_taqueria.") with nothing joining them, and no query —
 * not by read_id, not by place — returned the object that went in. A
 * `readsForDriver` on this store could only ever return an empty array while
 * looking like it worked, which is worse than not existing. Counting reads the
 * relay now (M6).
 *
 * What is left is the query XTrace is measurably good at ([E22], design v0.8
 * §8): synthesis across records it derived itself.
 */

import type { MemoryClient, PoolStore } from '../contracts/modules.js';
import type { JobHandle, Read } from '../contracts/types.js';
import type { Logger } from '../config/logger.js';

export const POOL_SCOPE = 'confit:pool';

/** Induction reads episodes — the cross-record synthesis lives there (§14). */
const INDUCTION_TOP_K = 12;
const INDUCTION_EPISODE_SLOTS = 4;

export interface PoolStoreDeps {
  client: MemoryClient;
  logger: Logger;
}

export function createPoolStore(deps: PoolStoreDeps): PoolStore {
  return {
    async writeRead(read: Read): Promise<JobHandle> {
      // The six fields go in as JSON and come out as prose about them. That is
      // the substrate's behaviour, not a defect to route around — the extracted
      // facts are what `inducedClaim` synthesises over. The read itself is kept
      // verbatim by the relay (D-7); this write is the induction feed.
      return deps.client.ingest(POOL_SCOPE, JSON.stringify(read));
    },

    async inducedClaim(query: string): Promise<string> {
      const rows = await deps.client.search(POOL_SCOPE, query, {
        topK: INDUCTION_TOP_K,
        episodeSlots: INDUCTION_EPISODE_SLOTS,
      });
      // Prefer the episode — that is the induced relationship; a bare fact is
      // just one read. An empty string means "no claim", never a crash.
      const episode = rows.find((row) => row.kind === 'episode' && row.content !== '');
      if (episode) return episode.content;
      return '';
    },
  };
}
