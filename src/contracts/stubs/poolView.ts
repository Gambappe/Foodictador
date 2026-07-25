import { poolBaseline } from '../fixtures/index.js';
import type { PoolView } from '../modules.js';
import type { Driver, Read } from '../types.js';

/** Serves the fixture baseline, deduplicated on read_id ([E20]) like the real view. */
export class StubPoolView implements PoolView {
  constructor(
    private readonly reads: Read[] = poolBaseline,
    private readonly degraded: boolean = false,
  ) {}

  readsForDriver(driver: Driver): Promise<{ reads: Read[]; degraded: boolean }> {
    const seen = new Set<string>();
    const deduped: Read[] = [];
    for (const read of this.reads) {
      if (read.driver !== driver || seen.has(read.read_id)) continue;
      seen.add(read.read_id);
      deduped.push(read);
    }
    return Promise.resolve({ reads: deduped, degraded: this.degraded });
  }
}
