import { describe, expect, it } from 'vitest';

import type { MemoryClient, SettingsStore } from '../contracts/modules.js';
import type { IngestJobStatus, MealLogEntry, MemoryRow, UsualProfile } from '../contracts/types.js';
import { sampleUsual } from '../contracts/fixtures/index.js';
import { StubSettingsStore } from '../contracts/stubs/index.js';
import { createLogger } from '../config/logger.js';
import { createUserStore } from './user.js';

/** Fake XTrace: per-scope rows, per-job controllable status. Prose only, after M11. */
function fakeSubstrate() {
  const rowsByScope = new Map<string, MemoryRow[]>();
  const jobStatuses = new Map<string, IngestJobStatus>();
  const ingests: Array<{ scope: string; payload: string; jobId: string }> = [];
  let seq = 0;

  const client: MemoryClient = {
    ingest(scope, payload) {
      const jobId = `job-${++seq}`;
      ingests.push({ scope, payload, jobId });
      rowsByScope.set(scope, [
        ...(rowsByScope.get(scope) ?? []),
        { memoryId: `mem-${seq}`, kind: 'fact', content: payload },
      ]);
      jobStatuses.set(jobId, 'pending');
      return Promise.resolve({ jobId });
    },
    ingestBatch: () => Promise.reject(new Error('the user tier writes one message at a time')),
    search(scope, query) {
      return Promise.resolve(
        (rowsByScope.get(scope) ?? []).filter((r) => r.content.includes(query)),
      );
    },
    remove(scope, memoryId) {
      rowsByScope.set(scope, (rowsByScope.get(scope) ?? []).filter((r) => r.memoryId !== memoryId));
      return Promise.resolve();
    },
    jobStatus(jobId) {
      return Promise.resolve(jobStatuses.get(jobId) ?? 'unknown');
    },
  };

  return { client, rowsByScope, jobStatuses, ingests };
}

function harness(settings: SettingsStore = new StubSettingsStore()) {
  const lines: string[] = [];
  const logger = createLogger((m) => lines.push(m));
  const substrate = fakeSubstrate();
  const store = createUserStore({ client: substrate.client, settings, logger });
  return { store, lines, logger, settings, ...substrate };
}

describe('M3 writeProse — the EXPERIENCES half stays in XTrace (D-8)', () => {
  it('ingests the prose byte-identical to the input — raw, unmodified', async () => {
    const h = harness();
    const text = "  I ALWAYS get the pho, and honestly?? it's fine.  ";
    await h.store.writeProse('A', text);
    expect(h.ingests).toHaveLength(1);
    expect(h.ingests[0]?.payload).toBe(text); // [E11]: no trim, no clean, no wrapper
    expect(h.ingests[0]?.scope).toBe('A');
  });

  it('the unconfirmed-drop warning fires for prose the substrate never confirmed', async () => {
    const h = harness();
    await h.store.writeProse('A', 'a true thing');
    expect(h.store.dropUnconfirmedProse()).toBe(1);
    expect(h.lines.some((l) => l.includes('unconfirmed'))).toBe(true);
  });

  it('confirmed prose is released — no warning, nothing to drop', async () => {
    const h = harness();
    const handle = await h.store.writeProse('A', 'a true thing');
    h.jobStatuses.set(handle.jobId, 'complete');
    await h.store.verifyPendingProse();
    expect(h.store.dropUnconfirmedProse()).toBe(0);
  });

  it('a failed ingest is retried once with the same raw text, then dropped with a warning', async () => {
    const h = harness();
    const handle = await h.store.writeProse('A', 'the same words');
    h.jobStatuses.set(handle.jobId, 'failed');
    await h.store.verifyPendingProse();
    expect(h.ingests).toHaveLength(2);
    expect(h.ingests[1]?.payload).toBe('the same words');

    h.jobStatuses.set(h.ingests[1]?.jobId ?? '', 'failed');
    await h.store.verifyPendingProse();
    expect(h.ingests).toHaveLength(2); // one retry, not a loop
    expect(h.lines.some((l) => l.includes('failed after retry'))).toBe(true);
  });
});

