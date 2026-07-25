/**
 * Gate zero (P0.5) — design v0.8 §11, D-3. A standalone script, not a confit
 * subcommand: it answers a question that predates the app and must run before
 * the CLI exists. **Blocks build day.** If it fails, stop and escalate — the
 * sole-store decision [E9] reopens.
 *
 * Protocol, exactly as specced: ingest N=12 reads to scratch scopes; poll each
 * to retrievable or 2× the settle window; re-ingest anything missing, max 2
 * rounds; pass = all 12 retrievable within two rounds. Print the
 * rounds-to-retrievable distribution (it sizes the sweeper's retry budget) and
 * the measured ingest→retrievable p50/max — the SETTLE_WINDOW_SECONDS the rest
 * of the build reads. Then one DELETE + verify-gone against a settled read in
 * both scratch scopes, because §7's deletion promise is equally untested.
 *
 * Scratch scopes, not the real pool: gate zero must never pollute the demo
 * pool with synthetic reads.
 *
 * Run: `npm run gate0` (requires XTRACE_BASE_URL/XTRACE_API_KEY etc. — the
 * config parse names anything missing). Results land in docs/gate0-results.md.
 */

import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import type { MemoryClient } from '../src/contracts/modules.js';
import { DRIVERS, CADENCES, SIGNALS, type Read } from '../src/contracts/types.js';
import { loadConfig } from '../src/config/env.js';
import { createFetchTransport, createMemoryClient } from '../src/memory/client.js';
import { mintReadId, parseRead } from '../src/kernel/read.js';

export const GATE0_N = 12;
export const MAX_REINGEST_ROUNDS = 2;

export interface GateZeroDeps {
  client: MemoryClient;
  /** Milliseconds since epoch — injected so tests control latency measurement. */
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  pollIntervalMs: number;
  /** The pre-measurement guess; polling deadline per round is 2× this. */
  settleWindowGuessSeconds: number;
  print: (line: string) => void;
}

export interface GateZeroResult {
  pass: boolean;
  /** rounds-to-retrievable → count; reads never retrievable land in `failures`. */
  distribution: Record<number, number>;
  failures: string[];
  settleP50Seconds: number | null;
  settleMaxSeconds: number | null;
  deleteTrial: { pass: boolean; detail: string };
}

function syntheticReads(): Read[] {
  return Array.from({ length: GATE0_N }, (_, i) => ({
    read_id: mintReadId(),
    place: `gate0_place_${i % 4}`,
    signal: SIGNALS[i % SIGNALS.length] ?? 'secret_default',
    driver: DRIVERS[i % DRIVERS.length] ?? 'solo_comfort',
    cadence: CADENCES[i % CADENCES.length] ?? 'weekly',
    weight: Number((0.5 + (i % 5) * 0.1).toFixed(2)),
  }));
}

async function findRow(
  client: MemoryClient,
  scope: string,
  read: Read,
): Promise<string | null> {
  const rows = await client.search(scope, read.read_id, { topK: 50, episodeSlots: 0 });
  for (const row of rows) {
    try {
      if (parseRead(JSON.parse(row.content)).read_id === read.read_id) return row.memoryId;
    } catch {
      /* a row that is not this read — keep looking */
    }
  }
  return null;
}

