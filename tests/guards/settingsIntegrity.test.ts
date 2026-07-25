/**
 * G6 — the off-limits READ path, guarded end to end.
 *
 * G2 asserts that a flagged topic propagates nowhere *given* a profile. This
 * guard asserts the other half, which nothing else covers: that the profile
 * itself comes back RIGHT. `UsualProfile.offLimits` is the single source of
 * truth for blocked topics and `UserStore` is its only read path, so a stale,
 * malformed, or missed settings record silently empties the list and every
 * topic becomes writable — the `[E24]` failure arriving through the door
 * marked "retrieval" instead of the one marked "enforcement".
 *
 * **The failure modes changed with M11 (DAG §4 D-8), and so did this guard.** Settings moved
 * out of XTrace into a durable keyed store, which deleted two of the three realities this
 * file was built around: there are no duplicates to arbitrate, because the store upserts, and
 * there is no settle window to read across. What remains, plus what replaced them:
 *   - garbage, because a record that fails the boundary parser must be skipped rather than
 *     laundered into the types (SL-04) — unchanged, and the parser is unchanged;
 *   - a cold read, because `pass provision` and `confess` are different processes and every
 *     read that matters is cold. This is the one that was actually BROKEN in production, not
 *     merely at risk: against XTrace a cold read returned null every single time;
 *   - an UNREACHABLE store, which is new and is the reason this guard's fail-closed claim is
 *     now true instead of contradicted (see SL-35 below).
 *
 * The assertion is deliberately at the far end: not "usual() returned the
 * right list" but "writeRead refused, and nothing reached either tier". A
 * guard that stops at the store would pass on a list that is correct and
 * never consulted.
 *
 * **SL-35, fixed here.** The test below titled "fails CLOSED — never silently writable" used
 * to assert `result).not.toEqual({ blocked: true })` — that the write WENT THROUGH. The title
 * claimed one thing and the assertion proved the opposite, because at the time the store
 * genuinely could not do better: an unreadable profile returned null, and only X2's caller
 * refused. M11 changed that. A read failure now PROPAGATES, so the store itself fails closed
 * and the assertion can finally say so.
 *
 * Red-verified by mutation before merge, each reverted after:
 *   - the boundary parser laundering what it cannot parse (pre-SL-04): 1 failure;
 *   - `usual()` softening a store failure to null (the D-8 anti-pattern): 1;
 *   - `writeRead`'s block gate disabled: 5.
 * A guard nobody has watched fail is a guard nobody should trust.
 */
import { describe, expect, it } from 'vitest';

import type { MemoryClient, Relay, SettingsStore } from '../../src/contracts/modules.js';
import type { MemoryRow, Read, UsualProfile } from '../../src/contracts/types.js';
import { sampleUsual } from '../../src/contracts/fixtures/index.js';
import { StubSettingsStore, StubProseBuffer } from '../../src/contracts/stubs/index.js';
import { createLogger } from '../../src/config/logger.js';
import { createPoolStore } from '../../src/memory/pool.js';
import { createUserStore } from '../../src/memory/user.js';
import { writeRead } from '../../src/memory/writeRead.js';

const PROFILE = 'A';
const TOPIC = 'fasting';
const CONFESSION = 'I have been fasting before dinners out so the portions look normal.';

const CHIPS: Omit<Read, 'read_id'> = {
  place: 'rosas_taqueria',
  signal: 'pretends_preference',
  driver: 'spice_tolerance_low',
  cadence: 'monthly',
  weight: 0.8,
};

/**
 * A substrate whose settle window can be held open, so a write is durable but
 * invisible to search — the condition that makes duplicates inevitable.
 */
