import type { PoolStore } from '../modules.js';
import type { JobHandle, Read } from '../types.js';

/**
 * The induction feed, stubbed.
 *
 * It deliberately does NOT hand reads back. A stub that round-tripped a `Read`
 * would model a substrate that does not exist — that mismatch is precisely how
 * the pool shipped with a counting query no live deployment could serve (D-7).
 * Ingested reads are counted, not stored, so a test can assert the feed was fed.
 */
export class StubPoolStore implements PoolStore {
  private seq = 0;

  /** Every read ever ingested, in order — write-path assertions only. */
  readonly ingested: Read[] = [];

  writeRead(read: Read): Promise<JobHandle> {
    this.ingested.push(read);
    this.seq += 1;
    return Promise.resolve({ jobId: `pool-job-${this.seq}` });
  }

  inducedClaim(_query: string): Promise<string> {
    return Promise.resolve('Hygiene complaints under-predict loyalty at the taqueria.');
  }
}
