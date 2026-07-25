/**
 * PoolView (M6) — the read set every Ask counts.
 *
 * Under DAG §4 D-7 this is the relay, and only the relay. It used to be a union
 * of XTrace's pool and the relay, deduplicated on `read_id` ([E20]), on the
 * assumption that both sides could hand back a `Read`. Gate zero disproved half
 * of that: XTrace extracts payloads rather than storing them, so the pool half
 * of the union was always empty in production and the relay half was carrying
 * the whole thing anyway. Removing the union is not a loss of data — it is the
 * removal of a query that never returned a row.
 *
 * `degraded` therefore no longer means "counts may be incomplete". Relay counts
 * are exact. It means XTrace's induction index is unreachable, so there is no
 * induced claim to put on the card — which is exactly how `src/cli/ask.ts` has
 * always consumed it (`inducedClaim` is gated on `!degraded`, and the disclosure
 * copy already says "counts are live").
 *
 * The S2 induction set is not loaded here any more. Those seeded reads reach the
 * relay through `pass seed`, which is where a fixture that must be *countable*
 * belongs — loading them behind a flag made the same read present or absent
 * depending on a toggle no one set deliberately.
 */

import type { PoolView, Relay } from '../contracts/modules.js';
import type { Driver, Read } from '../contracts/types.js';
import type { FlagStore } from '../config/flagStore.js';
import type { Logger } from '../config/logger.js';

export interface PoolViewDeps {
  relay: Relay;
  flags: FlagStore;
  logger: Logger;
}

export function createPoolView(deps: PoolViewDeps): PoolView {
  return {
    async readsForDriver(driver: Driver): Promise<{ reads: Read[]; degraded: boolean }> {
      const entries = await deps.relay.list();

      // The relay keys its store on read_id, so duplicates should not occur —
      // but K6 counts what it is given and a double-counted read is a cohort
      // that clears the k>=5 floor without five people behind it. Dedup here
      // and say so, rather than trust a remote service's uniqueness.
      const seen = new Set<string>();
      const reads: Read[] = [];
      let duplicates = 0;
      for (const entry of entries) {
        const read = entry.read;
        if (read.driver !== driver) continue;
        if (seen.has(read.read_id)) {
          duplicates += 1;
          continue;
        }
        seen.add(read.read_id);
        reads.push(read);
      }
      if (duplicates > 0) {
        deps.logger.line(
          `poolView: relay returned ${duplicates} duplicate read_id(s) for ${driver} — counted once each`,
        );
      }

      return { reads, degraded: deps.flags.get().pool === 'relay-only' };
    },
  };
}
