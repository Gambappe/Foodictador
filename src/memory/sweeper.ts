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

import type { MemoryClient, PoolStore, Relay } from '../contracts/modules.js';
import type { IngestJobStatus, SweepReport } from '../contracts/types.js';
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

        // Either the ingest failed, or the entry was never annotated at all
        // (setJob is best-effort, D-1). Re-ingest from the entry's own six
        // fields and re-annotate so the next pass polls the fresh job.
        //
        // Guarded like the status check above, and for the same reason (SL-58): a backfill is
        // per-entry work, so one entry's rejection is not a reason to abandon the others. It
        // was — `ingest failed with status 429` threw out of the pass after six successful
        // re-ingests, discarding those six from the report as well. Counted `pending` because
        // that is what it is: still unconfirmed, and a later pass will try again.
        let handle;
        try {
          handle = await deps.pool.writeRead(entry.read);
        } catch (error) {
          pending += 1;
          deps.logger.line(
            `sweeper: could not re-ingest ${entry.read.read_id} — counted unconfirmed, sweep ` +
              `continues: ${error instanceof Error ? error.message : String(error)}`,
          );
          continue;
        }
        reingested += 1;
        deps.logger.line(
          `sweeper: re-ingested ${entry.read.read_id} (job ${handle.jobId}) — unpooled after ${Math.round(ageSeconds)}s`,
        );
        try {
          await deps.relay.setJob(entry.read.read_id, handle.jobId);
        } catch (error) {
          // Annotation is best-effort, but a relay that persistently rejects it
          // makes this entry re-ingest once per pass. The signature is visible:
          // `reingested` stays non-zero while `pending` never falls. Say so here
          // rather than let it look like progress.
          deps.logger.line(
            `sweeper: job annotation failed for ${entry.read.read_id} — it will re-ingest again next pass: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
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
