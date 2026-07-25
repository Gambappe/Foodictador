import { poolBaseline } from '../fixtures/index.js';
import type { PoolStore } from '../modules.js';
import type { Driver, JobHandle, Read } from '../types.js';

/** Pool over the fixture baseline; writes append in memory. */
export class StubPoolStore implements PoolStore {
  private readonly reads: Read[];
  private seq = 0;

  constructor(initial: Read[] = [...poolBaseline]) {
    this.reads = [...initial];
  }

  writeRead(read: Read): Promise<JobHandle> {
    this.reads.push(read);
    this.seq += 1;
    return Promise.resolve({ jobId: `pool-job-${this.seq}` });
  }

  readsForDriver(driver: Driver, opts?: { k?: number }): Promise<Read[]> {
    const matched = this.reads.filter((r) => r.driver === driver);
    return Promise.resolve(opts?.k === undefined ? matched : matched.slice(0, opts.k));
  }

  inducedClaim(_query: string): Promise<string> {
    return Promise.resolve('Hygiene complaints under-predict loyalty at the taqueria.');
  }
}
