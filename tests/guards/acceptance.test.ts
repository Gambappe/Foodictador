import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { fixtureGraph } from '../../src/config/wiring.js';
import { createLogger } from '../../src/config/logger.js';
import { KFLOOR, census } from '../../src/kernel/cohorts.js';
import { assembleCard, planAsk } from '../../src/kernel/askEngine.js';
import { writeRead } from '../../src/memory/writeRead.js';
import { forget } from '../../src/memory/forget.js';
import { createSweeper } from '../../src/memory/sweeper.js';
import { corpusFixture } from '../../src/contracts/fixtures/index.js';
import type { Read, UsualProfile } from '../../src/contracts/types.js';

/**
 * The CLI acceptance run (G5).
 *
 * DAG §7 G5: provision → seed → confess (A) → ask (B) asserting the cohort citation
 * moved → sweep → forget → census, against fixture stores, with **no network and no
 * `ANTHROPIC_API_KEY`**. It lives as a test rather than a shell script so it runs inside
 * `npm test` on every push and fails with a diff instead of a non-zero exit.
 *
 * The load-bearing property is the middle one. Account A confesses; account B asks; B's
 * card must cite a cohort it could not have cited a moment earlier. That is the demo's
 * peak beat (design v0.8 §4/§5), and it is the one thing a gate made only of unit tests
 * cannot tell you, because every module passes its own tests while the seam between them
 * is what carries the read across.
 */

const NOW = '2026-07-25T19:00:00.000Z';
/** A minute later, so a relay entry written at NOW is past the settle window. */
const LATER = '2026-07-25T19:01:00.000Z';

/** Both demo accounts have a Usual that evidences `spice_tolerance_low` (see K6). */
const usual: UsualProfile = {
  spiceTolerance: 1,
  budgetBand: 2,
  portionPref: 'small',
  soloComfort: true,
  giConstraint: false,
  offLimits: [],
};

const DRIVER = 'spice_tolerance_low';
const PLACE = corpusFixture[0]?.id ?? 'rosas_taqueria';

function seedRead(index: number): Read {
  return {
    read_id: `seed-0000-4000-8000-00000000000${index}`,
    place: corpusFixture[index % corpusFixture.length]?.id ?? PLACE,
    signal: 'regret_after_order',
    driver: DRIVER,
    cadence: 'weekly',
    weight: 0.8,
  };
}

function graph() {
  return fixtureGraph({ logger: createLogger(() => undefined) });
}