export async function runGateZero(deps: GateZeroDeps): Promise<GateZeroResult> {
  const scope = `gate0:${mintReadId()}`;
  const reads = syntheticReads();
  const deadlineMs = deps.settleWindowGuessSeconds * 2 * 1000;

  const roundsByRead = new Map<string, number>();
  const latenciesSeconds: number[] = [];
  let pending = new Map(reads.map((read) => [read.read_id, read]));

  for (let round = 0; round <= MAX_REINGEST_ROUNDS && pending.size > 0; round++) {
    deps.print(
      `gate0: round ${round} — ${round === 0 ? 'ingesting' : 're-ingesting'} ${pending.size} read(s)`,
    );
    const ingestedAt = new Map<string, number>();
    for (const read of pending.values()) {
      await deps.client.ingest(scope, JSON.stringify(read));
      ingestedAt.set(read.read_id, deps.now());
    }

    const roundDeadline = deps.now() + deadlineMs;
    while (pending.size > 0 && deps.now() < roundDeadline) {
      for (const read of [...pending.values()]) {
        const memoryId = await findRow(deps.client, scope, read);
        if (memoryId !== null) {
          const startedAt = ingestedAt.get(read.read_id);
          if (startedAt !== undefined && round === 0) {
            latenciesSeconds.push((deps.now() - startedAt) / 1000);
          }
          roundsByRead.set(read.read_id, round);
          pending.delete(read.read_id);
        }
      }
      if (pending.size > 0) await deps.sleep(deps.pollIntervalMs);
    }
    pending = new Map(pending);
  }

  const distribution: Record<number, number> = {};
  for (const round of roundsByRead.values()) {
    distribution[round] = (distribution[round] ?? 0) + 1;
  }
  const failures = [...pending.keys()];
  const sorted = [...latenciesSeconds].sort((a, b) => a - b);
  const p50 = sorted.length > 0 ? (sorted[Math.floor((sorted.length - 1) / 2)] ?? null) : null;
  const max = sorted.length > 0 ? (sorted[sorted.length - 1] ?? null) : null;

  // ---- deletion trial: one settled read, DELETE + verify-gone, both scratch scopes ----
  let deleteTrial: GateZeroResult['deleteTrial'];
  const settled = reads.find((read) => roundsByRead.has(read.read_id));
  if (settled === undefined) {
    deleteTrial = { pass: false, detail: 'no settled read to run the deletion trial against' };
  } else {
    const secondScope = `${scope}:pool-sim`;
    await deps.client.ingest(secondScope, JSON.stringify(settled));
    const outcomes: string[] = [];
    let ok = true;
    for (const trialScope of [scope, secondScope]) {
      let memoryId = await findRow(deps.client, trialScope, settled);
      const trialDeadline = deps.now() + deadlineMs;
      while (memoryId === null && deps.now() < trialDeadline) {
        await deps.sleep(deps.pollIntervalMs);
        memoryId = await findRow(deps.client, trialScope, settled);
      }
      if (memoryId === null) {
        ok = false;
        outcomes.push(`${trialScope}: never retrievable, cannot trial deletion`);
        continue;
      }
      await deps.client.remove(trialScope, memoryId);
      const stillThere = await findRow(deps.client, trialScope, settled);
      if (stillThere !== null) {
        ok = false;
        outcomes.push(`${trialScope}: still retrievable after DELETE — deletion is not deletion`);
      } else {
        outcomes.push(`${trialScope}: deleted and verified gone`);
      }
    }
    deleteTrial = { pass: ok, detail: outcomes.join('; ') };
  }

  const pass = failures.length === 0 && deleteTrial.pass;
  return {
    pass,
    distribution,
    failures,
    settleP50Seconds: p50,
    settleMaxSeconds: max,
    deleteTrial,
  };
}

export function renderResults(result: GateZeroResult, ranAt: string): string {
  const dist = Object.entries(result.distribution)
    .map(([round, count]) => `| ${round} | ${count} |`)
    .join('\n');
  return `# Gate zero results

**Status: ${result.pass ? 'PASS' : 'FAIL'}** · run at ${ranAt} · protocol: design v0.8 §11 (N=${GATE0_N}, ≤${MAX_REINGEST_ROUNDS} re-ingest rounds)

## Rounds to retrievable

| re-ingest rounds | reads |
| --- | --- |
${dist || '| — | 0 |'}

${result.failures.length > 0 ? `**Never retrievable:** ${result.failures.join(', ')}\n` : ''}
## Measured settle window (round-0 ingest → retrievable)

- p50: ${result.settleP50Seconds ?? 'n/a'} s
- max: ${result.settleMaxSeconds ?? 'n/a'} s

Set \`SETTLE_WINDOW_SECONDS=${result.settleMaxSeconds !== null ? Math.ceil(result.settleMaxSeconds) : '<measured max>'}\` — M7's sweeper and S3's loader read it.

## Deletion trial

${result.deleteTrial.pass ? 'PASS' : 'FAIL'} — ${result.deleteTrial.detail}

${result.pass ? '' : '**A failing gate zero blocks build day: stop and escalate — the sole-store decision [E9] reopens (DAG §4 D-3).**\n'}`;
}

async function main(): Promise<void> {
  const config = loadConfig(); // throws naming missing variables — the honest "blocked" UX
  const client = createMemoryClient(
    createFetchTransport({ baseUrl: config.xtraceBaseUrl, apiKey: config.xtraceApiKey }),
  );
  const result = await runGateZero({
    client,
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    pollIntervalMs: 15_000,
    settleWindowGuessSeconds: config.settleWindowSeconds,
    print: (line) => process.stderr.write(`${line}\n`),
  });
  writeFileSync(
    new URL('../docs/gate0-results.md', import.meta.url),
    renderResults(result, new Date().toISOString()),
  );
  process.stderr.write(`gate0: ${result.pass ? 'PASS' : 'FAIL'} — results in docs/gate0-results.md\n`);
  process.exit(result.pass ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
