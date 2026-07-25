import { describe, expect, it } from 'vitest';

import type { MemoryClient, SettingsStore } from '../contracts/modules.js';
import type { IngestJobStatus, MealLogEntry, MemoryRow, UsualProfile } from '../contracts/types.js';
import { sampleUsual } from '../contracts/fixtures/index.js';
import { StubSettingsStore } from '../contracts/stubs/index.js';
import { createLogger } from '../config/logger.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUserStore } from './user.js';
import { BATCH_SIZE, createProseBuffer } from './proseBuffer.js';
import { personalScope } from './scopes.js';

/** Fake XTrace: per-scope rows, per-job controllable status. Prose only, after M11. */
function fakeSubstrate() {
  const rowsByScope = new Map<string, MemoryRow[]>();
  const jobStatuses = new Map<string, IngestJobStatus>();
  const ingests: Array<{ scope: string; payload: string; jobId: string }> = [];
  const batches: Array<{ scope: string; payloads: string[]; convId: string }> = [];
  let seq = 0;
  let batchesFail = false;

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
    ingestBatch(scope, payloads, convId) {
      if (batchesFail) return Promise.reject(new Error('ingest 503'));
      batches.push({ scope, payloads: [...payloads], convId });
      for (const payload of payloads) {
        seq += 1;
        rowsByScope.set(scope, [
          ...(rowsByScope.get(scope) ?? []),
          { memoryId: `mem-${seq}`, kind: 'fact', content: payload },
        ]);
      }
      seq += 1;
      return Promise.resolve({ jobId: `batch-${seq}` });
    },
    search(scope, _query) {
      // Every row in the scope, NOT a substring match. The substring filter modelled
      // `findTagged`'s tag lookup, which M11 deleted — and semantic search does not
      // substring-match, so filtering here would model a substrate that does not exist and
      // quietly hide rows a real query would return.
      return Promise.resolve([...(rowsByScope.get(scope) ?? [])]);
    },
    remove(scope, memoryId) {
      rowsByScope.set(scope, (rowsByScope.get(scope) ?? []).filter((r) => r.memoryId !== memoryId));
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
    batches,
    failBatches: () => {
      batchesFail = true;
    },
  };
}

function harness(settings: SettingsStore = new StubSettingsStore()) {
  const lines: string[] = [];
  const logger = createLogger((m) => lines.push(m));
  const substrate = fakeSubstrate();
  // A real buffer over a temp file: batching is the behaviour under test, and a fake buffer
  // would let a broken threshold pass.
  const path = mkdtempSync(join(tmpdir(), 'confit-prose-'));
  const buffer = createProseBuffer({ path });
  const store = createUserStore({ client: substrate.client, settings, buffer, logger });
  return { store, lines, logger, settings, buffer, ...substrate };
}

