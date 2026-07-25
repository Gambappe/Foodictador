/**
 * Gate zero, rewritten for D-7 (G7). A standalone script, not a confit subcommand:
 * it answers questions that predate trusting the app, and it blocks build day.
 *
 * The P0.5 protocol is VOID, not merely unrun. It asked whether a dropped read could
 * be re-ingested and retrieved from XTrace — but nothing drops any more (M9), and
 * "retrievable from XTrace" is the exact round-trip the first live contact DISPROVED:
 * XTrace extracts payloads rather than storing them. D-7 moved the store of record to
 * the relay, and the questions moved with it:
 *
 *   1. **The relay survives a kill losing nothing.** Every acknowledged mutation —
 *      reads, job annotations, the M10 ledger — must still be there after SIGKILL,
 *      not SIGTERM: the graceful path has nothing to flush by design (P0.8), so the
 *      crash path is the one that proves the write-before-acknowledge claim.
 *      Runs ANYWHERE: it spawns its own relay on a scratch snapshot. No credentials.
 *
 *   2. **Deletion deletes by handle.** M10's premise is that a succeeded job's
 *      `memories_created` handles really delete the derived records. One synthetic
 *      prose line into a SCRATCH scope (never the pool), handles from the job result,
 *      DELETE each, then sample the scope and prove the ids never come back. The
 *      search is non-deterministic (M13), so absence is sampled, and the report says
 *      so rather than overclaiming.
 *
 *   3. **Induction yields a usable claim.** The pool's one remaining job (D-7). The
 *      probe comes from S5's derived artifact — the EXACT query `confit ask` issues
 *      plus the place names a claim faithfully induced from our seed could ground
 *      in. Pass = a non-empty claim naming at least one of them. Requires the pool
 *      seeded (S3) and settled; read-only against the real pool scope.
 *
 * Steps 2 and 3 need XTRACE_BASE_URL / XTRACE_API_KEY, read directly rather than via
 * `loadConfig` — the gate must be able to run its credential-free step on a machine
 * with no config at all. Without them they report BLOCKED — by name, with the run
 * command — and the exit is 3, matching gate-cli's "correct but blocked" convention.
 * Any step that RUNS and fails exits 1. The results doc gets `**Status: PASS**` only
 * when all three pass, which is the exact line `scripts/gate-cli.sh` greps for (D-3).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { MemoryClient, PoolStore } from '../src/contracts/modules.js';
import type { Read } from '../src/contracts/types.js';
import { createLogger } from '../src/config/logger.js';
import { createFetchTransport, createMemoryClient } from '../src/memory/client.js';
import { createPoolStore } from '../src/memory/pool.js';
import { placeNames } from '../src/memory/readProse.js';
import { mintReadId, parseRead } from '../src/kernel/read.js';
import { loadCorpus } from './seed/validate-corpus.js';

export type GateStepStatus = 'PASS' | 'FAIL' | 'BLOCKED';

export interface GateStepResult {
  name: string;
  status: GateStepStatus;
  /** Human-readable evidence lines, carried verbatim into the results doc. */
  lines: string[];
}

// ---------------------------------------------------------------------------
// Step 1 — the relay survives a kill losing nothing
// ---------------------------------------------------------------------------

/** Synthetic, schema-valid reads; ids are minted, everything else cycles. */
export function syntheticReads(n: number): Read[] {
  const signals = ['secret_default', 'regret_after_order', 'trusted_safe_place'] as const;
  const drivers = ['spice_tolerance_low', 'budget_ceiling', 'solo_comfort'] as const;
  const cadences = ['weekly', 'monthly', 'rarely'] as const;
  const out: Read[] = [];
  for (let i = 0; i < n; i++) {
    out.push(
      parseRead({
        read_id: mintReadId(),
        place: `gate0_place_${String(i % 3)}`,
        signal: signals[i % 3],
        driver: drivers[i % 3],
        cadence: cadences[i % 3],
        weight: 0.5 + (i % 5) / 10,
      }),
    );
  }
  return out;
}

export interface WireEntry {
  read: Read;
  received_at: string;
  ingest_job_id?: string;
  pool_memories?: string[];
}

/**
 * Byte-honest comparison of two relay listings, keyed by read_id.
 *
 * Every field matters: `received_at` to the second (the sweeper's settle window reads
 * it), the job annotation (D-1), and the M10 ledger (`pool_memories`) — losing THAT on
 * restart would quietly downgrade every future `forget` to `skipped`.
 */
