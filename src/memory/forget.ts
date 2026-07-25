/**
 * Deletion by read_id (M8) — design v0.8 §7: both XTrace scopes plus the relay
 * purge, with a per-target report so the caller can tell the user exactly what
 * is gone. Front-end copy for this flow is "deleted from Confit" — deletion is
 * app-mediated, and nothing here or downstream may imply cryptographic
 * enforcement.
 *
 * Scope reality, documented rather than papered over: pool records embed the
 * read_id in their content (M2), so the pool target is findable. User-scope
 * prose memories carry NO read_id linkage — the confession went in as raw
 * prose [E11] and XTrace's derived memories are not keyed to the read. The
 * user target therefore deletes only when the caller supplies memory handles,
 * and reports `skipped` with the reason otherwise. Closing that gap needs an
 * ingest ledger (write-time capture of job→memory handles), recorded in
 * src/memory/README.md as an open integrator decision.
 */

import type { MemoryClient, Relay } from '../contracts/modules.js';
import type { Logger } from '../config/logger.js';
import { parseRead } from '../kernel/read.js';
import { POOL_SCOPE } from './pool.js';

/** Wide enough to catch every copy of a duplicated re-ingest at demo scale. */
const FORGET_SEARCH_K = 100;

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
  /** True unless some target FAILED. An unknown read_id everywhere is still ok. */
  ok: boolean;
}

export interface ForgetDeps {
  client: MemoryClient;
  relay: Relay;
  logger: Logger;
}

export interface ForgetOptions {
  /** User-scope handles captured at write time, when the caller has them. */
  userMemories?: Array<{ profile: string; memoryId: string }>;
}

/** Does this pool row's content parse to exactly the read being forgotten? */
function rowIsRead(content: string, readId: string): boolean {
  try {
    return parseRead(JSON.parse(content)).read_id === readId;
  } catch {
    return false;
  }
}

async function forgetPool(readId: string, deps: ForgetDeps): Promise<ForgetTargetReport> {
  try {
    const rows = await deps.client.search(POOL_SCOPE, readId, {
      topK: FORGET_SEARCH_K,
      episodeSlots: 0,
    });
    const matching = rows.filter((row) => rowIsRead(row.content, readId));
    const mentionsOnly = rows.length - matching.length;
    if (mentionsOnly > 0) {
      deps.logger.line(
        `forget: ${mentionsOnly} pool row(s) mention ${readId} without being it — left in place`,
      );
    }
    if (matching.length === 0) return { status: 'nothing_to_delete' };
    for (const row of matching) {
      await deps.client.remove(POOL_SCOPE, row.memoryId);
    }
    return { status: 'deleted', count: matching.length };
  } catch (error) {
    return {
      status: 'failed',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

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
      await deps.client.remove(profile, memoryId);
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
 * failure must not stop the pool purge, and vice versa. Forgetting an unknown
 * read_id is not an error: every target reports nothing_to_delete and ok stays
 * true.
 */
export async function forget(
  readId: string,
  deps: ForgetDeps,
  options: ForgetOptions = {},
): Promise<ForgetReport> {
  const [pool, relay, user] = await Promise.all([
    forgetPool(readId, deps),
    forgetRelay(readId, deps),
    forgetUser(deps, options.userMemories),
  ]);
  const ok = [pool, relay, user].every((target) => target.status !== 'failed');
  return { read_id: readId, pool, relay, user, ok };
}
