/**
 * Deletion by read_id (M8) — design v0.8 §7: both XTrace scopes plus the relay
 * purge, with a per-target report so the caller can tell the user exactly what
 * is gone. Front-end copy for this flow is "deleted from Confit" — deletion is
 * app-mediated, and nothing here or downstream may imply cryptographic
 * enforcement.
 *
 * Scope reality, documented rather than papered over.
 *
 * The **relay** delete is the authoritative one under DAG §4 D-7: the relay
 * holds the read, so once its entry is gone the read is gone from every place
 * that can produce it, and it stops being counted in any cohort immediately.
 *
 * Neither XTrace target can be keyed by read_id, and for the same reason. Gate
 * zero established that XTrace extracts rather than stores: a pool read becomes
 * five prose facts, a user confession becomes prose derived from [E11]'s raw
 * text, and in neither case does a derived memory carry the read_id. Searching
 * for it and deleting what comes back would be a fuzzy match deciding what to
 * destroy — a near-miss deletes someone else's row. So both XTrace targets
 * delete only against caller-supplied memory handles, and report `skipped` with
 * the reason otherwise. That is a weaker guarantee than "forget removes every
 * trace", and it is reported as `skipped` rather than dressed up as
 * `nothing_to_delete`, because a deletion report that overstates itself is the
 * one kind of bug this flow must not have.
 *
 * Closing the gap needs an ingest ledger: `result.memories_created[]` on a
 * succeeded job carries `{id, type, text}`, so the handles exist and can be
 * captured at write time. Registered as M10.
 */

import type { MemoryClient, Relay } from '../contracts/modules.js';
import type { Logger } from '../config/logger.js';
import { POOL_SCOPE } from './pool.js';
import { personalScope } from './scopes.js';
import type { ProseBuffer } from './proseBuffer.js';


export type ForgetTargetStatus = 'deleted' | 'nothing_to_delete' | 'skipped' | 'failed';

export interface ForgetTargetReport {
  status: ForgetTargetStatus;
  /** How many records were removed (deleted targets only). */
  count?: number;
  detail?: string;
}

export interface ForgetReport {
  read_id: string;
  pool: ForgetTargetReport;
  relay: ForgetTargetReport;
  user: ForgetTargetReport;
  /**
   * The local confession buffer — the FOURTH target (SL-50).
   *
   * M20 gave the raw confession a fourth home and `forget` was not told. Executed: `forget`
   * reported ok on all three targets, and the next flush ingested the confession it had just
   * promised to delete. A deletion promise that a later batch quietly reverses is worse than
   * one that admits it cannot reach something.
   */
  buffer: ForgetTargetReport;
  /** True unless some target FAILED. An unknown read_id everywhere is still ok. */
  ok: boolean;
}

export interface ForgetDeps {
  client: MemoryClient;
  relay: Relay;
  /**
   * The confession buffer, so a forgotten confession is not sent by the next flush (SL-50).
   *
   * Optional so callers that predate the buffer still compile, and the report says `skipped`
   * with a reason rather than silently claiming the target was clean — the same honesty rule
   * the XTrace targets already follow.
   */
  buffer?: ProseBuffer;
  logger: Logger;
}

export interface ForgetOptions {
  /** User-scope handles captured at write time, when the caller has them. */
  userMemories?: Array<{ profile: string; memoryId: string }>;
  /** Pool-scope handles captured at write time, when the caller has them. */
  poolMemories?: string[];
}

/**
 * Pool-scope deletion, now that there are handles to delete by (M10).
 *
 * The caller may pass handles, but normally does not have any: they come from the ingest
 * job's RESULT, which does not exist until the job succeeds, long after `confess` returned.
 * So the sweeper records them on the relay entry and this reads them back — the relay is the
 * store of record (D-7), which makes it the right place for a ledger.
 *
 * A read whose sweep has not reached it yet has no handles, and that is reported as `skipped`
 * with the reason rather than as a clean deletion. Which of the two it is matters: one is
 * "there was nothing", the other is "come back after a sweep".
 */
async function forgetPool(
  deps: ForgetDeps,
  handles: readonly string[],
  entryPresent: boolean,
): Promise<ForgetTargetReport> {
  if (handles.length === 0) {
    // Which skipped this is matters (SL-57): the sweep advice is only true while the
    // relay entry — the ledger's home — still exists. After `forgetRelay` has dropped
    // it, no sweep can ever record handles for this read again, and saying so would
    // send the user chasing an impossible retry.
    return {
      status: 'skipped',
      detail: entryPresent
        ? 'no pool handles recorded for this read — the ingest ledger is written by the sweeper when the job succeeds, so a read confessed moments ago has none yet; run `confit sweep` and forget again (M10)'
        : 'no relay entry holds a ledger for this read — nothing to delete by handle. If it was forgotten before a sweep recorded its handles, any derived pool records are unreachable by handle now (SL-57)',
    };
  }
  // Every handle is attempted (SL-57): the old loop stopped at the first failure, and the
  // relay entry carrying the only other copy of these ids is deleted in this same forget —
  // so a handle not attempted now is a handle nothing can reach later.
  const undeleted: string[] = [];
  let firstError: string | undefined;
  let deleted = 0;
  for (const memoryId of handles) {
    try {
      await deps.client.remove(POOL_SCOPE, memoryId);
      deleted += 1;
    } catch (error) {
      undeleted.push(memoryId);
      firstError ??= error instanceof Error ? error.message : String(error);
    }
  }
  if (undeleted.length === 0) return { status: 'deleted', count: deleted };
  return {
    status: 'failed',
    detail:
      `deleted ${String(deleted)} of ${String(handles.length)}; undeleted handle(s): ` +
      `${undeleted.join(', ')} — the relay entry and its ledger are gone in this same ` +
      `forget, so a re-run cannot reach these; remove them by hand in the pool scope ` +
      `(first error: ${firstError ?? 'unknown'}) (SL-57)`,
  };
}