export function entriesMatch(
  before: WireEntry[],
  after: WireEntry[],
): { equal: boolean; diff: string[] } {
  const diff: string[] = [];
  const byId = new Map(after.map((e) => [e.read.read_id, e]));
  for (const entry of before) {
    const other = byId.get(entry.read.read_id);
    if (!other) {
      diff.push(`${entry.read.read_id}: missing after restart`);
      continue;
    }
    byId.delete(entry.read.read_id);
    if (JSON.stringify(other.read) !== JSON.stringify(entry.read)) {
      diff.push(`${entry.read.read_id}: read body changed`);
    }
    if (other.received_at !== entry.received_at) {
      diff.push(`${entry.read.read_id}: received_at ${entry.received_at} → ${other.received_at}`);
    }
    if (other.ingest_job_id !== entry.ingest_job_id) {
      diff.push(`${entry.read.read_id}: ingest_job_id lost or changed`);
    }
    if (JSON.stringify(other.pool_memories) !== JSON.stringify(entry.pool_memories)) {
      diff.push(`${entry.read.read_id}: pool_memories (the M10 ledger) lost or changed`);
    }
  }
  for (const leftover of byId.keys()) diff.push(`${leftover}: appeared from nowhere after restart`);
  return { equal: diff.length === 0, diff };
}

const GATE_TOKEN = 'gate0-scratch-token';

async function waitForRelay(base: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`${base}/stats`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) {
      throw new Error(`relay did not listen within ${String(timeoutMs)}ms`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

function spawnRelay(port: number, dumpPath: string): ChildProcess {
  return spawn('npx', ['tsx', 'infra/relay/main.ts'], {
    env: {
      ...process.env,
      RELAY_TOKEN: GATE_TOKEN,
      RELAY_PORT: String(port),
      RELAY_DUMP_PATH: dumpPath,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolve) => child.once('exit', () => resolve()));
}

async function authedList(base: string): Promise<WireEntry[]> {
  const res = await fetch(`${base}/reads`, { headers: { 'x-relay-token': GATE_TOKEN } });
  if (!res.ok) throw new Error(`authed list failed: ${String(res.status)}`);
  return (await res.json()) as WireEntry[];
}

export async function stepRestartSurvival(print: (line: string) => void): Promise<GateStepResult> {
  const name = 'relay survives a kill losing nothing';
  const lines: string[] = [];
  const say = (line: string): void => {
    lines.push(line);
    print(`  ${line}`);
  };
  const dir = mkdtempSync(join(tmpdir(), 'confit-gate0-'));
  const dumpPath = join(dir, 'snapshot.json');
  const port = 18787 + (process.pid % 1000);
  const base = `http://127.0.0.1:${String(port)}`;
  let child: ChildProcess | null = null;
  try {
    child = spawnRelay(port, dumpPath);
    await waitForRelay(base, 10_000);

    const reads = syntheticReads(8);
    for (const read of reads) {
      const res = await fetch(`${base}/reads`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: GATE_TOKEN, read }),
      });
      if (res.status !== 201) throw new Error(`seed POST got ${String(res.status)}`);
    }
    // Annotate three with job ids and two with the M10 ledger, and re-put one with a
    // changed body — every kind of acknowledged mutation goes through the crash.
    for (const [i, read] of reads.slice(0, 3).entries()) {
      await fetch(`${base}/reads/${read.read_id}/ingest-job`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: GATE_TOKEN, ingest_job_id: `gate0-job-${String(i)}` }),
      });
    }
    for (const read of reads.slice(0, 2)) {
      await fetch(`${base}/reads/${read.read_id}/memories`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: GATE_TOKEN, pool_memories: [`mem-${read.read_id}`] }),
      });
    }
    const first = reads[0];
    if (first) {
      await fetch(`${base}/reads`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: GATE_TOKEN, read: { ...first, weight: 0.9 } }),
      });
    }

    const before = await authedList(base);
    say(`seeded ${String(before.length)} entries (jobs, ledger, one idempotent re-put)`);

    child.kill('SIGKILL'); // the crash, not the shutdown — nothing may ride on a flush
    await waitForExit(child);
    say('killed with SIGKILL (no graceful path)');

    child = spawnRelay(port, dumpPath);
    await waitForRelay(base, 10_000);
    const after = await authedList(base);
    const verdict = entriesMatch(before, after);
    if (!verdict.equal) {
      for (const line of verdict.diff) say(`LOST: ${line}`);
      return { name, status: 'FAIL', lines };
    }
    say(`restarted from the snapshot: all ${String(after.length)} entries byte-identical`);

    // And the restored store still MUTATES: a forget after a crash must work.
    const victim = before[before.length - 1];
    if (victim) {
      const del = await fetch(`${base}/reads/${victim.read.read_id}`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: GATE_TOKEN }),
      });
      const remaining = await authedList(base);
      if (del.status !== 204 || remaining.length !== before.length - 1) {
        say(`FAIL: post-restart DELETE got ${String(del.status)} with ${String(remaining.length)} left`);
        return { name, status: 'FAIL', lines };
      }
      say('post-restart DELETE works — the restored store is live, not a museum');
    }
    return { name, status: 'PASS', lines };
  } catch (error) {
    say(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    return { name, status: 'FAIL', lines };
  } finally {
    if (child && child.exitCode === null) {
      child.kill('SIGKILL');
      await waitForExit(child);
    }
  }
}

