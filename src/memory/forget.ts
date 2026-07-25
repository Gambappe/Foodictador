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

async function forgetPool(
  deps: ForgetDeps,
  poolMemories: ForgetOptions['poolMemories'],
): Promise<ForgetTargetReport> {
  if (poolMemories === undefined || poolMemories.length === 0) {
    return {
      status: 'skipped',
      detail:
        'no pool-scope handles for this read — XTrace holds prose derived from it, not the read, and derived memories are not keyed by read_id (see src/memory/README.md, M10)',
    };
  }
  try {
    for (const memoryId of poolMemories) {
      await deps.client.remove(POOL_SCOPE, memoryId);
    }
    return { status: 'deleted', count: poolMemories.length };
  } catch (error) {
    return {
      status: 'failed',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
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

export async function forget(
  readId: string,
  deps: ForgetDeps,
  options: ForgetOptions = {},
): Promise<ForgetReport> {
  // The buffer first: it is the only target that can still SEND the thing being forgotten.
  const buffer = forgetBuffer(readId, deps);
  const [pool, relay, user] = await Promise.all([
    forgetPool(deps, options.poolMemories),
    forgetRelay(readId, deps),
    forgetUser(deps, options.userMemories),
  ]);
  const ok = [pool, relay, user, buffer].every((target) => target.status !== 'failed');
  return { read_id: readId, pool, relay, user, buffer, ok };
}
