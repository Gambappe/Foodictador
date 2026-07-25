/**
 * PoolStore (M2) — the collective pool at `user_id: "confit:pool"`.
 *
 * Counting and induction are separate queries on purpose ([E22]): counting
 * missed members renders a qualifying cohort as a cohort-miss on stage, so
 * `readsForDriver` is scoped to one driver with k = COUNTING_K (far above any
 * real cohort), while `inducedClaim` stays top-k because induction does not
 * need every row.
 *
 * A read is written as its own six-field JSON with `read_id` embedded in the
 * record content, so M7's fallback verification can find an entry whose
 * `setJob` annotation never landed (DAG §4 D-1).
 */

import type { MemoryClient, PoolStore } from '../contracts/modules.js';
import type { Driver, JobHandle, MemoryRow, Read } from '../contracts/types.js';
import type { Logger } from '../config/logger.js';
import { COUNTING_K } from '../kernel/constants.js';
import { parseRead } from '../kernel/read.js';

export const POOL_SCOPE = 'confit:pool';

/** Induction reads episodes — the cross-record synthesis lives there (§14). */
const INDUCTION_TOP_K = 12;
const INDUCTION_EPISODE_SLOTS = 4;

export interface PoolStoreDeps {
  client: MemoryClient;
  logger: Logger;
}

function parsePoolRow(row: MemoryRow, logger: Logger): Read | null {
  let raw: unknown;
  try {
    raw = JSON.parse(row.content);
  } catch {
    logger.line(`pool: skipping malformed row ${row.memoryId}: content is not JSON`);
    return null;
  }
  try {
    return parseRead(raw);
  } catch (error) {
    // A malformed substrate row must never crash the Ask — skip it, say so.
    logger.line(
      `pool: skipping malformed row ${row.memoryId}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

export function createPoolStore(deps: PoolStoreDeps): PoolStore {
  return {
    async writeRead(read: Read): Promise<JobHandle> {
      // The content is the read itself — six fields, read_id included, exactly
      // what readsForDriver parses back out and what M7 re-verifies against.
      return deps.client.ingest(POOL_SCOPE, JSON.stringify(read));
    },

    async readsForDriver(driver: Driver, opts?: { k?: number }): Promise<Read[]> {
      const rows = await deps.client.search(POOL_SCOPE, driver, {
        topK: opts?.k ?? COUNTING_K,
        // Counting wants the raw records, not synthesis — the reservation is
        // explicit (the type requires it) and explicitly zero.
        episodeSlots: 0,
      });
      const reads: Read[] = [];
      for (const row of rows) {
        const read = parsePoolRow(row, deps.logger);
        // Semantic search is fuzzy; the driver scope is only real if enforced
        // here. A read for another driver is off-scope, not malformed.
        if (read !== null && read.driver === driver) reads.push(read);
      }
      return reads;
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