describe('the CLI acceptance run', () => {
  it('carries a confession from account A to account B\'s card', async () => {
    const g = graph();

    // ---- provision: both demo profiles exist -------------------------------------
    await g.user.setUsual('A', usual);
    await g.user.setUsual('B', usual);
    expect(await g.user.usual('B')).toMatchObject({ spiceTolerance: 1 });

    // ---- seed: one short of the floor, on purpose --------------------------------
    // KFLOOR - 1 reads means the cohort is NOT citable yet. If the seed already cleared
    // the floor, the assertion below would pass without the confession doing anything.
    //
    // Seeded into the RELAY, which is the durable store of reads under DAG §4 D-7.
    // Seeding the XTrace pool instead — as this test used to — put the reads into a
    // substrate that cannot hand them back, and the run only passed because the
    // fixture's stub could do what production cannot.
    const seeds = Array.from({ length: KFLOOR - 1 }, (_, i) => seedRead(i));
    expect(await g.relay.seed(seeds)).toBe(KFLOOR - 1);

    const before = await g.poolView.readsForDriver(DRIVER);
    expect(before.reads).toHaveLength(KFLOOR - 1);

    const askB = async (): Promise<ReturnType<typeof assembleCard> | null> => {
      const reads = (await g.poolView.readsForDriver(DRIVER)).reads;
      const profile = await g.user.usual('B');
      if (profile === null) throw new Error('B was not provisioned');
      const plan = planAsk({
        reads,
        usual: profile,
        log: await g.user.mealLog('B'),
        corpus: [...corpusFixture],
        flags: g.flags.get(),
        now: NOW,
      });
      if (plan.kind !== 'ranked') return null;
      return assembleCard(plan, await g.narrator.write(plan.ranked, plan.facts));
    };

    // ---- ask (B), before: the cohort is one short, so there is no citation --------
    const cardBefore = await askB();
    expect(cardBefore?.poolCitation).toBeUndefined();
    expect(cardBefore?.cohortMiss).toEqual({ driver: DRIVER });

    // ---- confess (A) -------------------------------------------------------------
    const written = await writeRead(
      { relay: g.relay, pool: g.pool, user: g.user, logger: g.logger },
      {
        profile: 'A',
        text: 'I say I like it hot. I do not.',
        chips: {
          place: PLACE,
          signal: 'regret_after_order',
          driver: DRIVER,
          cadence: 'weekly',
          weight: 0.9,
        },
        offLimits: [],
      },
    );
    if ('blocked' in written) throw new Error('the acceptance confession must not be blocked');
    expect(written.wrote.relay).toBe(true);

    // ---- ask (B), after: the citation moved --------------------------------------
    // This is the peak beat. B never touched A's data; the read reached B through the
    // relay while the pool settles behind it.
    const cardAfter = await askB();
    expect(cardAfter?.poolCitation).toEqual({ driver: DRIVER, k: KFLOOR });
    expect(cardAfter?.cohortMiss).toBeUndefined();

    // ---- the card says something a human wrote ----------------------------------
    expect(cardAfter?.reasonLine.length).toBeGreaterThan(0);
    expect(cardAfter?.reasonLine.startsWith(' ')).toBe(false);
    for (const line of [cardAfter?.reasonLine, cardAfter?.usualLine, cardAfter?.rotationLine]) {
      if (line === undefined) continue;
      // No raw identifier may reach a card (defect SL-01).
      expect(line).not.toMatch(/[a-z]_[a-z]/);
    }

    // ---- sweep: it backfills induction and DESTROYS NOTHING -----------------------
    const sweeper = createSweeper({
      relay: g.relay,
      pool: g.pool,
      client: g.client,
      logger: g.logger,
      settleWindowSeconds: g.settleWindowSeconds,
    });
    const beforeSweep = await g.relay.list();
    expect(beforeSweep).toHaveLength(KFLOOR);

    // Swept at NOW nothing is past the window yet, so no entry is even examined.
    const early = await sweeper.sweepOnce(NOW);
    expect(early).toMatchObject({ pooled: 0, reingested: 0, pending: 0, stored: KFLOOR });

    // Swept a minute later every entry is examined: the confession's ingest job is
    // complete, and the seeds were never ingested at all, so they get backfilled.
    const report = await sweeper.sweepOnce(LATER);
    expect(report).toMatchObject({ pooled: 1, reingested: KFLOOR - 1, pending: 0 });

    // THE ASSERTION THIS RUN EXISTS FOR, after the citation moved. The relay is the
    // only place these reads exist (D-7), so a sweep that shrank it would be the
    // whole cohort destroyed — and the demo would still look fine right up until
    // the next Ask found nothing to cite.
    expect(report.stored).toBe(KFLOOR);
    expect((await g.relay.list()).map((e) => e.read.read_id).sort()).toEqual(
      beforeSweep.map((e) => e.read.read_id).sort(),
    );
    expect((await askB())?.poolCitation).toEqual({ driver: DRIVER, k: KFLOOR });

    // ---- forget: gone from the store, honest about the rest -----------------------
    const forgotten = await forget(written.read_id, {
      client: g.client,
      relay: g.relay,
      logger: g.logger,
    });
    expect(forgotten.ok).toBe(true);
    expect(forgotten.read_id).toBe(written.read_id);
    // The relay delete is the authoritative one: it removes the read itself.
    expect(forgotten.relay).toEqual({ status: 'deleted', count: 1 });
    // XTrace holds prose derived from the read, not the read, and no handle was
    // captured — so it reports `skipped` with the reason rather than claiming a
    // purge it did not perform.
    expect(forgotten.pool.status).toBe('skipped');

    const afterForget = await g.poolView.readsForDriver(DRIVER);
    expect(afterForget.reads.map((r) => r.read_id)).not.toContain(written.read_id);

    // ---- census: back below the floor, so nothing is citable again ---------------
    const stats = census(afterForget.reads);
    const cohort = stats.find((stat) => stat.driver === DRIVER);
    expect(cohort?.k).toBe(KFLOOR - 1);
    expect((await askB())?.poolCitation).toBeUndefined();
  });

  it('runs with no ANTHROPIC_API_KEY and no XTrace credentials in the environment', () => {
    // G5's acceptance criterion, asserted rather than assumed: the fixture graph is
    // constructible from nothing at all. Saved and restored, because leaking a deleted
    // env var into the rest of the worker would make some other test's failure a mystery.
    const names = [
      'ANTHROPIC_API_KEY',
      'XTRACE_BASE_URL',
      'XTRACE_API_KEY',
      'RELAY_URL',
      'RELAY_TOKEN',
    ] as const;
    const saved = new Map(names.map((name) => [name, process.env[name]]));
    try {
      for (const name of names) delete process.env[name];
      expect(() => graph()).not.toThrow();
    } finally {
      for (const [name, value] of saved) if (value !== undefined) process.env[name] = value;
    }
  });

  it('blocks a flagged confession at every target, end to end', async () => {
    // G2 asserts this against M5 directly; here it is asserted through the same graph the
    // acceptance run uses, because a guard that only holds in isolation is not a guard.
    const g = graph();
    await g.user.setUsual('A', { ...usual, offLimits: ['hot sauce'] });
    const profile = await g.user.usual('A');
    if (profile === null) throw new Error('A was not provisioned');

    const result = await writeRead(
      { relay: g.relay, pool: g.pool, user: g.user, logger: g.logger },
      {
        profile: 'A',
        text: 'The hot sauce thing is a lie.',
        chips: {
          place: PLACE,
          signal: 'pretends_preference',
          driver: DRIVER,
          cadence: 'weekly',
          weight: 0.5,
        },
        offLimits: profile.offLimits,
      },
    );

    expect(result).toEqual({ blocked: true });
    expect(await g.relay.list()).toEqual([]);
    expect((await g.poolView.readsForDriver(DRIVER)).reads).toEqual([]);
  });
});