/**
 * The authoritative delete (D-7). Once the entry is gone the read cannot be
 * produced by any query, so it leaves every cohort count on the next Ask.
 */
async function forgetRelay(readId: string, deps: ForgetDeps): Promise<ForgetTargetReport> {
  try {
    const entries = await deps.relay.list();
    const present = entries.some((entry) => entry.read.read_id === readId);
    await deps.relay.drop(readId); // already-gone resolves (M4 semantics)
    return present ? { status: 'deleted', count: 1 } : { status: 'nothing_to_delete' };
  } catch (error) {
    return {
      status: 'failed',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

async function forgetUser(
  deps: ForgetDeps,
  userMemories: ForgetOptions['userMemories'],
): Promise<ForgetTargetReport> {
  if (userMemories === undefined || userMemories.length === 0) {
    return {
      status: 'skipped',
      detail:
        'no user-scope handles for this read — prose memories are not keyed by read_id (see src/memory/README.md)',
    };
  }
  try {
    for (const { profile, memoryId } of userMemories) {
      await deps.client.remove(personalScope(profile), memoryId);
    }
    return { status: 'deleted', count: userMemories.length };
  } catch (error) {
    return {
      status: 'failed',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Every target is attempted regardless of the others' outcomes — a relay
 * failure must not stop the XTrace purge, and vice versa. Forgetting an unknown
 * read_id is not an error: the relay reports nothing_to_delete and ok stays
 * true.
 */
/**
 * The buffered copy — deleted before it can be sent, not after (SL-50).
 *
 * Synchronous and local, so it is done first rather than in the `Promise.all`: every moment
 * between the user asking and the entry going is a moment a concurrent flush could send it.
 */
function forgetBuffer(readId: string, deps: ForgetDeps): ForgetTargetReport {
  if (deps.buffer === undefined) {
    return {
      status: 'skipped',
      detail: 'no confession buffer wired into this caller — a buffered copy may still be sent',
    };
  }
  try {
    const removed = deps.buffer.forget(readId);
    return removed === 0 ? { status: 'nothing_to_delete' } : { status: 'deleted', count: removed };
  } catch (error) {
    return { status: 'failed', detail: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * The ingest ledger, read BEFORE anything is deleted.
 *
 * Ordering is load-bearing: the handles live ON the relay entry, and `forgetRelay` deletes
 * that entry. Reading them inside the same `Promise.all` was a race the deletion usually won
 * — verified live, the ledger was present and `forget` still reported `skipped`, because the
 * entry was gone by the time the read reached it. So the ledger is resolved first, in its own
 * step, and only then does anything delete.
 */
async function poolHandles(
  readId: string,
  deps: ForgetDeps,
  supplied: ForgetOptions['poolMemories'],
): Promise<{ handles: readonly string[]; entryPresent: boolean; error?: string }> {
  if (supplied !== undefined && supplied.length > 0) {
    return { handles: supplied, entryPresent: true };
  }
  try {
    const entry = (await deps.relay.list()).find((e) => e.read.read_id === readId);
    return { handles: entry?.pool_memories ?? [], entryPresent: entry !== undefined };
  } catch (error) {
    return {
      handles: [],
      entryPresent: false,
      error: `could not read the ingest ledger from the relay: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

export async function forget(
  readId: string,
  deps: ForgetDeps,
  options: ForgetOptions = {},
): Promise<ForgetReport> {
  // The buffer first: it is the only target that can still SEND the thing being forgotten.
  const buffer = forgetBuffer(readId, deps);
  // Then the ledger, before any delete — see `poolHandles`.
  const ledger = await poolHandles(readId, deps, options.poolMemories);
  const [pool, relay, user] = await Promise.all([
    ledger.error === undefined
      ? forgetPool(deps, ledger.handles, ledger.entryPresent)
      : Promise.resolve<ForgetTargetReport>({ status: 'failed', detail: ledger.error }),
    forgetRelay(readId, deps),
    forgetUser(deps, options.userMemories),
  ]);
  const ok = [pool, relay, user, buffer].every((target) => target.status !== 'failed');
  return { read_id: readId, pool, relay, user, buffer, ok };
}