describe('M3 settings — the DECLARED half is NOT in XTrace (M11, D-8)', () => {
  it('setUsual then usual round-trips, including offLimits', async () => {
    const h = harness();
    await h.store.setUsual('A', { ...sampleUsual, offLimits: ['shellfish', 'gluten'] });
    expect(await h.store.usual('A')).toMatchObject({ offLimits: ['shellfish', 'gluten'] });
  });

  it('a fresh profile has no usual', async () => {
    expect(await harness().store.usual('nobody')).toBeNull();
  });

  it('reads what a DIFFERENT store instance wrote — the failure that broke ask and confess', async () => {
    // The live bug, in one test. Every CLI invocation is a new process, so `confit confess`
    // and `confit ask` are always cold reads. Against XTrace this returned null every time:
    // `setUsual` wrote a tagged JSON record, extraction turned it into prose, and the tag and
    // the structure both vanished — 0 rows carrying `confit:usual`, 0 verbatim-JSON rows.
    const settings = new StubSettingsStore();
    await harness(settings).store.setUsual('A', sampleUsual);
    const second = harness(settings); // a different process, in effect
    expect(await second.store.usual('A')).toMatchObject({ spiceTolerance: sampleUsual.spiceTolerance });
  });

  it('writes settings to the settings store and NEVER to XTrace', async () => {
    // The separation D-8 asks for, asserted rather than assumed. A settings write that also
    // reached XTrace would put an allergy list into a store with ~11/16 retention.
    const h = harness();
    await h.store.setUsual('A', sampleUsual);
    await h.store.setMealLog('A', []);
    expect(h.ingests).toHaveLength(0);
    expect(h.rowsByScope.size).toBe(0);
  });

  it('overwrites rather than accumulating — no duplicates to arbitrate', async () => {
    // This replaces four tests that existed only because XTrace has no upsert: duplicate
    // records were GUARANTEED, so reads had to pick a winner by `written_at`. A keyed store
    // makes the whole class of bug unrepresentable, which is why that machinery is deleted
    // rather than ported.
    const h = harness();
    await h.store.setUsual('A', { ...sampleUsual, budgetBand: 1 });
    await h.store.setUsual('A', { ...sampleUsual, budgetBand: 4 });
    expect(await h.store.usual('A')).toMatchObject({ budgetBand: 4 });
  });

  it('one profile cannot read another\'s settings', async () => {
    const h = harness();
    await h.store.setUsual('A', sampleUsual);
    expect(await h.store.usual('B')).toBeNull();
  });

  it('returned objects are copies — mutating them does not corrupt the store', async () => {
    const h = harness();
    await h.store.setUsual('A', sampleUsual);
    const first = await h.store.usual('A');
    first?.offLimits.push('injected');
    expect((await h.store.usual('A'))?.offLimits).not.toContain('injected');
  });
});

describe('M3 settings — a read failure must NOT look like "no constraints"', () => {
  it('propagates a store failure instead of returning null', async () => {
    // The safety property behind D-8. X2 reads `usual() === null` as "not provisioned" and
    // proceeds; if an unreachable store produced null, an off-limits list would silently
    // become empty and a confession that should be blocked would be written to the pool.
    const failing: SettingsStore = {
      get: () => Promise.reject(new Error('relay unreachable')),
      put: () => Promise.resolve(),
    };
    await expect(harness(failing).store.usual('A')).rejects.toThrow(/relay unreachable/);
  });

  it('a stored-but-invalid profile reads as unprovisioned, loudly', async () => {
    // Blocks rather than permits: null makes X2 refuse the confession, which is the safe
    // direction when we cannot tell what the user's constraints are.
    const settings = new StubSettingsStore();
    await settings.put('A', 'usual', { spiceTolerance: 42 });
    const h = harness(settings);
    expect(await h.store.usual('A')).toBeNull();
    expect(h.lines.some((l) => l.includes('failed the boundary parser'))).toBe(true);
  });

  it('refuses to STORE a profile that fails the parser', async () => {
    // setUsual is the only write path for off-limits topics (G2, X7, U4). A caller with a
    // hand-built object does not get to put an unhonourable constraint into durable storage.
    const h = harness();
    const bad = { ...sampleUsual, budgetBand: 9 } as unknown as UsualProfile;
    await expect(h.store.setUsual('A', bad)).rejects.toThrow(/parseUsualProfile/);
    expect(await h.store.usual('A')).toBeNull(); // nothing was written
  });
});

