#!/usr/bin/env node
/**
 * Demo pre-flight (DEPLOY.1). Run at T-1h on every laptop:
 *
 *   npm run preflight
 *
 * Node rather than bash, because two of the three demo laptops are Windows and Git Bash
 * is not a dependency worth adding to a machine whose job is to run one command on stage.
 * The CLI already requires Node, so this needs nothing that is not already there.
 *
 * Exits non-zero on any hard failure. Warnings are counted separately and do not stop the
 * demo, but each one changes what you can honestly claim — they say how.
 *
 * This exists because every failure that ruins this demo is silent. A cohort counted below
 * its manifest still prints a card. A drifted near-tie still prints a pick. The audience
 * sees a confident wrong answer, not an error.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const MAIN = fileURLToPath(new URL('../dist/src/cli/main.js', import.meta.url));

const colour = process.stdout.isTTY && process.env['NO_COLOR'] === undefined;
const paint = (code, text) => (colour ? `[${code}m${text}[0m` : text);
const red = (t) => paint('31', t);
const green = (t) => paint('32', t);
const amber = (t) => paint('33', t);

let fails = 0;
let warns = 0;

const ok = (m) => console.log(green(`  ok    ${m}`));
const hard = (m) => {
  console.log(red(`  FAIL  ${m}`));
  fails += 1;
};
const soft = (m) => {
  console.log(amber(`  WARN  ${m}`));
  warns += 1;
};
/** Continuation of a finding: printed, never counted, so the tally counts problems. */
const cont = (m) => console.log(amber(`        ${m}`));
const note = (m) => console.log(`  note  ${m}`);

console.log('\n── Confit demo pre-flight ─────────────────────────\n');

// ---------------------------------------------------------------- toolchain
console.log('Toolchain');
const major = Number(process.versions.node.split('.')[0]);
if (major < 20) hard(`node ${process.version} — the CLI needs >= 20 (package.json engines)`);
else ok(`node ${process.version} on ${process.platform}`);

if (!existsSync(MAIN)) hard("dist/ is missing — run 'npm run build'");
else ok('dist/ present');

// ---------------------------------------------------------------- credentials
console.log('\nCredentials');
const env = (name) => {
  const value = process.env[name];
  return value === undefined || value.trim() === '' ? null : value;
};

for (const name of ['RELAY_URL', 'RELAY_TOKEN']) {
  if (env(name) === null) hard(`${name} is unset — the relay is the store of record; nothing works without it`);
  else ok(`${name} set`);
}

if (env('XTRACE_BASE_URL') === null || env('XTRACE_API_KEY') === null) {
  // Not hard: reads are countable from the relay alone (D-7). But the confessor's own
  // memory tier is half of what [E27]'s consent copy promises, and it needs XTrace.
  soft("XTRACE_* unset — reads still pool and cohorts still cite, but the confessor's OWN");
  cont('memory tier will not be written. The consent copy promises it. Do not claim the');
  cont('personal-memory half on stage from this machine.');
} else {
  ok('XTRACE_BASE_URL / XTRACE_API_KEY set');
}

if (env('ANTHROPIC_API_KEY') === null) {
  soft("ANTHROPIC_API_KEY unset — extraction degrades to 'seeded', narrator to 'template'.");
  cont('Cards are L1 copy, not model copy. Fine on a diner laptop, wrong on the operator');
  cont('laptop.');
} else {
  ok('ANTHROPIC_API_KEY set');
}

note(
  `settle window = ${env('SETTLE_WINDOW_SECONDS') ?? '480'}s (the 480 default is an ESTIMATE — ` +
    'nothing has measured it against the live substrate; see G7)',
);

// ---------------------------------------------------------------- relay
console.log('\nRelay');
const relayUrl = env('RELAY_URL');
if (relayUrl !== null) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    // The open view is enough here and needs no token: `count` is exact on both views.
    const res = await fetch(new URL('/stats', relayUrl), { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) {
      hard(`relay answered ${res.status} on /stats — check the token and that it is the relay`);
    } else {
      const stats = await res.json();
      ok(`reachable — count=${stats.count}`);
      if (!(stats.count > 0)) {
        hard("the pool is EMPTY. Run 'confit pass seed' — three people confessing cannot");
        cont('reach the k>=5 floor alone, so nothing will be citable.');
      } else {
        ok(`pool holds ${stats.count} read(s)`);
      }
    }
  } catch (error) {
    hard(`cannot reach ${relayUrl}/stats — ${error instanceof Error ? error.message : String(error)}`);
    cont('On Tailscale: check `tailscale status` and that the relay node is online.');
  }
}

// ---------------------------------------------------------------- the demo itself
console.log('\nDemo invariants');
async function invariant(label, args, whenItFails) {
  try {
    await run(process.execPath, [MAIN, ...args], { cwd: root });
    ok(`${label} — clean`);
  } catch (error) {
    hard(`${label} FAILED — ${whenItFails}`);
    const out = `${error.stdout ?? ''}${error.stderr ?? ''}`.trim().split('\n').slice(-4);
    for (const line of out) console.log(`        ${line}`);
  }
}

if (fails === 0) {
  // [E22]: a driver counted below its manifest means the seed did not fully land.
  await invariant('pass census', ['pass', 'census'], 'a driver counted below its manifest. Do not start.');
  // The peak beat: the spread and the shift a judge read applies.
  await invariant('pass neartie', ['pass', 'neartie'], 'the peak beat will not land. Do not start.');
} else {
  console.log(amber('  skipped — fix the failures above first'));
}

// ---------------------------------------------------------------- verdict
console.log('\n────────────────────────────────────────────────');
if (fails > 0) {
  console.log(red(`NOT READY — ${fails} hard failure(s), ${warns} warning(s).`));
  console.log('Every hard failure above is something the demo will not recover from on stage.\n');
  process.exit(1);
}
console.log(
  warns > 0
    ? amber(`READY, with ${warns} warning(s) — read them; they change what you can claim.`)
    : green('READY.'),
);
console.log();