describe('M3 writeProse — batched into XTrace, not one at a time (M20)', () => {
  it('holds a confession rather than ingesting it immediately', async () => {
    // The change. XTrace generates an episode per ingest CALL, so one-at-a-time ingests can
    // only ever produce per-confession paraphrases — measured, 8 confessions gave 8 episodes
    // across 8 conv_ids.
    const h = harness();
    const result = await h.store.writeProse('A', 'a true thing');
    expect(result).toEqual({ buffered: 1 });
    expect(h.ingests).toHaveLength(0);
    expect(h.batches).toHaveLength(0);
  });

  it('sends the batch as ONE call once the threshold is reached', async () => {
    const h = harness();
    for (let i = 1; i < BATCH_SIZE; i++) await h.store.writeProse('A', `thing ${String(i)}`);
    expect(h.batches).toHaveLength(0);

    const last = await h.store.writeProse('A', 'the last one');
    expect(last.buffered).toBe(0);
    expect(last.jobId).toBeTruthy();
    // ONE call carrying all of them — not BATCH_SIZE calls sharing a conv_id, which was
    // measured NOT to merge into a single episode.
    expect(h.batches).toHaveLength(1);
    expect(h.batches[0]?.payloads).toHaveLength(BATCH_SIZE);
    expect(h.ingests).toHaveLength(0);
  });

  it('sends the text byte-identical — [E11] survives buffering', async () => {
    // Buffering changes WHEN a confession is ingested, never WHAT.
    const h = harness();
    const text = "  I ALWAYS get the pho, and honestly?? it's fine.  ";
    await h.store.writeProse('A', text);
    for (let i = 1; i < BATCH_SIZE; i++) await h.store.writeProse('A', `filler ${String(i)}`);
    expect(h.batches[0]?.payloads[0]).toBe(text); // no trim, no clean, no wrapper
  });

  it('scopes the batch to the profile, and keeps profiles apart', async () => {
    const h = harness();
    for (let i = 0; i < BATCH_SIZE; i++) await h.store.writeProse('A', `a${String(i)}`);
    await h.store.writeProse('B', 'b0');
    expect(h.batches).toHaveLength(1);
    expect(h.batches[0]?.scope).toBe(personalScope('A'));
    expect(h.buffer.pending('B')).toBe(1);
    expect(h.buffer.pending('A')).toBe(0);
  });

  it('flushProse sends what is waiting, whatever the count', async () => {
    // The size threshold alone would leave a profile's last few confessions unsent forever.
    // `pass sweep` calls this.
    const h = harness();
    await h.store.writeProse('A', 'one');
    await h.store.writeProse('B', 'two');
    expect(await h.store.flushProse()).toBe(2);
    expect(h.batches.map((b) => b.scope).sort()).toEqual(
      [personalScope('A'), personalScope('B')].sort(),
    );
    expect(await h.store.flushProse()).toBe(0); // nothing left
  });

  it('each batch is its own conversation, so each gets its own episode', async () => {
    const h = harness();
    await h.store.writeProse('A', 'first');
    await h.store.flushProse();
    await h.store.writeProse('A', 'second');
    await h.store.flushProse();
    const convIds = h.batches.map((b) => b.convId);
    expect(new Set(convIds).size).toBe(2);
  });

  it('a failed flush loses the batch, and says so — D-10 accepts that', async () => {
    // The alternative is holding until confirmed, which is the delivery guarantee D-10
    // declined. What must not happen is silence.
    const h = harness();
    h.failBatches();
    await h.store.writeProse('A', 'one');
    expect(await h.store.flushProse()).toBe(0);
    expect(h.lines.join('\n')).toMatch(/flush FAILED for A/);
    expect(h.lines.join('\n')).toMatch(/D-10 accepts/);
    expect(h.buffer.pending('A')).toBe(0); // gone, not silently retried forever
  });

  it('a failed BATCH send says how many were lost, not "a confession" (SL-41)', async () => {
    // The batch is out of the buffer before the ingest, so a 503 on the flushing confession
    // destroys all four — while `writeRead`'s warning is about "this confession" and would
    // report four lost as one write that did not happen. `writeProse` had no `try` at all
    // here, so the count reached neither stream.
    const h = harness();
    h.failBatches();
    for (let i = 0; i < BATCH_SIZE - 1; i++) await h.store.writeProse('A', `held ${String(i)}`);
    await expect(h.store.writeProse('A', 'the one that triggers the send')).rejects.toThrow(
      new RegExp(`batch of ${String(BATCH_SIZE)} confession`),
    );
    const logged = h.lines.join('\n');
    expect(logged).toMatch(new RegExp(`LOST ${String(BATCH_SIZE)} buffered confession`));
    expect(logged).toMatch(/not recoverable \(D-10\)/);
    expect(logged).toContain('ingest 503');
    // And they really are gone rather than silently retried for ever.
    expect(h.buffer.pending('A')).toBe(0);
  });

  it('survives the process: a new store sees what an earlier one buffered', async () => {
    // The reason it is a file at all. Every confession arrives in its own CLI process, so
    // batching is impossible without holding the text across them. Two stores over one
    // buffer file stand in for two `confit confess` invocations.
    const buffer = createProseBuffer({ path: mkdtempSync(join(tmpdir(), 'confit-prose-')) });
    const substrate = fakeSubstrate();
    const store = () =>
      createUserStore({
        client: substrate.client,
        settings: new StubSettingsStore(),
        buffer,
        logger: createLogger(() => undefined),
      });

    await store().writeProse('A', 'from process one');
    await store().writeProse('A', 'from process two');
    expect(await store().flushProse()).toBe(2);
    expect(substrate.batches).toHaveLength(1);
    expect(substrate.batches[0]?.payloads).toEqual(['from process one', 'from process two']);
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

describe('M3 personalClaim — D-8\'s second input (M16)', () => {
  it('returns the episode: the synthesis, not one lifted sentence', async () => {
    // A fact is one sentence the extractor pulled from one confession. An episode is the
    // synthesis across several, which is the only thing worth putting on a card.
    const h = harness();
    h.rowsByScope.set(personalScope('A'), [
      { memoryId: 'f1', kind: 'fact', content: 'User regretted the pho.' },
      { memoryId: 'e1', kind: 'episode', content: 'You keep going back to places you complain about.' },
    ]);
    expect(await h.store.personalClaim('A', 'what do they keep doing')).toBe(
      'You keep going back to places you complain about.',
    );
  });

  it('no episode means no claim — \'\', never a fact standing in for one', async () => {
    const h = harness();
    h.rowsByScope.set(personalScope('A'), [
      { memoryId: 'f1', kind: 'fact', content: 'User ate pho once.' },
    ]);
    expect(await h.store.personalClaim('A', 'anything')).toBe('');
  });

  it('an empty scope is \'\', not a throw — a new user has nothing yet', async () => {
    // No floor, by the owner's ruling. Absence is a normal outcome, not an error.
    expect(await harness().store.personalClaim('nobody', 'anything')).toBe('');
  });

  it('logs the counts behind the claim, so a thin one is attributable', async () => {
    // What makes "let's see what happens" produce evidence rather than an absence. Without
    // this, a disappointing claim is indistinguishable from a broken query.
    const h = harness();
    h.rowsByScope.set(personalScope('A'), [
      { memoryId: 'f1', kind: 'fact', content: 'one' },
      { memoryId: 'f2', kind: 'fact', content: 'two' },
      { memoryId: 'e1', kind: 'episode', content: 'a pattern' },
    ]);
    await h.store.personalClaim('A', 'q');
    expect(h.lines.join('\n')).toMatch(/1 episode\(s\) over 2 fact\(s\)/);
  });

  it('says so when there was nothing usable', async () => {
    const h = harness();
    await h.store.personalClaim('A', 'q');
    expect(h.lines.join('\n')).toContain('none usable');
  });

  it('reserves headroom for the episode, because facts sort first', async () => {
    // Measured on the live API for the pool query: every fact comes before any episode, and
    // the first episode landed at index 10. A personal scope is thick with prose facts — one
    // confession yields several — so a small top-k returns facts only. M13: `episode_slots`
    // is sent and cannot be relied on, so the headroom carries the guarantee.
    const h = harness();
    const seen: Array<{ topK: number; episodeSlots: number }> = [];
    const spy = {
      ...h.client,
      search: (_s: string, _q: string, opts: { topK: number; episodeSlots: number }) => {
        seen.push(opts);
        return Promise.resolve([]);
      },
    };
    const store = createUserStore({
      client: spy,
      settings: new StubSettingsStore(),
      buffer: createProseBuffer({ path: join(mkdtempSync(join(tmpdir(), 'confit-prose-')), 'b.json') }),
      logger: createLogger(() => undefined),
    });
    await store.personalClaim('A', 'q');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.topK ?? 0).toBeGreaterThanOrEqual(40);
    expect(seen[0]?.episodeSlots ?? 0).toBeGreaterThan(0);
  });

  it('queries the user\'s OWN scope, never the pool', async () => {
    // The whole point of D-8's second input. Querying confit:pool here would make the
    // "personal" claim a second copy of the group claim.
    const h = harness();
    const scopes: string[] = [];
    const spy = { ...h.client, search: (scope: string) => {
      scopes.push(scope);
      return Promise.resolve([]);
    } };
    const store = createUserStore({
      client: spy,
      settings: new StubSettingsStore(),
      buffer: createProseBuffer({ path: join(mkdtempSync(join(tmpdir(), 'confit-prose-')), 'b.json') }),
      logger: createLogger(() => undefined),
    });
    await store.personalClaim('profile-B', 'q');
    expect(scopes).toEqual([personalScope('profile-B')]);
  });
});
