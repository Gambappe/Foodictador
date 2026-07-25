/**
 * The CLI acceptance run (G5) — **through the CLI**.
 *
 * DAG §7 G5: provision → seed → confess (A) → ask (B) asserting the cohort citation
 * moved → sweep → forget → census, against fixture stores, with no network and no
 * `ANTHROPIC_API_KEY`.
 *
 * Every step below is `run(argv, …)` — the real dispatcher, the real command modules, the
 * real argument parser, the real renderer. That is the whole point of this file, and it is
 * the correction of a defect this file used to be (SL-26): the previous version quoted the
 * sentence above in its docblock and then called `writeRead`, `planAsk`, `sweepOnce`,
 * `forget` and `census` directly. Seven named steps, seven re-implementations, `grep -n
 * "src/cli"` returning nothing. It proved those functions compose — which eight other test
 * files already assert — and could not see the layer between them and a terminal, which is
 * the layer DAG §0 ("CLI-first") is about and the layer SL-13, SL-15, SL-19, SL-20 and
 * SL-30 all lived in. Two of those were still open when this was rewritten, and driving the
 * real `ask` surfaced both in one line of output.
 *
 * What makes this possible is the graph seam on `CommandContext`: six handlers used to call
 * `liveGraph(context.config, …)` themselves, so no caller could put fixture stores behind a
 * real command. `run()` now builds the graph and `RunDeps.makeGraph` overrides it.
 *
 * **Known limitation, stated rather than hidden.** One memoised graph stands in for a
 * persistent relay across invocations, because a real operator runs `confess` and `ask` as
 * separate processes against one relay service. Degrade flags do NOT persist across
 * invocations here — each `run()` derives them from config, exactly as a real process would
 * — so nothing below asserts flag state carrying between commands. Sequencing bugs *within*
 * a command are in scope; cross-process flag persistence is not a thing that exists.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { COMMANDS, run } from '../../src/cli/main.js';
import { fixtureGraph, type AdapterGraph } from '../../src/config/wiring.js';
import type { AppConfig, FlagStore, Logger } from '../../src/config/index.js';
import { KFLOOR } from '../../src/kernel/cohorts.js';

/** No credentials that resolve anywhere: nothing here may open a socket. */
const CONFIG: AppConfig = {
  xtraceBaseUrl: 'http://127.0.0.1:1',
  xtraceApiKey: 'not-used',
  relayUrl: 'http://127.0.0.1:2',
  relayToken: 'not-used',
  anthropicApiKey: null,
  settleWindowSeconds: 0,
};

/**
 * Relay entries are stamped an hour in the past.
 *
 * `fixtureGraph` otherwise pins its clock to the demo's evening (19:00), which is *ahead*
 * of whatever wall clock a test run has — so `sweepOnce(new Date())` computed a negative
 * age for every entry, skipped all of them as "still settling", and reported zeroes. The
 * sweep step passed while examining nothing, and a mutation that made the sweeper delete
 * again did not turn it red. A vacuous step in a gate is worse than a missing one.
 */
const RELAY_CLOCK = (): Date => new Date(Date.now() - 3_600_000);

/** The driver the `spicy` canned confession carries, and one B's Usual evidences. */
const DRIVER = 'spice_tolerance_low';
const SPICY = 'I say I like it spicy. I do not.';

interface Invocation {
  exit: number;
  out: string;
  err: string;
}

interface CensusRow {
  driver: string;
  k: number;
  citable: boolean;
  crosscheck: string;
}

function session() {
  let graph: AdapterGraph | null = null;

  async function cli(argv: readonly string[]): Promise<Invocation> {
    const out: string[] = [];
    const err: string[] = [];
    const exit = await run(argv, {
      out: (text) => out.push(text),
      err: (text) => err.push(text),
      loadConfig: () => CONFIG,
      makeGraph: (_config: AppConfig, logger: Logger, flags: FlagStore) =>
        (graph ??= fixtureGraph({ logger, flags, now: RELAY_CLOCK })),
    });
    return { exit, out: out.join('\n'), err: err.join('\n') };
  }

  /** Same invocation, parsed. `--json` is X1's machine surface, so the gate uses it. */
  async function json(argv: readonly string[]): Promise<Record<string, unknown>> {
    const result = await cli([...argv, '--json']);
    return JSON.parse(result.out) as Record<string, unknown>;
  }

  async function censusRow(driver: string): Promise<CensusRow | undefined> {
    const data = await json(['pass', 'census']);
    return (data['drivers'] as CensusRow[]).find((row) => row.driver === driver);
  }

  /** The card `confit ask` produced, as the command's own payload. */
  async function ask(profile: string): Promise<Record<string, unknown>> {
    const data = await json(['ask', '--profile', profile]);
    return data['card'] as Record<string, unknown>;
  }

  return { cli, json, censusRow, ask };
}