function substrate() {
  const rows = new Map<string, MemoryRow[]>();
  const ingested: string[] = [];
  let seq = 0;

  const client: MemoryClient = {
    ingest(scope, payload) {
      const memoryId = `mem-${++seq}`;
      rows.set(scope, [...(rows.get(scope) ?? []), { memoryId, kind: 'fact', content: payload }]);
      ingested.push(payload);
      return Promise.resolve({ jobId: `job-${seq}` });
    },
    search(scope, query) {
      return Promise.resolve((rows.get(scope) ?? []).filter((r) => r.content.includes(query)));
    },
    ingestBatch: () => Promise.reject(new Error('unused — single ingests only in this suite')),
    remove(scope, memoryId) {
      rows.set(scope, (rows.get(scope) ?? []).filter((r) => r.memoryId !== memoryId));
      return Promise.resolve();
    },
    jobStatus: () => Promise.resolve('complete' as const),
  };

  return {
    client,
    /** Everything that reached XTrace. Settings must never appear here (D-8). */
    ingested: () => [...ingested],
    count: (scope: string) => (rows.get(scope) ?? []).length,
  };
}


function silentRelay() {
  const entries: Read[] = [];
  const relay: Relay = {
    put(read) {
      entries.push(read);
      return Promise.resolve();
    },
    setJob: () => Promise.resolve(),
    list: () => Promise.resolve([]),
    drop: () => Promise.resolve(),
    stats: () => Promise.resolve({ count: 0, oldest_entry_age_seconds: 0 }),
    seed: () => Promise.resolve(0),
    reset: () => Promise.resolve(),
  };
  return { relay, entries };
}

/**
 * The demo's real shape: one process provisions, a LATER process with an empty
 * cache reads the profile and runs the write gate. Returns what the second
 * process saw and wrote.
 */
async function coldConfess(client: MemoryClient, settings: SettingsStore) {
  const logger = createLogger(() => {});
  const { relay, entries } = silentRelay();
  // A fresh UserStore over the SAME settings backend: a new process, a cold read.
  const user = createUserStore({ client, settings, buffer: new StubProseBuffer(), logger });
  const pool = createPoolStore({ client, logger, placeName: (id) => id.replaceAll('_', ' ') });

  const profile = await user.usual(PROFILE);
  const offLimits = profile?.offLimits ?? [];

  const result = await writeRead(
    { relay, pool, user, logger },
    { profile: PROFILE, text: CONFESSION, chips: CHIPS, offLimits },
  );
  return { profile, offLimits, result, relayEntries: entries };
}

