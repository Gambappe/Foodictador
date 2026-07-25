import { describe, expect, it } from 'vitest';

import {
  CADENCES,
  DRIVERS,
  READ_KEYS,
  SIGNALS,
  type Read,
} from './types.js';
import { DEFAULT_FLAGS } from './flags.js';
import {
  FIXTURE_NOW,
  cannedConfessions,
  corpusFixture,
  poolBaseline,
  sampleMealLog,
  sampleRead,
  sampleUsual,
} from './fixtures/index.js';
import {
  StubAskEngine,
  StubCohorts,
  StubExtractor,
  StubMemoryClient,
  StubNarrator,
  StubNudge,
  StubPoolStore,
  StubPoolView,
  StubRelay,
  StubRotation,
  StubUserStore,
} from './stubs/index.js';

describe('the read schema pin (DAG §3, [E20]/[E25])', () => {
  it('READ_KEYS is exactly six field names', () => {
    expect(READ_KEYS.length).toBe(6);
    expect(new Set(READ_KEYS).size).toBe(6);
  });

  it('sampleRead carries exactly READ_KEYS', () => {
    expect(Object.keys(sampleRead).sort()).toEqual([...READ_KEYS].sort());
  });

  it('every baseline read carries exactly READ_KEYS, valid enums, and weight in [0,1]', () => {
    for (const read of poolBaseline) {
      expect(Object.keys(read).sort()).toEqual([...READ_KEYS].sort());
      expect(DRIVERS).toContain(read.driver);
      expect(SIGNALS).toContain(read.signal);
      expect(CADENCES).toContain(read.cadence);
      expect(read.weight).toBeGreaterThanOrEqual(0);
      expect(read.weight).toBeLessThanOrEqual(1);
    }
    expect(new Set(poolBaseline.map((r) => r.read_id)).size).toBe(poolBaseline.length);
  });

  it('the baseline pool has the structure X3 depends on: k=5 citable, k=4 miss', () => {
    const k = (driver: Read['driver']) =>
      new Set(poolBaseline.filter((r) => r.driver === driver).map((r) => r.read_id)).size;
    expect(k('spice_tolerance_low')).toBe(5);
    expect(k('budget_ceiling')).toBe(4);
    expect(k('solo_comfort')).toBe(6);
  });
});

describe('fixture coherence', () => {
  it('every baseline read and canned chip names a fixture-corpus place', () => {
    const slugs = new Set(corpusFixture.map((p) => p.id));
    for (const read of poolBaseline) expect(slugs).toContain(read.place);
    for (const canned of cannedConfessions) expect(slugs).toContain(canned.chips.place);
  });

  it('there are exactly six canned confessions with distinct keywords', () => {
    expect(cannedConfessions.length).toBe(6);
    expect(new Set(cannedConfessions.map((c) => c.keyword)).size).toBe(6);
  });

  it('default flags are all-live with demoMode off', () => {
    expect(DEFAULT_FLAGS).toEqual({ extraction: 'live', narrator: 'live', pool: 'live', demoMode: false });
  });
});