// ---------------------------------------------------------------------------
// Steps 2 and 3 — the XTrace half, credential-gated
// ---------------------------------------------------------------------------

export function xtraceEnv(): { baseUrl: string; apiKey: string } | { missing: string[] } {
  const baseUrl = process.env['XTRACE_BASE_URL']?.trim() ?? '';
  const apiKey = process.env['XTRACE_API_KEY']?.trim() ?? '';
  const missing: string[] = [];
  if (baseUrl === '') missing.push('XTRACE_BASE_URL');
  if (apiKey === '') missing.push('XTRACE_API_KEY');
  return missing.length > 0 ? { missing } : { baseUrl, apiKey };
}

const SETTLE_DEADLINE_SECONDS = 960; // 2× the 480s default window

export interface DeletionDeps {
  client: MemoryClient;
  sleep: (ms: number) => Promise<void>;
  print: (line: string) => void;
}

export async function stepDeletionByHandle(deps: DeletionDeps): Promise<GateStepResult> {
  const name = 'deletion deletes by handle';
  const lines: string[] = [];
  const say = (line: string): void => {
    lines.push(line);
    deps.print(`  ${line}`);
  };
  const scope = `confit:gate0:scratch:${mintReadId()}`;
  try {
    const handle = await deps.client.ingest(
      scope,
      'Someone who goes most weeks to The Gate Zero Test Counter quietly orders the same thing every time.',
    );
    say(`ingested one synthetic line to a scratch scope (job ${handle.jobId})`);

    const deadline = Date.now() + SETTLE_DEADLINE_SECONDS * 1000;
    let status = await deps.client.jobStatus(handle.jobId);
    while (status !== 'complete') {
      if (status === 'failed') {
        say('FAIL: the ingest job failed outright');
        return { name, status: 'FAIL', lines };
      }
      if (Date.now() > deadline) {
        say(`FAIL: job not complete within ${String(SETTLE_DEADLINE_SECONDS)}s`);
        return { name, status: 'FAIL', lines };
      }
      await deps.sleep(5000);
      status = await deps.client.jobStatus(handle.jobId);
    }

    const created = await deps.client.jobResult(handle.jobId);
    if (created.length === 0) {
      say('FAIL: a complete job carried no memories_created — the M10 ledger premise fails');
      return { name, status: 'FAIL', lines };
    }
    say(`job complete with ${String(created.length)} memory handle(s)`);

    for (const row of created) await deps.client.remove(scope, row.memoryId);
    say(`deleted ${String(created.length)} handle(s)`);

    // The search is non-deterministic (M13), so absence is SAMPLED, not proven. Three
    // samples, stated as samples — an overclaim here would be the exact bug forget fixed.
    const deletedIds = new Set(created.map((row) => row.memoryId));
    for (let sample = 1; sample <= 3; sample++) {
      const rows = await deps.client.search(scope, 'test counter', { topK: 40, episodeSlots: 4 });
      const ghost = rows.find((row) => deletedIds.has(row.memoryId));
      if (ghost) {
        say(`FAIL: deleted memory ${ghost.memoryId} came back in sample ${String(sample)}`);
        return { name, status: 'FAIL', lines };
      }
    }
    say('deleted ids absent across 3 search samples (sampled absence — the search is non-deterministic)');
    return { name, status: 'PASS', lines };
  } catch (error) {
    say(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    return { name, status: 'FAIL', lines };
  }
}

export interface InductionProbe {
  query: string;
  expectedPlaceNames: string[];
}

export function loadProbe(): InductionProbe {
  const artifact = JSON.parse(
    readFileSync(new URL('../data/seeds/induction-set.json', import.meta.url), 'utf8'),
  ) as { probe: InductionProbe };
  return artifact.probe;
}

export interface InductionDeps {
  pool: PoolStore;
  probe: InductionProbe;
  print: (line: string) => void;
}

export async function stepInductionClaim(deps: InductionDeps): Promise<GateStepResult> {
  const name = 'induction yields a usable claim';
  const lines: string[] = [];
  const say = (line: string): void => {
    lines.push(line);
    deps.print(`  ${line}`);
  };
  try {
    const claim = await deps.pool.inducedClaim(deps.probe.query);
    if (claim === '') {
      say(
        'FAIL: no episode after the bounded retries — seed the pool (confit pass seed), wait out the settle window, re-run',
      );
      return { name, status: 'FAIL', lines };
    }
    const grounded = deps.probe.expectedPlaceNames.filter((placeName) => claim.includes(placeName));
    say(`claim: "${claim.length > 200 ? `${claim.slice(0, 200)}…` : claim}"`);
    if (grounded.length === 0) {
      say('FAIL: the claim names none of the seeded places — whatever induced it, it was not our seed');
      return { name, status: 'FAIL', lines };
    }
    say(
      `grounded in ${String(grounded.length)} seeded place name(s): ${grounded.slice(0, 5).join(', ')}`,
    );
    return { name, status: 'PASS', lines };
  } catch (error) {
    say(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    return { name, status: 'FAIL', lines };
  }
}

// ---------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------

/**
 * The whole results doc, regenerated per run. `**Status: PASS**` appears ONLY when
 * every step passed — that exact line is what `gate-cli.sh` greps for, so a partial
 * run can never wave the gate through by accident.
 */
export function renderResults(results: GateStepResult[], ranAt: string): string {
  const allPass = results.every((r) => r.status === 'PASS');
  const anyFail = results.some((r) => r.status === 'FAIL');
  const passed = results.filter((r) => r.status === 'PASS');
  const blocked = results.filter((r) => r.status === 'BLOCKED');
  const status = allPass
    ? '**Status: PASS**'
    : anyFail
      ? `**Status: FAIL** — ${results
          .filter((r) => r.status === 'FAIL')
          .map((r) => r.name)
          .join('; ')}. Stop and escalate: a failed step reopens the D-7 architecture.`
      : `**Status: BLOCKED** — ${passed.map((r) => `"${r.name}" PASS`).join(', ')}${
          passed.length > 0 && blocked.length > 0 ? '; ' : ''
        }${blocked.map((r) => `"${r.name}" awaiting credentials`).join(', ')}.`;

  const sections = results
    .map((r) => `### ${r.name} — ${r.status}\n\n${r.lines.map((line) => `- ${line}`).join('\n')}`)
    .join('\n\n');

  return `# Gate zero results — the D-7 protocol (G7)

${status}

Run at: ${ranAt}

The P0.5 protocol is void (DAG §4 D-3 as amended by D-7): nothing drops any more, and
"retrievable from XTrace" is the round-trip the first live contact disproved. The three
questions that block build day now:

1. **The relay survives a kill losing nothing** — SIGKILL, not SIGTERM: every
   acknowledged mutation (reads, job annotations, the M10 ledger) must be present and
   byte-identical after a crash and restart, and the restored store must still mutate.
   Runs anywhere: \`npm run gate0\` spawns its own relay on a scratch snapshot.
2. **Deletion deletes by handle** — one synthetic line into a scratch scope, handles
   from the succeeded job's \`memories_created\`, DELETE each, absence sampled across
   repeated searches (the search is non-deterministic, so absence is sampled, and this
   record says so rather than overclaiming).
3. **Induction yields a usable claim** — S5's probe: the exact \`confit ask\` query
   against the seeded pool, passing only if the claim grounds in at least one seeded
   place name.

Steps 2-3 require \`XTRACE_BASE_URL\` and \`XTRACE_API_KEY\`, and step 3 additionally
requires the pool seeded (\`confit pass seed\`) and settled. A session holding the
credentials clears this by running \`npm run gate0\` and committing this regenerated
file.

## Results

${sections}
`;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const print = (line: string): void => {
    process.stderr.write(`${line}\n`);
  };
  const results: GateStepResult[] = [];

  print('gate zero (D-7 protocol) — step 1: restart survival');
  results.push(await stepRestartSurvival(print));

  const env = xtraceEnv();
  if ('missing' in env) {
    const note = `needs ${env.missing.join(', ')} — run \`npm run gate0\` in a session holding the XTrace credentials`;
    print(`steps 2-3 BLOCKED: ${note}`);
    results.push({ name: 'deletion deletes by handle', status: 'BLOCKED', lines: [note] });
    results.push({ name: 'induction yields a usable claim', status: 'BLOCKED', lines: [note] });
  } else {
    const logger = createLogger((line) => print(`  ${line}`));
    const client = createMemoryClient(
      createFetchTransport({ baseUrl: env.baseUrl, apiKey: env.apiKey }),
    );
    print('step 2: deletion by handle (scratch scope)');
    results.push(
      await stepDeletionByHandle({
        client,
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        print,
      }),
    );
    print('step 3: induction claim (S5 probe against the seeded pool)');
    const pool = createPoolStore({ client, logger, placeName: placeNames(loadCorpus()) });
    results.push(await stepInductionClaim({ pool, probe: loadProbe(), print }));
  }

  const doc = renderResults(results, new Date().toISOString());
  writeFileSync(new URL('../docs/gate0-results.md', import.meta.url), doc);
  print('wrote docs/gate0-results.md');

  if (results.some((r) => r.status === 'FAIL')) process.exit(1);
  if (results.every((r) => r.status === 'PASS')) process.exit(0);
  process.exit(3);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
