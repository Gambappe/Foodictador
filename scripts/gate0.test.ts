import { describe, expect, it } from 'vitest';

import type { MemoryClient } from '../src/contracts/modules.js';
import type { MemoryRow } from '../src/contracts/types.js';
import { GATE0_N, renderResults, runGateZero } from './gate0.js';

/**
 * Fake substrate with dialable behaviour:
 * - `settleAfterPolls`: how many search calls a record takes to become visible;
 * - `neverSettle`: content substrings that never become retrievable;
 * - `zombieDelete`: remove() succeeds but the record stays retrievable.
 */
function fakeSubstrate(opts: {
  settleAfterPolls?: number;
  neverSettle?: (content: string) => boolean;
  zombieDelete?: boolean;
}) {
  interface Stored {
    row: MemoryRow;
    scope: string;
    visibleAfter: number;
  }
  const stored: Stored[] = [];
  let searchCalls = 0;
  let seq = 0;

  const client: MemoryClient = {
    ingest(scope, payload) {
      seq += 1;
      const never = opts.neverSettle?.(payload) ?? false;
      stored.push({
        scope,
        visibleAfter: never ? Number.POSITIVE_INFINITY : searchCalls + (opts.settleAfterPolls ?? 0),
        row: { memoryId: `mem-${seq}`, kind: 'fact', content: payload },
      });
      return Promise.resolve({ jobId: `job-${seq}` });
    },
    search(scope, query) {
      searchCalls += 1;
      return Promise.resolve(
        stored
          .filter(
            (s) =>
              s.scope === scope && s.visibleAfter <= searchCalls && s.row.content.includes(query),
          )
          .map((s) => s.row),
      );
    },
    remove(scope, memoryId) {
      if (!opts.zombieDelete) {
        const i = stored.findIndex((s) => s.scope === scope && s.row.memoryId === memoryId);
        if (i >= 0) stored.splice(i, 1);
      }
      return Promise.resolve();
    },
    jobStatus: () => Promise.resolve('complete'),
  };
  return client;
}

function deps(client: MemoryClient) {
  let clock = 0;
  return {
    client,
    now: () => (clock += 500),
    sleep: () => Promise.resolve(),
    pollIntervalMs: 1,
    settleWindowGuessSeconds: 10_000, // generous fake deadline; the fake clock never hits it
    print: () => {},
  };
}

describe('P0.5 gate zero runner', () => {
  it('passes when all reads settle, with the distribution and window recorded', async () => {
    const result = await runGateZero(deps(fakeSubstrate({ settleAfterPolls: 2 })));
    expect(result.pass).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.distribution[0]).toBe(GATE0_N);
    expect(result.settleP50Seconds).not.toBeNull();
    expect(result.settleMaxSeconds).not.toBeNull();
    expect(result.deleteTrial.pass).toBe(true);
    expect(result.deleteTrial.detail).toMatch(/deleted and verified gone/);
  });

  it('fails at round 3: a read still missing after two re-ingest rounds is a failure', async () => {
    // The first ingested read never settles no matter how many times it is re-ingested.
    let doomedMarker: string | null = null;
    const client = fakeSubstrate({
      neverSettle: (content) => {
        doomedMarker ??= content;
        return content === doomedMarker;
      },
    });
    const result = await runGateZero(deps(client));
    expect(result.pass).toBe(false);
    expect(result.failures).toHaveLength(1);
    const settled = Object.values(result.distribution).reduce((a, b) => a + b, 0);
    expect(settled).toBe(GATE0_N - 1);
  });

  it('fails when a delete leaves the read retrievable — deletion must be deletion', async () => {
    const result = await runGateZero(deps(fakeSubstrate({ zombieDelete: true })));
    expect(result.failures).toEqual([]); // all settled fine…
    expect(result.deleteTrial.pass).toBe(false); // …but the deletion trial failed
    expect(result.pass).toBe(false);
    expect(result.deleteTrial.detail).toMatch(/still retrievable after DELETE/);
  });

  it('renderResults writes an honest FAIL with the escalation line', async () => {
    const result = await runGateZero(deps(fakeSubstrate({ zombieDelete: true })));
    const md = renderResults(result, '2026-07-25T20:00:00.000Z');
    expect(md).toContain('Status: FAIL');
    expect(md).toContain('[E9] reopens');
    expect(md).toContain('SETTLE_WINDOW_SECONDS=');
  });

  it('renderResults on a pass carries the measured window forward', async () => {
    const result = await runGateZero(deps(fakeSubstrate({})));
    const md = renderResults(result, '2026-07-25T20:00:00.000Z');
    expect(md).toContain('Status: PASS');
    expect(md).toMatch(/p50: \d/);
  });
});
