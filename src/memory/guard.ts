/**
 * Pool-write schema guard (M5's deliverable; G1's test subject).
 *
 * Design v0.8 [E25]: every pool-bound and relay-bound write body must be
 * EXACTLY the six-field read schema — closed to additional properties, values
 * within the enum vocabulary. Reject-by-construction is testable; detect-prose
 * is not. The guard wraps the stores themselves, so a caller that bypasses
 * writeRead and hits a store directly is still stopped — the boundary lives
 * here, not in the caller.
 */

import type { PoolStore, Relay } from '../contracts/modules.js';
import type { Read } from '../contracts/types.js';
import { parseRead } from '../kernel/read.js';

/**
 * The single assertion: exactly READ_KEYS (parseRead is closed against the
 * imported constant), enums respected, weight finite in [0,1]. Throws with a
 * message naming the offending field.
 */
export function assertWriteBody(value: unknown): Read {
  return parseRead(value);
}

/** A PoolStore whose write path validates every body before it can leave. */
export function guardPoolStore(store: PoolStore): PoolStore {
  return {
    writeRead: async (read) => store.writeRead(assertWriteBody(read)),
    // The batch path validates every body too. A guard that covered only the single-read
    // write would be bypassed by the path that sends the most reads.
    writeReads: async (reads) => store.writeReads(reads.map(assertWriteBody)),
    inducedClaim: (query) => store.inducedClaim(query),
  };
}

/** A Relay whose write paths (put, seed) validate every body before the wire. */
export function guardRelay(relay: Relay): Relay {
  return {
    put: async (read) => relay.put(assertWriteBody(read)),
    seed: async (reads) => relay.seed(reads.map((read) => assertWriteBody(read))),
    setJob: (readId, jobId) => relay.setJob(readId, jobId),
    setPoolMemories: () => Promise.resolve(),
    list: (since) => relay.list(since),
    drop: (readId) => relay.drop(readId),
    stats: () => relay.stats(),
    reset: () => relay.reset(),
  };
}
