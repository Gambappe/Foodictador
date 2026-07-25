/**
 * Settle-sweeper (M7) — the induction backfill, under DAG §4 D-7.
 *
 * **This module deletes nothing.** It used to: the relay was a settle-window
 * buffer in front of XTrace, and an entry XTrace had confirmed was redundant.
 * D-7 inverted that. The relay is now the durable store of reads, XTrace cannot
 * hand a read back (gate zero: five unjoinable prose facts, no round trip), and
 * so a relay entry dropped here would be the read itself gone — not delayed,
 * gone, with no second copy anywhere. There is deliberately no code path in this
 * file that removes an entry, and `guards/relayDurability.test.ts` fails the
 * build if one appears.
 *
 * What remains is the half that was always real: XTrace's induction index only
 * knows about reads that were successfully ingested, and ingestion is
 * best-effort at write time. Each pass asks, of every entry past the settle
 * window, "did this reach the induction index?" and re-ingests the ones that
 * did not.
 *
 * Confirmation is job-status only, per D-1's primary path. The old fallback —
 * search the pool for the read_id — is gone because it can no longer succeed;
 * keeping it would have re-ingested every entry on every pass forever. An entry
 * whose job id is missing or unknown is therefore counted `pending` rather than
 * re-ingested on spec: the read is safe in the relay, so the only thing at stake
 * is induction quality, and duplicate prose degrades induction (N copies of one
 * read look like N reads) rather than improving it.
 */

import type { BatchHandle, MemoryClient, PoolStore, Relay } from '../contracts/modules.js';
import type { IngestJobStatus, Read, SweepReport } from '../contracts/types.js';
import type { Logger } from '../config/logger.js';

export interface SweeperDeps {
  relay: Relay;
  pool: PoolStore;
  client: MemoryClient;
  logger: Logger;
  settleWindowSeconds: number;
}

/**
 * `pooled` — XTrace has it. `reingest` — it does not, send it again.
 * `pending` — cannot tell yet, and guessing costs more than waiting.
 */
type Verdict = 'pooled' | 'reingest' | 'pending';

function classify(status: IngestJobStatus): Verdict {
  switch (status) {
    case 'complete':
      return 'pooled';
    case 'failed':
      return 'reingest';
    case 'pending':
      return 'pending';
    default:
      // 'unknown': the annotation is stale or the job expired. Under D-7 there is
      // no second way to check, and re-ingesting on a guess duplicates induction
      // prose on every pass. Surface it and leave it alone.
      return 'pending';
  }
}