describe('every stub constructs and answers every method', () => {
  it('StubMemoryClient: ingest/search/remove/jobStatus', async () => {
    const client = new StubMemoryClient();
    const handle = await client.ingest('profile-a', 'I always order the mild one.');
    expect(handle.jobId).toBeTruthy();
    expect(await client.jobStatus(handle.jobId)).toBe('complete');
    expect(await client.jobStatus('nope')).toBe('unknown');
    const rows = await client.search('profile-a', 'mild', { topK: 10, episodeSlots: 2 });
    expect(rows).toHaveLength(1);
    const first = rows[0];
    expect(first).toBeDefined();
    if (first) {
      await client.remove('profile-a', first.memoryId);
    }
    expect(await client.search('profile-a', '', { topK: 10, episodeSlots: 2 })).toHaveLength(0);
  });

  it('StubPoolStore: writeRead records the induction feed; there is no read path', async () => {
    // The stub deliberately cannot hand a read back. A stub that round-tripped
    // one would model a substrate that does not exist, which is how the counting
    // query shipped against a store that could never serve it (D-7).
    const pool = new StubPoolStore();
    const read = { ...sampleRead, driver: 'spice_tolerance_low' as const };
    const handle = await pool.writeRead(read);
    expect(handle.jobId).toBeTruthy();
    expect(pool.ingested).toEqual([read]);
    expect(await pool.inducedClaim('loyalty')).toMatch(/loyalty/);
  });

  it('StubUserStore: prose/usual/mealLog round-trips including offLimits', async () => {
    const store = new StubUserStore();
    expect(await store.usual('A')).toBeNull();
    await store.setUsual('A', { ...sampleUsual, offLimits: ['gluten'] });
    expect((await store.usual('A'))?.offLimits).toEqual(['gluten']);
    await store.setMealLog('A', sampleMealLog);
    expect(await store.mealLog('A')).toHaveLength(sampleMealLog.length);
    const handle = await store.writeProse('A', 'a true thing I would never post');
    expect(handle.jobId).toBeTruthy();
  });

  it('StubRelay: put/setJob/list/drop/stats/seed/reset', async () => {
    let tick = Date.parse(FIXTURE_NOW);
    const relay = new StubRelay(() => new Date((tick += 1000)));
    await relay.put(sampleRead);
    await relay.setJob(sampleRead.read_id, 'job-9');
    const listed = await relay.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.ingest_job_id).toBe('job-9');
    expect(listed[0]?.read).toEqual(sampleRead);
    await expect(relay.setJob('unknown-id', 'job-1')).rejects.toThrow(/unknown read_id/);
    const stats = await relay.stats();
    expect(stats.count).toBe(1);
    expect(stats.oldest_entry_age_seconds).toBeGreaterThan(0);
    const cutoff = listed[0]?.received_at ?? '';
    expect(await relay.list(cutoff)).toHaveLength(0);
    await relay.drop(sampleRead.read_id);
    await relay.drop(sampleRead.read_id); // idempotent
    expect(await relay.seed(poolBaseline.slice(0, 3))).toBe(3);
    await relay.reset();
    expect((await relay.stats()).count).toBe(0);
  });

  it('StubPoolView: serves the baseline deduplicated on read_id', async () => {
    const first = poolBaseline[0];
    expect(first).toBeDefined();
    if (!first) return;
    const view = new StubPoolView([...poolBaseline, { ...first }]); // duplicate entry, same read_id
    const { reads, degraded } = await view.readsForDriver(first.driver);
    expect(degraded).toBe(false);
    expect(new Set(reads.map((r) => r.read_id)).size).toBe(reads.length);
    expect(reads.filter((r) => r.read_id === first.read_id)).toHaveLength(1);
  });

  it('StubExtractor: keyword match, fallback, and blocked topic', async () => {
    const extractor = new StubExtractor();
    const spicy = await extractor.propose('Honestly the spicy one defeats me.', []);
    expect(spicy).toMatchObject({ chips: { driver: 'spice_tolerance_low' } });
    const fallback = await extractor.propose('Nothing matches this text at all.', []);
    expect('chips' in fallback && fallback.chips.place).toBeTruthy();
    const blocked = await extractor.propose('my gluten thing again', ['Gluten']);
    expect(blocked).toEqual({ blocked: true });
    const emptyTopic = await extractor.propose('anything', ['']);
    expect('blocked' in emptyTopic).toBe(false);
  });

  it('StubNarrator: copy from facts, cohort-miss and rotation lines included', async () => {
    const narrator = new StubNarrator();
    const ranked = corpusFixture.slice(0, 1).map((place) => ({
      place,
      score: 0.6,
      parts: { pool: 0.3, usual: 0.15, rotation: 0.1, context: 0.05 },
    }));
    const copy = await narrator.write(ranked, {
      citation: { driver: 'spice_tolerance_low', k: 6 },
      suppressions: [{ dishId: 'shoyu_ramen', reasonKey: 'eaten_twice_recently' }],
      usualNotes: ['Counter seat, small plates — your usual shape.'],
      degradedPool: false,
    });
    expect(copy.reasonLine).toMatch(/6/);
    expect(copy.rotationLine).toMatch(/shoyu ramen/);
    expect(copy.usualLine).toBeTruthy();
    const miss = await narrator.write(ranked, {
      cohortMiss: { driver: 'budget_ceiling' },
      suppressions: [],
      usualNotes: [],
      degradedPool: false,
    });
    expect(miss.cohortMissLine).toMatch(/first person/);
  });

  it('StubRotation: suppression after 2-in-7-days, appetite rises with distance', () => {
    const rotation = new StubRotation();
    const suppressed = rotation.suppressions(sampleMealLog, FIXTURE_NOW);
    expect(suppressed.map((s) => s.dishId)).toContain('shoyu_ramen');
    expect(suppressed[0]?.reasonKey).toBe('eaten_twice_recently');
    const soon = rotation.appetite('shoyu_ramen', sampleMealLog, FIXTURE_NOW);
    const later = rotation.appetite('shoyu_ramen', sampleMealLog, '2026-08-20T19:00:00.000Z');
    expect(soon).toBeLessThan(later);
    expect(rotation.appetite('never_eaten', sampleMealLog, FIXTURE_NOW)).toBe(100);
    expect(rotation.fit(sampleMealLog)['al_pastor']).toBeGreaterThan(0);
  });

  it('StubCohorts: census dedups on read_id; matched applies the trait map and the floor', () => {
    const cohorts = new StubCohorts();
    const first = poolBaseline[0];
    expect(first).toBeDefined();
    if (!first) return;
    const withDuplicate = [...poolBaseline, { ...first }];
    const census = cohorts.census(withDuplicate);
    expect(census.find((c) => c.driver === 'spice_tolerance_low')?.k).toBe(5);
    const matched = cohorts.matched(sampleUsual, poolBaseline);
    const drivers = matched.map((c) => c.driver).sort();
    expect(drivers).toEqual(['solo_comfort', 'spice_tolerance_low']); // budget_ceiling k=4 excluded
  });

  it('StubAskEngine: deterministic card with citation, runners-up and scores', () => {
    const engine = new StubAskEngine();
    const card = engine.ask({
      reads: poolBaseline,
      usual: sampleUsual,
      log: sampleMealLog,
      corpus: corpusFixture,
      flags: DEFAULT_FLAGS,
      now: FIXTURE_NOW,
    });
    expect(card.pick.id).toBe(corpusFixture[0]?.id);
    expect(card.poolCitation?.k).toBeGreaterThanOrEqual(5);
    expect(card.runnersUp).toHaveLength(2);
    expect(Object.keys(card.scores)).toHaveLength(corpusFixture.length);
    const missCard = engine.ask({
      reads: [],
      usual: sampleUsual,
      log: [],
      corpus: corpusFixture,
      flags: DEFAULT_FLAGS,
      now: FIXTURE_NOW,
      degradedPool: true,
    });
    expect(missCard.poolCitation).toBeUndefined();
    expect(missCard.cohortMiss).toBeDefined();
    expect(missCard.degradedPool).toBe(true);
  });

  it('StubNudge: never fires, but state transitions are faithful', () => {
    const nudge = new StubNudge();
    expect(nudge.maybeFire(FIXTURE_NOW)).toBe(false);
    nudge.setOptIn(true);
    nudge.arm();
    expect(nudge.state()).toMatchObject({ optedIn: true, armed: true, silenced: false });
    expect(nudge.maybeFire(FIXTURE_NOW)).toBe(false);
    nudge.silenceForever();
    expect(nudge.state()).toMatchObject({ silenced: true, armed: false });
  });
});