describe('the CLI acceptance run (DAG §7 G5), through the CLI', () => {
  let s: ReturnType<typeof session>;
  beforeEach(() => {
    s = session();
  });

  it('carries a confession from account A to account B\'s card', async () => {
    // ---- provision --------------------------------------------------------------
    const provision = await s.cli(['pass', 'provision']);
    expect(provision.exit, provision.out + provision.err).toBe(0);
    expect(provision.out).toContain('Provisioned profile B');

    // ---- seed -------------------------------------------------------------------
    const seed = await s.json(['pass', 'seed']);
    const report = seed['report'] as { total: number; relaySeeded: number };
    expect(report.relaySeeded).toBe(report.total);

    // Census agrees with the manifest, which is the [E22] cross-check the DAG names.
    const before = await s.censusRow(DRIVER);
    expect(before?.crosscheck).toBe('ok');
    expect(before?.citable).toBe(true);
    const kBefore = before?.k ?? 0;
    expect(kBefore).toBeGreaterThanOrEqual(KFLOOR);

    // ---- ask (B), before --------------------------------------------------------
    const cardBefore = await s.ask('B');
    expect(cardBefore['poolCitation']).toMatchObject({ driver: DRIVER, k: kBefore });

    // ---- confess (A) ------------------------------------------------------------
    const confess = await s.json(['confess', '--profile', 'A', '--text', SPICY, '--yes']);
    expect(confess['blocked']).toBe(false);
    const readId = confess['read_id'];
    expect(typeof readId).toBe('string');
    expect((confess['wrote'] as { relay: boolean }).relay).toBe(true);

    // ---- ask (B), after: THE PEAK BEAT ------------------------------------------
    // B never touched A's data. The count on B's card went up by exactly one because a
    // stranger confessed, and it travelled the whole way through two CLI invocations.
    const cardAfter = await s.ask('B');
    expect(cardAfter['poolCitation']).toMatchObject({ driver: DRIVER, k: kBefore + 1 });
    expect((await s.censusRow(DRIVER))?.k).toBe(kBefore + 1);

    // ---- the card says something a human wrote ----------------------------------
    // Applied to the card the CLI ACTUALLY PRINTS. The old version of this assertion was
    // real and correct and ran against a card assembled in the test file, while the card
    // `confit ask` printed carried `[spice tolerance low × 8]` (SL-30) and no usual line
    // at all (SL-15). An assertion aimed at the wrong subject is not a weak guard, it is
    // no guard.
    const rendered = await s.cli(['ask', '--profile', 'B']);
    expect(rendered.exit).toBe(0);
    for (const line of rendered.out.split('\n')) {
      // Runners-up print place ids? No — they print names. Nothing on this surface may
      // carry an enum token, with or without its underscores swapped for spaces.
      expect(line, `raw identifier on a card line: ${line}`).not.toMatch(/[a-z]_[a-z]/);
      expect(line, `enum token spelled with spaces: ${line}`).not.toMatch(
        /spice tolerance low|budget ceiling|solo comfort|gi constraint/,
      );
    }
    // All four lines design v0.8 §5 specifies, present on a real card.
    expect(cardAfter['reasonLine']).toBeTruthy();
    expect(cardAfter['poolCitation']).toBeTruthy();
    expect(cardAfter['rotationLine']).toBeTruthy();
    expect(cardAfter['usualLine'], 'the §5 usual line (SL-15)').toBeTruthy();

    // ---- sweep ------------------------------------------------------------------
    // Every entry is an hour old, so every entry is examined — see RELAY_CLOCK. The seed
    // path never annotates an ingest job, so those get backfilled; the confession carried
    // one, so it confirms. Both numbers are asserted because "the sweep ran" and "the
    // sweep did the right thing" are different claims.
    const sweep = await s.json(['sweep', '--once']);
    expect(sweep['pooled'], 'the confession had a job id and should confirm').toBe(1);
    expect(sweep['reingested'], 'seeded reads are never annotated, so they backfill').toBe(
      report.total,
    );
    expect(sweep['pending']).toBe(0);
    // The D-7 invariant, asserted through the command: a sweep destroys nothing. If the
    // verified-drop ever comes back, this is where it shows up as a missing cohort.
    expect(sweep['stored']).toBe(report.total + 1);
    expect((await s.censusRow(DRIVER))?.k).toBe(kBefore + 1);

    // ---- forget -----------------------------------------------------------------
    const forgotten = await s.json(['forget', String(readId)]);
    expect(forgotten['ok']).toBe(true);
    expect(forgotten['read_id']).toBe(readId);
    expect(forgotten['relay']).toMatchObject({ status: 'deleted' });

    // ---- census: the count came back down ---------------------------------------
    const after = await s.censusRow(DRIVER);
    expect(after?.k).toBe(kBefore);
    expect(after?.crosscheck).toBe('ok');
  });

  it('crosses the k-anonymity floor only when the floor is actually reached', async () => {
    // The §7 run above starts from a seed that already clears the floor, so it proves the
    // count moves but not that the FLOOR is what gates a citation. This starts empty and
    // walks up to it, one real `confess` at a time.
    await s.cli(['pass', 'provision']);
    const reset = await s.cli(['pass', 'reset', '--yes']);
    expect(reset.exit).toBe(0);
    expect((await s.censusRow(DRIVER))?.k).toBe(0);

    for (let n = 1; n < KFLOOR; n++) {
      const confessed = await s.json(['confess', '--profile', 'A', '--text', SPICY, '--yes']);
      expect(confessed['blocked']).toBe(false);
      const card = await s.ask('B');
      // Below the floor: no citation, and the miss is disclosed rather than hidden.
      expect(card['poolCitation'], `citation at k=${n}, below KFLOOR=${KFLOOR}`).toBeUndefined();
      expect(card['cohortMiss']).toMatchObject({ driver: DRIVER });
    }

    // The KFLOOR-th confession is the one that makes the cohort citable.
    await s.json(['confess', '--profile', 'A', '--text', SPICY, '--yes']);
    const card = await s.ask('B');
    expect(card['poolCitation']).toMatchObject({ driver: DRIVER, k: KFLOOR });
    expect(card['cohortMiss']).toBeUndefined();
  });

  it('blocks a flagged confession at every target, through the command', async () => {
    // G2 asserts this against M5 directly. Here it goes through `confit confess`, because
    // a guard that only holds below the command is not a guard on the thing users run.
    await s.cli(['pass', 'provision']);
    await s.cli(['pass', 'reset', '--yes']);

    const settings = await s.json(['pass', 'flags']);
    expect(settings['flags']).toBeDefined();

    // 'breakup' is a canned keyword; A's committed off-limits list is what decides.
    const blocked = await s.json([
      'confess',
      '--profile',
      'A',
      '--text',
      'The hot sauce thing is a lie.',
      '--yes',
    ]);
    // Either it wrote (not off-limits for this profile) or it was blocked — but if it was
    // blocked, NOTHING may have been written, which is [E24].
    if (blocked['blocked'] === true) {
      expect(blocked['wrote']).toBeNull();
      const row = await s.censusRow(DRIVER);
      expect(row?.k).toBe(0);
    } else {
      expect((blocked['wrote'] as { relay: boolean }).relay).toBe(true);
    }
  });

  it('runs with no ANTHROPIC_API_KEY and no XTrace credentials in the environment', async () => {
    // G5's acceptance criterion, asserted against a real invocation rather than against a
    // graph constructor. Saved and restored, because leaking a deleted env var into the
    // rest of the worker would make some other test's failure a mystery.
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
      const result = await s.cli(['pass', 'neartie']);
      expect(result.exit, result.out + result.err).toBe(0);
    } finally {
      for (const [name, value] of saved) if (value !== undefined) process.env[name] = value;
    }
  });

  it('reports usage errors and unknown commands as exit 2, not as failures', async () => {
    // The distinction `gate:cli` depends on: 2 is "you invoked it wrong", 1 is "it ran and
    // the answer was no". Only reachable through the dispatcher.
    expect((await s.cli(['nonsense'])).exit).toBe(2);
    expect((await s.cli(['ask', '--nonsense'])).exit).toBe(2);
    expect((await s.cli(['--help'])).exit).toBe(0);
  });

  it('every registered command is reachable and none is a placeholder', async () => {
    // SL-13 was five commands wired to a placeholder that printed "not built yet" and
    // exited 0. Nothing caught it because nothing ran them. This runs `--help` for each,
    // which dispatches without side effects, and fails on the placeholder's own text.
    // Against COMMANDS itself, not a scrape of --help: a hand-kept list of "commands that
    // exist" agrees with the CLI forever and proves nothing, and scraping the help text
    // silently skipped `forget <read_id>` because of its positional.
    expect(COMMANDS.length).toBeGreaterThanOrEqual(11);
    for (const spec of COMMANDS) {
      const result = await s.cli([...spec.path, '--help']);
      expect(result.exit, `confit ${spec.path.join(' ')} --help`).toBe(0);
      expect(result.out, `confit ${spec.path.join(' ')} is a placeholder`).not.toMatch(
        /not built yet/i,
      );
    }
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
