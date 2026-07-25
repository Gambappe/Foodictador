/**
 * Settle-sweeper (M7) — the owner of verification that outlives the author's
 * session (design v0.8 [E21]).
 *
 * For each relay entry older than the settle window: verify the read is
 * retrievable from the pool; verified → drop the relay entry; missing →
 * re-ingest to the pool FROM THE ENTRY'S OWN SIX FIELDS and leave the entry
 * for the next pass. **Verified-drop only, never a TTL**: an entry dropped
 * unverified is a read lost while the UI claimed it pooled — the exact [E12]
 * failure this module exists to prevent. There is deliberately no code path
 * that removes an entry without a positive verification.
 *
 * Verification is two-path per DAG §4 D-1, because `setJob` is best-effort:
 *   - entry carries `ingest_job_id` → poll the job (primary);
 *   - no job id, or the job is unknown → search the pool for the `read_id`
 *     via the per-driver counting query (weaker, but always available).
 */

import type { MemoryClient, PoolStore, Relay } from '../contracts/modules.js';
import type { RelayEntry, SweepReport } from '../contracts/types.js';
import type { Logger } from '../config/logger.js';

export interface SweeperDeps {
  relay: Relay;
  pool: PoolStore;
  client: MemoryClient;
  logger: Logger;
  settleWindowSeconds: number;
}

type Verdict = 'verified' | 'missing' | 'wait';

async function verify(entry: RelayEntry, deps: SweeperDeps): Promise<Verdict> {
  const { read } = entry;
  if (entry.ingest_job_id !== undefined) {
    const status = await deps.client.jobStatus(entry.ingest_job_id);
    if (status === 'complete') return 'verified';
    if (status === 'failed') return 'missing';
    if (status === 'pending') return 'wait';
    // 'unknown': the annotation may be stale — fall through to the search path.
  }
  const reads = await deps.pool.readsForDriver(read.driver);
  return reads.some((candidate) => candidate.read_id === read.read_id) ? 'verified' : 'missing';
}

export function createSweeper(deps: SweeperDeps) {
  return {
    /**
     * One pass. `now` is the caller's clock (X4's `--once`/`--watch` owns the
     * timer); nothing here reads a clock. Report semantics: `verified` were
     * dropped this pass, `reingested` were re-written to the pool and retained,
     * `retained` is everything still on the relay afterwards (young entries
     * included), `oldestEntryAgeSeconds` is the post-sweep stuck-entry signal.
     */
    async sweepOnce(now: string): Promise<SweepReport> {
      const nowMs = Date.parse(now);
      const entries = await deps.relay.list();
      let verified = 0;
      let reingested = 0;

      for (const entry of entries) {
        const ageSeconds = (nowMs - Date.parse(entry.received_at)) / 1000;
        if (ageSeconds <= deps.settleWindowSeconds) continue; // still settling — not ours yet

        const verdict = await verify(entry, deps);
        if (verdict === 'verified') {
          await deps.relay.drop(entry.read.read_id);
          verified += 1;
          continue;
        }
        if (verdict === 'wait') continue; // job still pending — next pass decides

        // Missing from the pool: the relay entry is the recovery record. Re-ingest
        // from its own six fields and re-annotate so the NEXT pass polls the fresh
        // job instead of re-ingesting again. Annotation stays best-effort (D-1).
        const handle = await deps.pool.writeRead(entry.read);
        reingested += 1;
        deps.logger.line(
          `sweeper: re-ingested ${entry.read.read_id} (job ${handle.jobId}) — missing after ${Math.round(ageSeconds)}s`,
        );
        try {
          await deps.relay.setJob(entry.read.read_id, handle.jobId);
        } catch (error) {
          deps.logger.line(
            `sweeper: job annotation failed for ${entry.read.read_id} (best-effort): ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }

      const stats = await deps.relay.stats();
      return {
        verified,
        reingested,
        retained: stats.count,
        oldestEntryAgeSeconds: stats.oldest_entry_age_seconds,
      };
    },
  };
}

export type Sweeper = ReturnType<typeof createSweeper>;