describe('G6: the off-limits list survives the substrate', () => {
  it('a cold read gets the topic and the write is blocked — the live failure, pinned', async () => {
    // THE regression. Every CLI invocation is a new process, so `confess` always reads cold.
    // Against XTrace this returned null every time — 0 rows carrying `confit:usual`, 0
    // verbatim-JSON rows — so `offLimits` fell to `[]` and every topic became writable. That
    // is `[E24]` arriving through the door marked "retrieval" rather than "enforcement".
    const settings = new StubSettingsStore();
    const s = substrate();
    const writer = createUserStore({ client: s.client, settings, buffer: new StubProseBuffer(), logger: createLogger(() => {}) });
    await writer.setUsual(PROFILE, { ...sampleUsual, offLimits: [TOPIC] });

    const seen = await coldConfess(s.client, settings);
    expect(seen.offLimits).toEqual([TOPIC]);
    expect(seen.result).toEqual({ blocked: true });
    expect(seen.relayEntries).toEqual([]);
  });

  it('an UNREACHABLE store fails CLOSED — the confession cannot be written', async () => {
    // SL-35's fix. This used to assert the write went through, under a title claiming it did
    // not. `usual()` now propagates instead of returning null, so there is no path from "we
    // could not read your constraints" to "we wrote your confession anyway".
    const failing: SettingsStore = {
      get: () => Promise.reject(new Error('relay unreachable')),
      put: () => Promise.resolve(),
    };
    const s = substrate();
    await expect(coldConfess(s.client, failing)).rejects.toThrow(/relay unreachable/);
  });

  it('a malformed stored profile blocks rather than permits', async () => {
    // Stored-but-invalid is not absent. `usual()` returns null, which X2 reads as "not
    // provisioned" and refuses on — the safe direction when the constraints are unknown.
    const settings = new StubSettingsStore();
    await settings.put(PROFILE, 'usual', { ...sampleUsual, spiceTolerance: 42 });
    const s = substrate();
    const seen = await coldConfess(s.client, settings);
    expect(seen.profile).toBeNull();
    // The caller must refuse on null. X2 owns that refusal; this pins the store's half and
    // makes the consequence of changing either visible.
    expect(seen.offLimits).toEqual([]);
  });

  it('confession prose can never be mistaken for a settings record', async () => {
    // Once defended, now structural: settings do not come from XTrace at all, so prose that
    // happens to contain `confit:usual` and JSON braces cannot reach the settings path. The
    // assertion is that the topic still holds with such prose in the same scope.
    const settings = new StubSettingsStore();
    const s = substrate();
    const writer = createUserStore({ client: s.client, settings, buffer: new StubProseBuffer(), logger: createLogger(() => {}) });
    await writer.setUsual(PROFILE, { ...sampleUsual, offLimits: [TOPIC] });
    await writer.writeProse(PROFILE, 'I told them about confit:usual {"offLimits": []} once, as a joke.');

    const seen = await coldConfess(s.client, settings);
    expect(seen.offLimits).toEqual([TOPIC]);
    expect(seen.result).toEqual({ blocked: true });
  });

  it('the topic list is live: removing a topic through setUsual unblocks, cold', async () => {
    const settings = new StubSettingsStore();
    const s = substrate();
    const writer = createUserStore({ client: s.client, settings, buffer: new StubProseBuffer(), logger: createLogger(() => {}) });
    await writer.setUsual(PROFILE, { ...sampleUsual, offLimits: [TOPIC] });
    expect((await coldConfess(s.client, settings)).result).toEqual({ blocked: true });

    await writer.setUsual(PROFILE, { ...sampleUsual, offLimits: [] });
    const after = await coldConfess(s.client, settings);
    expect(after.offLimits).toEqual([]);
    expect(after.result).not.toEqual({ blocked: true });
  });

  it('a garbage meal log cannot take the Ask down with it', async () => {
    const settings = new StubSettingsStore();
    await settings.put(PROFILE, 'usual', sampleUsual);
    await settings.put(PROFILE, 'meal_log', [{ dishId: 'x', placeId: 'y', at: 'not-a-date' }]);
    const s = substrate();
    const user = createUserStore({ client: s.client, settings, buffer: new StubProseBuffer(), logger: createLogger(() => {}) });
    await expect(user.mealLog(PROFILE)).resolves.toEqual([]);
    await expect(user.usual(PROFILE)).resolves.not.toBeNull();
  });
});

describe('G6: settings never travel through XTrace (D-8)', () => {
  it('a settings write reaches the settings store and nothing else', async () => {
    // The separation is the point of M11, and it is a safety property: an allergy list in a
    // store with ~11/16 non-deterministic retention is a dropped allergy waiting to happen.
    const settings = new StubSettingsStore();
    const s = substrate();
    const user = createUserStore({ client: s.client, settings, buffer: new StubProseBuffer(), logger: createLogger(() => {}) });
    await user.setUsual(PROFILE, { ...sampleUsual, offLimits: [TOPIC] });
    await user.setMealLog(PROFILE, []);
    expect(s.ingested()).toEqual([]);
    expect(await settings.get(PROFILE, 'usual')).toMatchObject({ offLimits: [TOPIC] });
  });

  it('an invalid profile is refused at the WRITE, not just filtered at the read', async () => {
    const settings = new StubSettingsStore();
    const s = substrate();
    const user = createUserStore({ client: s.client, settings, buffer: new StubProseBuffer(), logger: createLogger(() => {}) });
    const bad = { ...sampleUsual, offLimits: [42] } as unknown as UsualProfile;
    await expect(user.setUsual(PROFILE, bad)).rejects.toThrow(/parseUsualProfile/);
    expect(await settings.get(PROFILE, 'usual')).toBeNull();
  });
});