describe('the gate script itself', () => {
  /**
   * Runs the gate's gate-zero check against a record fixture.
   *
   * `--gate0-only` is safe to shell into because it skips the code checks — the full gate
   * runs `npm test`, so invoking that from a test would recurse.
   */
  function gate0Check(recordPath: string): number {
    const result = spawnSync('bash', ['scripts/gate-cli.sh', '--gate0-only'], {
      cwd: fileURLToPath(new URL('../../', import.meta.url)),
      env: { ...process.env, GATE0_RECORD: recordPath },
      encoding: 'utf8',
    });
    return result.status ?? -1;
  }

  it('exits 0 only when a PASS is recorded', () => {
    const pass = join(mkdtempSync(join(tmpdir(), 'gate0-')), 'record.md');
    writeFileSync(pass, '# Gate zero\n\n**Status: PASS** — 12/12 retrievable.\n');
    expect(gate0Check(pass)).toBe(0);
  });

  it('exits 3 for a record that says anything other than PASS', () => {
    const notRun = join(mkdtempSync(join(tmpdir(), 'gate0-')), 'record.md');
    writeFileSync(notRun, '# Gate zero\n\n**Status: NOT RUN** — no credentials.\n');
    expect(gate0Check(notRun)).toBe(3);
  });

  it('exits 3 when the record is missing entirely, rather than assuming the best', () => {
    expect(gate0Check(join(tmpdir(), 'gate0-does-not-exist.md'))).toBe(3);
  });

  it('agrees with whatever this repo\'s record actually says', () => {
    // Deliberately NOT `expect(...).toBe(3)`. Gate zero has not been run, so 3 is the
    // honest answer today — but hard-coding it would put a red test in lane G's file the
    // day someone with credentials does the run, which is legitimate work they could not
    // legally fix. What must always hold is that the gate agrees with the record.
    const record = readFileSync(
      fileURLToPath(new URL('../../docs/gate0-results.md', import.meta.url)),
      'utf8',
    );
    const recordsPass = /^\*\*Status:\s*PASS/m.test(record);
    expect(gate0Check('docs/gate0-results.md')).toBe(recordsPass ? 0 : 3);
  });
});
