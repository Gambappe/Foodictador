/**
 * Approval write path (M5) — the single function every front end calls on
 * "Add to the pot".
 *
 * The isBlocked check here is THE authoritative one ([E24], the §9 fix): a
 * flagged confession is ingested nowhere — no pool read, no relay entry, no
 * user-scope prose. L2 also checks, earlier and cheaper; that one is an
 * optimisation, this one is the guarantee. Keep both.
 *
 * Write ORDER is a correctness requirement, not style: relay first, because
 * the relay entry is the recovery record M7 re-ingests from. A crash after a
 * relay write costs at worst a duplicate re-ingest, which K6 dedups on
 * read_id; a pool write that nothing tracks is silent loss. For the same
 * reason a FAILED relay write means the pool is not written either — the read
 * is reported not pooled. The prose is the personal tier, which has no
 * durability story at all by D-10 — it is buffered and may be lost — so it is
 * still written, and its failure never unwinds the pooled read.
 */

import type { PoolStore, Relay, UserStore } from '../contracts/modules.js';
import type { Read } from '../contracts/types.js';
import type { Logger } from '../config/logger.js';
import { isBlocked } from '../kernel/offlimits.js';
import { mintReadId, parseRead } from '../kernel/read.js';

export interface WriteReadDeps {
  relay: Relay;
  pool: PoolStore;
  user: UserStore;
  logger: Logger;
}

export interface WriteReadInput {
  profile: string;
  /** The confession prose — personal tier only; never reaches pool or relay. */
  text: string;
  /** The five approved chips; the read_id is minted here, at approval. */
  chips: Omit<Read, 'read_id'>;
  offLimits: string[];
}

export interface WriteReadReport {
  read_id: string;
  wrote: { relay: boolean; pool: boolean; job: boolean; prose: boolean };
  /**
   * Confessions now waiting to be sent, after this one (M20).
   *
   * `0` means this confession's batch went to XTrace; a positive number means it is HELD
   * until the batch fills or `pass sweep` runs. `wrote.prose` alone cannot say which, and
   * telling a user their words reached their memory while they sit in a buffer is a false
   * receipt — deferral is not loss, but the receipt has to name which one it is.
   */
  proseBuffered: number;
  /**
   * `true` when a CONCURRENT `confess` claimed the batch this confession is in (SL-49).
   *
   * `proseBuffered === 0` has two causes — this process sent the batch, or another process
   * took it — and only the first may be reported as "sent". The confession is not lost either
   * way, but a receipt may only claim what this process actually did.
   */
  proseHandedOff: boolean;
  /** Honest per-target accounting for the caller to surface (X2). */
  warnings: string[];
}

export type WriteReadResult = { blocked: true } | WriteReadReport;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function writeRead(
  deps: WriteReadDeps,
  input: WriteReadInput,
): Promise<WriteReadResult> {
  // [E24]: blocked means nothing is written ANYWHERE — both tiers and the relay.
  // The chips are checked too: the extractor re-checks its own output, but this
  // gate must hold even for a caller that skipped L2 entirely.
  const chipText = [input.chips.place, input.chips.signal, input.chips.driver, input.chips.cadence]
    .join(' ')
    .replaceAll('_', ' ');
  if (isBlocked(input.text, input.offLimits) || isBlocked(chipText, input.offLimits)) {
    return { blocked: true };
  }

  const read = parseRead({ read_id: mintReadId(), ...input.chips });
  const wrote = { relay: false, pool: false, job: false, prose: false };
  const warnings: string[] = [];

  // 1. Relay first — the recovery record must exist before the pool write.
  try {
    await deps.relay.put(read);
    wrote.relay = true;
  } catch (error) {
    warnings.push(`relay write failed — read NOT pooled: ${message(error)}`);
    deps.logger.line(`writeRead: relay put failed for ${read.read_id}: ${message(error)}`);
  }

  // 2. Pool — only under a relay entry that tracks it.
  let jobId: string | null = null;
  if (wrote.relay) {
    try {
      const handle = await deps.pool.writeRead(read);
      wrote.pool = true;
      jobId = handle.jobId;
    } catch (error) {
      warnings.push(`pool write failed — relay entry retained for the sweeper: ${message(error)}`);
      deps.logger.line(`writeRead: pool write failed for ${read.read_id}: ${message(error)}`);
    }
  }

  // 3. Job annotation — best-effort by design (D-1); M7 has a fallback path.
  if (jobId !== null) {
    try {
      await deps.relay.setJob(read.read_id, jobId);
      wrote.job = true;
    } catch (error) {
      warnings.push(`job annotation failed — sweeper will use the search fallback: ${message(error)}`);
      deps.logger.line(`writeRead: setJob failed for ${read.read_id}: ${message(error)}`);
    }
  }

  // 4. Prose last — personal tier, raw and unmodified ([E11]). Buffered rather than sent
  // immediately (M20): XTrace makes an episode per ingest CALL, so one-at-a-time ingests can
  // only ever produce per-confession paraphrases.
  let proseBuffered = 0;
  let proseHandedOff = false;
  try {
    // The read_id travels with the prose so `forget` can delete the buffered copy before it is
    // ever sent (SL-50) — otherwise `forget` reports success on three targets while a fourth
    // copy waits on disk.
    const written = await deps.user.writeProse(input.profile, input.text, read.read_id);
    proseBuffered = written.buffered;
    proseHandedOff = written.handedOff === true;
    wrote.prose = true;
  } catch (error) {
    warnings.push(`prose write failed — personal memory not recorded: ${message(error)}`);
    deps.logger.line(`writeRead: prose write failed for ${read.read_id}: ${message(error)}`);
  }

  return { read_id: read.read_id, wrote, proseBuffered, proseHandedOff, warnings };
}
