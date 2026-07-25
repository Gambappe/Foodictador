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
 * Three substrate realities are exercised against the REAL store and the REAL
 * write path, because each of them has already produced a defect:
 *   - duplicates, because XTrace has no upsert and a rewrite inside the settle
 *     window cannot see its predecessor (PR #22 review);
 *   - garbage, because a record that fails the boundary parser must be skipped
 *     rather than laundered into the types (SL-04);
 *   - a cold cache, because `pass provision` and `confess` are different
 *     processes and every read that matters is cold.
 *
 * The assertion is deliberately at the far end: not "usual() returned the
 * right list" but "writeRead refused, and nothing reached either tier". A
 * guard that stops at the store would pass on a list that is correct and
 * never consulted.
 *
 * Red-verified by mutation before merge, each reverted after:
 *   - newest-wins → first-parsed-wins (the pre-#37 rule): 2 failures;
 *   - the boundary parser laundering what it cannot parse (pre-SL-04): 1;
 *   - `writeRead`'s block gate disabled: 5.
 * A guard nobody has watched fail is a guard nobody should trust.
 */
import { describe, expect, it } from 'vitest';

import type { MemoryClient, Relay } from '../../src/contracts/modules.js';
import type { MemoryRow, Read, UsualProfile } from '../../src/contracts/types.js';
import { sampleUsual } from '../../src/contracts/fixtures/index.js';
import { createLogger } from '../../src/config/logger.js';
import { createPoolStore, POOL_SCOPE } from '../../src/memory/pool.js';
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
  const unsettled = new Set<string>();
  let holdSettle = false;
  let seq = 0;

  const client: MemoryClient = {
    ingest(scope, payload) {
      const memoryId = `mem-${++seq}`;
      rows.set(scope, [...(rows.get(scope) ?? []), { memoryId, kind: 'fact', content: payload }]);
      if (holdSettle) unsettled.add(memoryId);
      return Promise.resolve({ jobId: `job-${seq}` });
    },
    search(scope, query) {
      return Promise.resolve(
        (rows.get(scope) ?? []).filter((r) => !unsettled.has(r.memoryId) && r.content.includes(query)),
      );
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
    holdSettle: () => {
      holdSettle = true;
    },
    settle: () => {
      unsettled.clear();
      holdSettle = false;
    },
    count: (scope: string) => (rows.get(scope) ?? []).length,
    /** Plant a record search can see but the boundary parser must reject. */
    plant: (scope: string, content: string) => {
      rows.set(scope, [...(rows.get(scope) ?? []), { memoryId: `mem-${++seq}`, kind: 'fact', content }]);
    },
  };
}

function tickingClock() {
  let tick = 0;
  return () => `2026-07-25T12:00:${String(tick++).padStart(2, '0')}.000Z`;
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
async function coldConfess(client: MemoryClient) {
  const logger = createLogger(() => {});
  const { relay, entries } = silentRelay();
  const user = createUserStore({ client, logger }); // fresh store ⇒ cold cache
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
  it('a stale duplicate cannot resurrect a topic the user removed... nor drop one they added', async () => {
    const s = substrate();
    const writer = createUserStore({ client: s.client, logger: createLogger(() => {}), now: tickingClock() });

    // v1 has no off-limits topics. It is still settling when v2 adds one, so
    // replaceTagged cannot see or remove it: both records exist afterwards.
    s.holdSettle();
    await writer.setUsual(PROFILE, { ...sampleUsual, offLimits: [] });
    await writer.setUsual(PROFILE, { ...sampleUsual, offLimits: [TOPIC] });
    s.settle();

    const seen = await coldConfess(s.client);
    expect(seen.offLimits).toEqual([TOPIC]); // the newer list won
    expect(seen.result).toEqual({ blocked: true });
    expect(seen.relayEntries).toHaveLength(0);
    expect(s.count(POOL_SCOPE)).toBe(0);
  });

  it('a malformed settings record cannot shadow the valid one it was written after', async () => {
    const s = substrate();
    const writer = createUserStore({ client: s.client, logger: createLogger(() => {}), now: tickingClock() });
    await writer.setUsual(PROFILE, { ...sampleUsual, offLimits: [TOPIC] });

    // Later — so it wins on written_at — but out of domain. Skipped, not used.
    s.plant(
      PROFILE,
      JSON.stringify({
        kind: 'confit:usual',
        written_at: '2026-07-25T23:59:59.000Z',
        usual: { spiceTolerance: 42, budgetBand: 99, portionPref: 'gigantic', soloComfort: true, giConstraint: false, offLimits: [] },
      }),
    );

    const seen = await coldConfess(s.client);
    expect(seen.offLimits).toEqual([TOPIC]);
    expect(seen.result).toEqual({ blocked: true });
  });

  it('confession prose in the same scope is never mistaken for a settings record', async () => {
    const s = substrate();
    const writer = createUserStore({ client: s.client, logger: createLogger(() => {}), now: tickingClock() });
    await writer.setUsual(PROFILE, { ...sampleUsual, offLimits: [TOPIC] });
    // Raw prose ([E11]) that happens to contain the tag token and JSON braces.
    await writer.writeProse(PROFILE, 'I told them about confit:usual {"offLimits": []} once, as a joke.');

    const seen = await coldConfess(s.client);
    expect(seen.offLimits).toEqual([TOPIC]);
    expect(seen.result).toEqual({ blocked: true });
  });

  it('an unreadable profile fails CLOSED at the caller — never silently writable', async () => {
    const s = substrate();
    const writer = createUserStore({ client: s.client, logger: createLogger(() => {}), now: tickingClock() });
    s.holdSettle(); // written, durable, and invisible to every reader
    await writer.setUsual(PROFILE, { ...sampleUsual, offLimits: [TOPIC] });

    const seen = await coldConfess(s.client);
    // The store honestly reports "no profile" rather than inventing an empty one.
    expect(seen.profile).toBeNull();
    // And that is precisely why the CLI must refuse on null instead of
    // defaulting to []. This guard pins the store's half; X2 pins the refusal
    // (confess.ts: "No profile … Run `confit pass provision` first").
    // Shown here so the consequence of changing either half is visible:
    expect(seen.offLimits).toEqual([]);
    expect(seen.result).not.toEqual({ blocked: true });
  });

  it('the topic list is live: removing a topic through setUsual unblocks, cold', async () => {
    const s = substrate();
    const writer = createUserStore({ client: s.client, logger: createLogger(() => {}), now: tickingClock() });
    await writer.setUsual(PROFILE, { ...sampleUsual, offLimits: [TOPIC] });
    expect((await coldConfess(s.client)).result).toEqual({ blocked: true });

    await writer.setUsual(PROFILE, { ...sampleUsual, offLimits: [] });
    const after = await coldConfess(s.client);
    expect(after.offLimits).toEqual([]);
    expect(after.result).not.toEqual({ blocked: true });
  });

  it('a garbage meal log cannot take the Ask down with it', async () => {
    const s = substrate();
    const logger = createLogger(() => {});
    s.plant(
      PROFILE,
      JSON.stringify({
        kind: 'confit:meal_log',
        written_at: '2026-07-25T12:00:00.000Z',
        entries: [{ dishId: 'pho', placeId: 'x', at: 'whenever' }, 'not-an-entry'],
      }),
    );
    const log = await createUserStore({ client: s.client, logger }).mealLog(PROFILE);
    expect(log).toEqual([]);
    const { suppressions } = await import('../../src/kernel/rotation.js');
    expect(() => suppressions(log, '2026-07-25')).not.toThrow();
  });
});

describe('G6: the guard fails if the ordering rule is lost', () => {
  it('written_at is what decides, not search order — proven by inverting the stamps', async () => {
    const s = substrate();
    const usualWith = (offLimits: string[], written_at: string): string =>
      JSON.stringify({ kind: 'confit:usual', written_at, usual: { ...sampleUsual, offLimits } satisfies UsualProfile });

    // Planted so the EMPTY list is first in search order but older by stamp.
    s.plant(PROFILE, usualWith([], '2026-07-25T10:00:00.000Z'));
    s.plant(PROFILE, usualWith([TOPIC], '2026-07-25T11:00:00.000Z'));
    expect((await coldConfess(s.client)).result).toEqual({ blocked: true });

    // Swap only the stamps: the same rows in the same order must now unblock.
    const s2 = substrate();
    s2.plant(PROFILE, usualWith([], '2026-07-25T12:00:00.000Z'));
    s2.plant(PROFILE, usualWith([TOPIC], '2026-07-25T11:00:00.000Z'));
    expect((await coldConfess(s2.client)).result).not.toEqual({ blocked: true });
  });
});
