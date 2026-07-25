import { describe, expect, it } from 'vitest';

import type { MemoryClient } from '../contracts/modules.js';
import type { IngestJobStatus, MemoryRow, UsualProfile } from '../contracts/types.js';
import { sampleUsual } from '../contracts/fixtures/index.js';
import { createLogger } from '../config/logger.js';
import { createUserStore } from './user.js';

/**
 * Fake substrate: per-scope rows, searchable by naive substring, removable,
 * with per-job controllable status, plus a manual settle mode — rows ingested
 * under it are invisible to search until settleAll(), simulating XTrace's
 * ingest→retrievable window (the condition behind the PR #22 review).
 */
function fakeSubstrate() {
  const rowsByScope = new Map<string, MemoryRow[]>();
  const jobStatuses = new Map<string, IngestJobStatus>();
  const ingests: Array<{ scope: string; payload: string; jobId: string }> = [];
  const unsettled = new Set<string>();
  let manualSettle = false;
  let seq = 0;

  const client: MemoryClient = {
    ingest(scope, payload) {
      const jobId = `job-${++seq}`;
      ingests.push({ scope, payload, jobId });
      const rows = rowsByScope.get(scope) ?? [];
      const memoryId = `mem-${seq}`;
      rows.push({ memoryId, kind: 'fact', content: payload });
      if (manualSettle) unsettled.add(memoryId);
      rowsByScope.set(scope, rows);
      jobStatuses.set(jobId, 'pending');
      return Promise.resolve({ jobId });
    },
    search(scope, query) {
      const rows = rowsByScope.get(scope) ?? [];
      return Promise.resolve(
        rows.filter((r) => !unsettled.has(r.memoryId) && r.content.includes(query)),
      );
    },
    ingestBatch: () => Promise.reject(new Error('unused — single ingests only in this suite')),
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

  return {
    client,
    rowsByScope,
    jobStatuses,
    ingests,
    enableManualSettle: () => {
      manualSettle = true;
    },
    settleAll: () => {
      unsettled.clear();
    },
    countTagged: (scope: string, kind: string) =>
      (rowsByScope.get(scope) ?? []).filter((r) => r.content.includes(kind)).length,
  };
}

/** Deterministic monotonic clock for written_at stamps. */
function tickingClock() {
  let tick = 0;
  return () => `2026-07-25T12:00:${String(tick++).padStart(2, '0')}.000Z`;
}

function harness() {
  const lines: string[] = [];
  const logger = createLogger((m) => lines.push(m));
  const substrate = fakeSubstrate();
  const store = createUserStore({ client: substrate.client, logger, now: tickingClock() });
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

describe('M3 usual — duplicates and misses (PR #22 review)', () => {
  it('two competing settings records: the NEWEST wins on a cold cache, even listed first-is-stale', async () => {
    const h = harness();
    h.enableManualSettle();
    // Write v1; it is still inside the settle window when v2 is written, so
    // replaceTagged cannot see it and cannot remove it — the review's stale-
    // duplicate scenario. Both then settle; a fresh store reads cold.
    await h.store.setUsual('A', { ...sampleUsual, offLimits: ['fasting'] });
    await h.store.setUsual('A', { ...sampleUsual, offLimits: ['fasting', 'gluten'] });
    h.settleAll();
    expect(h.countTagged('A', 'confit:usual')).toBe(2); // the duplicate exists…

    const cold = createUserStore({ client: h.client, logger: createLogger(() => {}) });
    const usual = await cold.usual('A');
    // …and written_at ordering, not luck, returns the newer list. The fake
    // returns rows in insertion order with the stale record first.
    expect(usual?.offLimits).toEqual(['fasting', 'gluten']);
  });

  it('a stamped record beats a legacy unstamped one regardless of order', async () => {
    const h = harness();
    // Hand-plant a legacy record (no written_at) first in insertion order.
    await h.client.ingest(
      'A',
      JSON.stringify({ kind: 'confit:usual', usual: { ...sampleUsual, offLimits: ['old-topic'] } }),
    );
    const fresh = createUserStore({ client: h.client, logger: createLogger(() => {}), now: tickingClock() });
    await fresh.setUsual('A', { ...sampleUsual, offLimits: ['new-topic'] });
    const cold = createUserStore({ client: h.client, logger: createLogger(() => {}) });
    expect((await cold.usual('A'))?.offLimits).toEqual(['new-topic']);
  });

  it('a search that omits the settings row entirely reads as null — the documented meaning', async () => {
    const h = harness();
    h.enableManualSettle();
    await h.store.setUsual('B', { ...sampleUsual, offLimits: ['fasting'] });
    // The record exists but never settles: a cold reader gets null. What the
    // WRITE path may do with null is an open contract question raised to the
    // integrator (see user.ts docblock) — this pins the store's half only.
    const cold = createUserStore({ client: h.client, logger: createLogger(() => {}) });
    expect(await cold.usual('B')).toBeNull();
  });

  it('meal log follows the same newest-wins rule across a cold cache', async () => {
    const h = harness();
    h.enableManualSettle();
    await h.store.setMealLog('A', [{ dishId: 'old_dish', placeId: 'p', at: '2026-07-01' }]);
    await h.store.setMealLog('A', [{ dishId: 'new_dish', placeId: 'p', at: '2026-07-20' }]);
    h.settleAll();
    const cold = createUserStore({ client: h.client, logger: createLogger(() => {}) });
    expect((await cold.mealLog('A'))[0]?.dishId).toBe('new_dish');
  });
});

describe('M3 boundary parsing (SL-04)', () => {
  it('an out-of-domain usual is skipped with a log line, never laundered into the types', async () => {
    const h = harness();
    await h.client.ingest(
      'A',
      JSON.stringify({
        kind: 'confit:usual',
        written_at: '2026-07-25T12:00:99.000Z', // newest by far
        usual: { spiceTolerance: 42, budgetBand: 99, portionPref: 'gigantic', soloComfort: true, giConstraint: false, offLimits: [] },
      }),
    );
    // A newer garbage record must not shadow an older valid one.
    await h.client.ingest(
      'A',
      JSON.stringify({
        kind: 'confit:usual',
        written_at: '2026-07-25T11:00:00.000Z',
        usual: { ...sampleUsual, offLimits: ['fasting'] },
      }),
    );
    const cold = createUserStore({ client: h.client, logger: createLogger((m) => h.lines.push(m)) });
    const usual = await cold.usual('A');
    expect(usual?.spiceTolerance).toBe(sampleUsual.spiceTolerance);
    expect(usual?.offLimits).toEqual(['fasting']);
    expect(h.lines.some((l) => l.includes('skipping malformed confit:usual'))).toBe(true);
  });

  it('garbage-only usual records read as null, not as a typed lie', async () => {
    const h = harness();
    await h.client.ingest(
      'B',
      JSON.stringify({ kind: 'confit:usual', usual: { spiceTolerance: 42 } }),
    );
    const cold = createUserStore({ client: h.client, logger: createLogger(() => {}) });
    expect(await cold.usual('B')).toBeNull();
  });

  it('extra keys in a stored usual are stripped — the returned object is exactly the contract shape', async () => {
    const h = harness();
    await h.client.ingest(
      'A',
      JSON.stringify({
        kind: 'confit:usual',
        written_at: '2026-07-25T12:00:50.000Z',
        usual: { ...sampleUsual, smuggled: 'not-a-contract-field' },
      }),
    );
    const cold = createUserStore({ client: h.client, logger: createLogger(() => {}) });
    const usual = await cold.usual('A');
    expect(usual).not.toBeNull();
    expect(Object.keys(usual ?? {})).not.toContain('smuggled');
  });

  it('a junk meal-log entry is skipped and logged — and K3 no longer throws (the SL-04 probe)', async () => {
    const h = harness();
    await h.client.ingest(
      'A',
      JSON.stringify({
        kind: 'confit:meal_log',
        written_at: '2026-07-25T12:00:50.000Z',
        entries: [
          { dishId: 'pho', placeId: 'x', at: '2026-07-20', felt: 'glad' },
          { dishId: 'pho', placeId: 'x', at: 'whenever' },
          'not-an-entry',
          { dishId: 'pho', placeId: 'x', at: '2026-07-21', felt: 'meh' },
        ],
      }),
    );
    const cold = createUserStore({ client: h.client, logger: createLogger((m) => h.lines.push(m)) });
    const log = await cold.mealLog('A');
    expect(log).toEqual([{ dishId: 'pho', placeId: 'x', at: '2026-07-20', felt: 'glad' }]);
    expect(h.lines.filter((l) => l.includes('skipping malformed meal-log entry'))).toHaveLength(3);
    // The probe that motivated SL-04: this used to throw out of K3.
    const { suppressions } = await import('../kernel/rotation.js');
    expect(() => suppressions(log, '2026-07-25')).not.toThrow();
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
