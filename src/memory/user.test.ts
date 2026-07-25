import { describe, expect, it } from 'vitest';

import type { MemoryClient } from '../contracts/modules.js';
import type { IngestJobStatus, MemoryRow, UsualProfile } from '../contracts/types.js';
import { sampleUsual } from '../contracts/fixtures/index.js';
import { createLogger } from '../config/logger.js';
import { createUserStore } from './user.js';

/**
 * Fake substrate: per-scope rows, searchable by naive substring, removable,
 * with per-job controllable status — enough to exercise verify-and-retry.
 */
function fakeSubstrate() {
  const rowsByScope = new Map<string, MemoryRow[]>();
  const jobStatuses = new Map<string, IngestJobStatus>();
  const ingests: Array<{ scope: string; payload: string; jobId: string }> = [];
  let seq = 0;

  const client: MemoryClient = {
    ingest(scope, payload) {
      const jobId = `job-${++seq}`;
      ingests.push({ scope, payload, jobId });
      const rows = rowsByScope.get(scope) ?? [];
      rows.push({ memoryId: `mem-${seq}`, kind: 'fact', content: payload });
      rowsByScope.set(scope, rows);
      jobStatuses.set(jobId, 'pending');
      return Promise.resolve({ jobId });
    },
    search(scope, query) {
      const rows = rowsByScope.get(scope) ?? [];
      return Promise.resolve(rows.filter((r) => r.content.includes(query)));
    },
    remove(scope, memoryId) {
      const rows = rowsByScope.get(scope) ?? [];
      rowsByScope.set(
        scope,
        rows.filter((r) => r.memoryId !== memoryId),
      );
      return Promise.resolve();
    },
    jobStatus(jobId) {
      return Promise.resolve(jobStatuses.get(jobId) ?? 'unknown');
    },
  };

  return { client, rowsByScope, jobStatuses, ingests };
}

function harness() {
  const lines: string[] = [];
  const logger = createLogger((m) => lines.push(m));
  const substrate = fakeSubstrate();
  const store = createUserStore({ client: substrate.client, logger });
  return { store, lines, logger, ...substrate };
}

describe('M3 writeProse', () => {
  it('ingests the prose byte-identical to the input — raw, unmodified', async () => {
    const { store, ingests } = harness();
    const text = '  I pretend to like spice — crème brûlée after, every time.\n\ttabs and all ';
    await store.writeProse('A', text);
    expect(ingests).toHaveLength(1);
    expect(ingests[0]?.scope).toBe('A');
    expect(ingests[0]?.payload).toBe(text); // exact bytes: no trim, no wrap, no JSON
  });

  it('the unconfirmed-drop warning fires for prose the substrate never confirmed', async () => {
    const { store, lines } = harness();
    await store.writeProse('A', 'a confession the process will die holding');
    const dropped = store.dropUnconfirmedProse();
    expect(dropped).toBe(1);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('dropping unconfirmed prose');
    expect(lines[0]).toContain('profile A');
  });

  it('confirmed prose is released — no warning, nothing to drop', async () => {
    const { store, lines, jobStatuses, ingests } = harness();
    await store.writeProse('A', 'a confession that settles');
    const jobId = ingests[0]?.jobId ?? '';
    jobStatuses.set(jobId, 'complete');
    await store.verifyPendingProse();
    expect(store.dropUnconfirmedProse()).toBe(0);
    expect(lines).toEqual([]);
  });

  it('a failed ingest is retried once with the same raw text, then dropped with a warning', async () => {
    const { store, lines, jobStatuses, ingests } = harness();
    const text = 'a confession the substrate keeps refusing';
    await store.writeProse('A', text);
    jobStatuses.set(ingests[0]?.jobId ?? '', 'failed');
    await store.verifyPendingProse();
    expect(ingests).toHaveLength(2); // the retry half of verify-and-retry
    expect(ingests[1]?.payload).toBe(text);
    jobStatuses.set(ingests[1]?.jobId ?? '', 'failed');
    await store.verifyPendingProse();
    expect(ingests).toHaveLength(2); // one retry, not a loop
    expect(lines.some((l) => l.includes('failed after retry'))).toBe(true);
    expect(store.dropUnconfirmedProse()).toBe(0); // already accounted for
  });
});

describe('M3 usual', () => {
  it('setUsual then usual round-trips, including offLimits', async () => {
    const { store } = harness();
    const usual: UsualProfile = { ...sampleUsual, offLimits: ['fasting', 'creme brulee'] };
    await store.setUsual('A', usual);
    const back = await store.usual('A');
    expect(back).toEqual(usual);
    expect(back?.offLimits).toEqual(['fasting', 'creme brulee']);
  });

  it('a fresh profile has no usual', async () => {
    const { store } = harness();
    expect(await store.usual('nobody')).toBeNull();
  });

  it('persists through the substrate: a second store instance reads what the first wrote', async () => {
    const { store, client } = harness();
    await store.setUsual('B', sampleUsual);
    const second = createUserStore({ client, logger: createLogger(() => {}) });
    expect(await second.usual('B')).toEqual(sampleUsual);
  });

  it('replaces rather than accumulates — one usual record per profile', async () => {
    const { store, rowsByScope } = harness();
    await store.setUsual('A', sampleUsual);
    await store.setUsual('A', { ...sampleUsual, spiceTolerance: 3 });
    const usualRows = (rowsByScope.get('A') ?? []).filter((r) => r.content.includes('confit:usual'));
    expect(usualRows).toHaveLength(1);
    expect((await store.usual('A'))?.spiceTolerance).toBe(3);
  });

  it('returned objects are copies — mutating them does not corrupt the store', async () => {
    const { store } = harness();
    await store.setUsual('A', sampleUsual);
    const first = await store.usual('A');
    first?.offLimits.push('injected');
    expect((await store.usual('A'))?.offLimits).toEqual(sampleUsual.offLimits);
  });

  it('ignores garbage and prose rows when reading the usual', async () => {
    const { store, client } = harness();
    await client.ingest('A', 'raw prose mentioning confit:usual in passing');
    await client.ingest('A', '{"kind":"confit:usual","usual":{"broken":true}}');
    expect(await store.usual('A')).toBeNull();
  });
});

describe('M3 meal log', () => {
  it('setMealLog then mealLog round-trips; a fresh profile is empty', async () => {
    const { store } = harness();
    expect(await store.mealLog('A')).toEqual([]);
    const entries = [
      { dishId: 'shoyu_ramen', placeId: 'noodle_shrine', at: '2026-07-19', felt: 'glad' as const },
      { dishId: 'shoyu_ramen', placeId: 'noodle_shrine', at: '2026-07-23' },
    ];
    await store.setMealLog('A', entries);
    expect(await store.mealLog('A')).toEqual(entries);
  });

  it('meal log persists to a second instance through the substrate', async () => {
    const { store, client } = harness();
    const entries = [{ dishId: 'al_pastor', placeId: 'rosas_taqueria', at: '2026-07-01' }];
    await store.setMealLog('B', entries);
    const second = createUserStore({ client, logger: createLogger(() => {}) });
    expect(await second.mealLog('B')).toEqual(entries);
  });
});
