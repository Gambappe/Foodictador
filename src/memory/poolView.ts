/**
 * PoolView (M6) — the union every Ask reads: XTrace pool ∪ relay, deduplicated
 * on `read_id` ([E20]). The pool copy is canonical, so it goes first and a
 * divergent relay copy loses (K6's documented dedup convention).
 *
 * Under `flags.pool === 'relay-only'` (XTrace unavailable or not settling) the
 * view serves the S2 induction set plus live relay contents and reports
 * `degraded: true` so the card can disclose it — cohort counts stay live
 * because the relay is still read.
 */

import { readFileSync } from 'node:fs';

import type { PoolStore, PoolView, Relay } from '../contracts/modules.js';
import type { Driver, Read } from '../contracts/types.js';
import type { FlagStore } from '../config/flagStore.js';
import type { Logger } from '../config/logger.js';
import { parseRead } from '../kernel/read.js';

export interface PoolViewDeps {
  pool: PoolStore;
  relay: Relay;
  flags: FlagStore;
  logger: Logger;
  /** Overridable for tests; defaults to the committed S2 artifact. */
  inductionSetPath?: string;
}

function defaultInductionSetPath(): string {
  return new URL('../../data/seeds/induction-set.json', import.meta.url).pathname;
}

export function createPoolView(deps: PoolViewDeps): PoolView {
  // Lazy-loaded and cached: live mode never touches the file, and a missing
  // artifact only fails the degraded path it belongs to.
  let inductionSet: Read[] | null = null;
  const loadInductionSet = (): Read[] => {
    if (inductionSet !== null) return inductionSet;
    const path = deps.inductionSetPath ?? defaultInductionSetPath();
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { reads?: unknown[] };
    const parsed: Read[] = [];
    for (const candidate of raw.reads ?? []) {
      try {
        parsed.push(parseRead(candidate));
      } catch (error) {
        deps.logger.line(
          `poolView: skipping invalid induction-set read: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    inductionSet = parsed;
    return parsed;
  };

  return {
    async readsForDriver(driver: Driver): Promise<{ reads: Read[]; degraded: boolean }> {
      const degraded = deps.flags.get().pool === 'relay-only';
      const canonical = degraded
        ? loadInductionSet().filter((read) => read.driver === driver)
        : await deps.pool.readsForDriver(driver);
      const relayReads = (await deps.relay.list())
        .map((entry) => entry.read)
        .filter((read) => read.driver === driver);

      // Canonical copy first, relay second — first occurrence of a read_id wins.
      const seen = new Set<string>();
      const union: Read[] = [];
      for (const read of [...canonical, ...relayReads]) {
        if (seen.has(read.read_id)) continue;
        seen.add(read.read_id);
        union.push(read);
      }
      return { reads: union, degraded };
    },
  };
}