describe('M3 boundary parsing (SL-04)', () => {
  const cases: Array<[string, unknown]> = [
    ['spiceTolerance out of domain', { ...sampleUsual, spiceTolerance: 42 }],
    ['budgetBand out of domain', { ...sampleUsual, budgetBand: 0 }],
    ['portionPref not in the enum', { ...sampleUsual, portionPref: 'gigantic' }],
    ['soloComfort not a boolean', { ...sampleUsual, soloComfort: 'yes' }],
    ['offLimits not an array of strings', { ...sampleUsual, offLimits: [1, 2] }],
    ['defaultOrder missing a dishId', { ...sampleUsual, defaultOrder: { placeId: 'p' } }],
    ['not an object at all', 'a sentence about my preferences'],
    ['null', null],
  ];

  it.each(cases)('%s is never laundered into the types', async (_label, stored) => {
    // The SL-04 failure: a predicate that checked `typeof` and claimed `value is UsualProfile`
    // put `spiceTolerance: 42` into the type system, where it silently disabled K4's spice and
    // budget constraints. These read as null.
    const settings = new StubSettingsStore();
    await settings.put('A', 'usual', stored);
    expect(await harness(settings).store.usual('A')).toBeNull();
  });

  it('strips extra keys — the returned object is exactly the contract shape', async () => {
    const settings = new StubSettingsStore();
    await settings.put('A', 'usual', { ...sampleUsual, smuggled: 'nope', written_at: 'x' });
    const usual = await harness(settings).store.usual('A');
    expect(usual).not.toBeNull();
    expect(Object.keys(usual ?? {}).sort()).toEqual(
      [
        'budgetBand',
        'defaultOrder',
        'giConstraint',
        'offLimits',
        'portionPref',
        'soloComfort',
        'spiceTolerance',
      ].filter((k) => k !== 'defaultOrder' || sampleUsual.defaultOrder !== undefined),
    );
  });
});

describe('M3 meal log', () => {
  const entry: MealLogEntry = { dishId: 'pho_ga', placeId: 'phos_deep', at: '2026-07-01' };

  it('setMealLog then mealLog round-trips; a fresh profile is empty', async () => {
    const h = harness();
    expect(await h.store.mealLog('A')).toEqual([]);
    await h.store.setMealLog('A', [entry]);
    expect(await h.store.mealLog('A')).toEqual([entry]);
  });

  it('a junk entry is skipped and logged — K3 never sees an unparseable date', async () => {
    const settings = new StubSettingsStore();
    await settings.put('A', 'meal_log', [entry, { dishId: 'x', placeId: 'y', at: 'not-a-date' }]);
    const h = harness(settings);
    expect(await h.store.mealLog('A')).toEqual([entry]);
    expect(h.lines.some((l) => l.includes('malformed meal-log entry'))).toBe(true);
  });

  it('a stored non-array reads as empty, with a line saying so', async () => {
    const settings = new StubSettingsStore();
    await settings.put('A', 'meal_log', { not: 'an array' });
    const h = harness(settings);
    expect(await h.store.mealLog('A')).toEqual([]);
    expect(h.lines.some((l) => l.includes('is not an array'))).toBe(true);
  });

  it('reads across store instances, like every CLI invocation does', async () => {
    const settings = new StubSettingsStore();
    await harness(settings).store.setMealLog('A', [entry]);
    expect(await harness(settings).store.mealLog('A')).toEqual([entry]);
  });
});