export function createSweeper(deps: SweeperDeps) {
  return {
    /**
     * One pass. `now` is the caller's clock (X4's `--once`/`--watch` owns the
     * timer); nothing here reads a clock. Entries younger than the settle window
     * are skipped entirely — they are not yet expected to have settled, so they
     * count towards neither `pooled` nor `pending`.
     */
    async sweepOnce(now: string): Promise<SweepReport> {
      const nowMs = Date.parse(now);
      const entries = await deps.relay.list();
      let pooled = 0;
      let reingested = 0;
      let pending = 0;
      // Handles recorded this pass (M10). Counted so an operator can see the ledger filling —
      // a `forget` that reports `skipped` for the pool is explained by this being 0.
      let ledgered = 0;
      /** Reads needing re-ingest, sent as ONE grouped call after the loop (M12). */
      const backfill: Read[] = [];

      for (const entry of entries) {
        const ageSeconds = (nowMs - Date.parse(entry.received_at)) / 1000;
        if (ageSeconds <= deps.settleWindowSeconds) continue; // still settling — not ours yet

        if (entry.ingest_job_id !== undefined) {
          // One entry's substrate failure must not end the pass. It did: a single 429 out of
          // `jobStatus` threw through the loop and the command exited 3 with `internal error`,
          // so nothing was confirmed and no handles were recorded — for 220 healthy entries as
          // well as the one that failed. A sweep is a best-effort reconciliation; the honest
          // response to "the substrate would not answer about this one" is to count it
          // unconfirmed, say so, and carry on to the rest.
          let status: IngestJobStatus;
          try {
            status = await deps.client.jobStatus(entry.ingest_job_id);
          } catch (error) {
            pending += 1;
            deps.logger.line(
              `sweeper: could not check ${entry.read.read_id} (job ${entry.ingest_job_id}) — ` +
                `counted unconfirmed, sweep continues: ${
                  error instanceof Error ? error.message : String(error)
                }`,
            );
            continue;
          }
          const verdict = classify(status);
          if (verdict === 'pooled') {
            pooled += 1;
            // The ingest ledger (M10). This is the FIRST moment the handles exist: they come
            // from the job's result, and at write time the job is still pending — which is why
            // `forget` used to report `skipped` for both XTrace scopes with no handle to delete
            // by. Captured once; an entry that already has them is not re-read.
            if (entry.pool_memories === undefined) {
              try {
                const created = await deps.client.jobResult(entry.ingest_job_id);
                if (created.length > 0) {
                  await deps.relay.setPoolMemories(
                    entry.read.read_id,
                    created.map((row) => row.memoryId),
                  );
                  ledgered += created.length;
                }
              } catch (error) {
                // Best-effort, like setJob and for the same reason: losing the handles costs
                // `forget` a strong deletion, not a read. Never silent (§1).
                deps.logger.line(
                  `sweeper: could not record pool handles for ${entry.read.read_id} — forget ` +
                    `will report skipped for the pool scope: ${
                      error instanceof Error ? error.message : String(error)
                    }`,
                );
              }
            }
            continue;
          }
          if (verdict === 'pending') {
            pending += 1;
            deps.logger.line(
              `sweeper: ${entry.read.read_id} unconfirmed after ${Math.round(ageSeconds)}s (job ${entry.ingest_job_id}) — not re-ingesting on a guess`,
            );
            continue;
          }
          // 'reingest' falls through to the backfill below.
        }

        // Not re-ingested here — collected, and sent as grouped conversations after the loop.
        // One call per read is the pre-M12 defect, and the sweeper is where it hurts most: a
        // pass measured re-ingesting 219 reads made 219 single-read conversations, each
        // yielding an episode that can only paraphrase itself — the exact register M15 had to
        // abandon a whole scope to escape — and the burst is what tripped the 429 in SL-58.
        backfill.push(entry.read);
      }

      // One `writeReads` for the whole pass. Grouping is M2's (by driver, chunked at 20), so
      // a conversation is one cohort's worth of related reads rather than an arbitrary pile —
      // which is the objection the old per-read design was defending against, already answered.
      if (backfill.length > 0) {
        let handles: BatchHandle[] = [];
        try {
          handles = await deps.pool.writeReads(backfill);
          reingested = backfill.reduce((n) => n + 1, 0);
        } catch (error) {
          // Per-entry guarding was the SL-58 fix and it still holds, one level up: the whole
          // backfill failing is not a reason to lose the confirmations this pass already made.
          pending += backfill.length;
          deps.logger.line(
            `sweeper: could not re-ingest ${String(backfill.length)} read(s) — counted ` +
              `unconfirmed, sweep continues: ${
                error instanceof Error ? error.message : String(error)
              }`,
          );
        }
        deps.logger.line(
          `sweeper: re-ingested ${String(reingested)} read(s) as ${String(handles.length)} ` +
            `conversation(s) — batched so an episode can span them (M12)`,
        );
        // Every read in a conversation is annotated with that conversation's job. The job DID
        // ingest it, so the next pass's `jobStatus` check is exactly as valid as before.
        //
        // What is NOT recorded is M10's per-read ledger: `memories_created` for a batched job
        // covers every read in it and says which read produced which memory nowhere. Attributing
        // them by matching text would be the fuzzy deletion M10's own note forbids, so `forget`
        // reports `skipped` for these — the same as seeded reads, and said out loud here rather
        // than discovered later.
        for (const handle of handles) {
          for (const readId of handle.readIds) {
            try {
              await deps.relay.setJob(readId, handle.jobId);
            } catch (error) {
              deps.logger.line(
                `sweeper: job annotation failed for ${readId} — it will re-ingest again next pass: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              );
            }
          }
        }
      }

      const stats = await deps.relay.stats();
      return {
        pooled,
        reingested,
        pending,
        ledgered,
        stored: stats.count,
        oldestStoredAgeSeconds: stats.oldest_entry_age_seconds,
      };
    },
  };
}

export type Sweeper = ReturnType<typeof createSweeper>;
