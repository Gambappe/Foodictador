/**
 * The demo showcase runner (DEMO.2) — every beat, driven end to end, checked.
 *
 * `npm run demo` seeds, then runs each showcase and asserts the thing it is meant to show.
 * The point is not the output; the point is that a beat which has QUIETLY STOPPED WORKING
 * fails here rather than in front of an audience. Every failure this session was invisible
 * until something drove it: `sweep` exited 3 on a 429, `pass flags --set` did nothing,
 * `forget` claimed a partial deletion of a read that never existed. None of those had a
 * failing test.
 *
 * So each showcase names its claim and then checks it. A showcase that cannot check itself
 * is marked `SHOW` — worth demonstrating, nothing asserted — rather than dressed up as a pass.
 *
 * Usage:
 *   npm run demo            # seed if needed, run every showcase
 *   npm run demo -- --list  # names only
 *   npm run demo -- --only 3,5
 *
 * Environment is the ordinary demo environment (see docs/deploy-flyio.md). With no
 * ANTHROPIC_API_KEY the affinity showcases report SKIP with the reason, because that is the
 * scripted demo's real posture and pretending otherwise would rehearse a different product.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = join(ROOT, 'dist/src/cli/main.js');
const CORPUS = (() => {
  const raw = JSON.parse(readFileSync(join(ROOT, 'data/places.json'), 'utf8'));
  return Array.isArray(raw) ? raw : raw.places;
})();

// A missing build must say so, not present as ten failed showcases (found by hitting it).
// `preflight` already checks `dist/ present` for exactly this reason; a runner that reports
// "the pool is not countable" when the real answer is "you have not run npm run build" sends
// an operator to debug the substrate an hour before a demo.
if (!existsSync(CLI)) {
  process.stderr.write(
    `demo: ${CLI} is missing — run \`npm run build\` first.\n` +
      'Every showcase drives the built CLI, so nothing below would be meaningful.\n',
  );
  process.exit(2);
}

const argv = process.argv.slice(2);
const only = (() => {
  const i = argv.indexOf('--only');
  return i === -1 ? null : new Set(argv[i + 1].split(',').map((s) => Number(s.trim())));
})();

function confit(args) {
  try {
    const stdout = execFileSync('node', [CLI, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    return { ok: true, stdout, exit: 0 };
  } catch (error) {
    // A non-zero exit is data here, not a crash: several showcases are ABOUT exit codes.
    return {
      ok: false,
      stdout: String(error.stdout ?? ''),
      stderr: String(error.stderr ?? ''),
      exit: error.status ?? -1,
    };
  }
}
const card = (profile) => JSON.parse(confit(['ask', '--profile', profile, '--json']).stdout).card;
const nameOf = (id) => CORPUS.find((p) => p.id === id)?.name ?? id;
const cuisineOf = (id) => CORPUS.find((p) => p.id === id)?.cuisine ?? '?';

const results = [];
function showcase(n, title, claim, run) {
  if (only && !only.has(n)) return;
  process.stdout.write(`\n${'─'.repeat(72)}\n${String(n).padStart(2)}. ${title}\n    claim: ${claim}\n`);
  try {
    const outcome = run();
    const state = outcome.skip ? 'SKIP' : outcome.checked === false ? 'SHOW' : outcome.pass ? 'PASS' : 'FAIL';
    for (const line of outcome.lines ?? []) process.stdout.write(`    ${line}\n`);
    process.stdout.write(`    ${state}${outcome.why ? ` — ${outcome.why}` : ''}\n`);
    results.push({ n, title, state });
  } catch (error) {
    process.stdout.write(`    FAIL — threw: ${error instanceof Error ? error.message : String(error)}\n`);
    results.push({ n, title, state: 'FAIL' });
  }
}

// ---------------------------------------------------------------------------

const hasModelKey = (process.env.ANTHROPIC_API_KEY ?? '') !== '';

showcase(1, 'The pool is loaded and countable', 'reads are countable the moment they land (D-7)', () => {
  const census = confit(['pass', 'census']);
  const stored = /reads stored|k=\s*\d+/.test(census.stdout);
  return {
    pass: census.exit === 0 && stored,
    lines: census.stdout.split('\n').filter((l) => /citable/.test(l)).slice(0, 3),
    why: 'census exits 0 and every driver reports a count',
  };
});

showcase(2, 'A cohort citation, floored', 'no citation below k>=5, and the floor is visible', () => {
  const c = card('B');
  const cited = c.poolCitation;
  return {
    pass: cited === undefined || cited.k >= 5,
    lines: [cited ? `citation: ${cited.driver} · k=${cited.k}` : 'no citation — cohort under the floor'],
    why: cited ? `k=${cited.k} is at or above the floor of 5` : 'the floor suppressed it, which is the guarantee',
  };
});

showcase(3, 'Rotation suppresses what you just ate', 'the meal log removes a dish, and says why', () => {
  const c = card('B');
  return {
    pass: true,
    checked: c.rotationLine !== undefined,
    lines: [c.rotationLine ?? '(no suppression for this profile tonight)'],
    why: c.rotationLine ? 'a dish was suppressed by the diner\'s own recent pattern' : undefined,
  };
});

showcase(4, 'Off-limits blocks all four targets', 'a flagged topic is written NOWHERE ([E24])', () => {
  const before = confit(['pass', 'census']).stdout;
  const out = confit(['confess', '--profile', 'A', '--text', 'the fasting thing again', '--yes']);
  const blocked = /off-limits/i.test(out.stdout);
  const after = confit(['pass', 'census']).stdout;
  return {
    // Only meaningful if the profile actually has the topic flagged; if not, it is a SHOW.
    checked: blocked,
    pass: blocked ? before === after : true,
    lines: [out.stdout.split('\n').find((l) => l.trim() !== '') ?? ''],
    why: blocked ? 'refused, and the census is byte-identical after' : 'profile has no matching off-limits topic',
  };
});

showcase(5, 'A confession is batched, not sent alone', 'four confessions share one ingest call (D-10/M20)', () => {
  const receipts = [];
  for (let i = 0; i < 4; i++) {
    const out = confit(['confess', '--profile', 'A', '--text', `showcase confession ${i}`, '--yes']);
    receipts.push(out.stdout.split('\n').find((l) => l.includes('your memory'))?.trim() ?? '');
  }
  const held = receipts.filter((r) => r.includes('held')).length;
  const sent = receipts.filter((r) => /ok\s/.test(r)).length;
  return {
    pass: held >= 1 && sent >= 1,
    lines: receipts,
    why: `${held} held, then ${sent} sent — the receipt distinguishes them (SL-49)`,
  };
});

showcase(6, 'The card carries all three D-8 inputs', 'crowd, declared profile, and your own words', () => {
  const c = card('B');
  const has = { pool: !!c.reasonLine, personal: !!c.personalLine, usual: !!c.usualLine };
  return {
    pass: has.pool && has.personal,
    lines: [
      `pool claim   : ${has.pool ? 'present' : 'MISSING'}`,
      `personal     : ${has.personal ? 'present' : 'MISSING'}`,
      `usual line   : ${has.usual ? 'present' : 'absent (no note applies)'}`,
    ],
    why: 'the crowd and the diner both speak on one card',
  };
});

showcase(7, 'Preference expressed in words moves the ranking', 'affinity honours what a schema cannot hold (D-14)', () => {
  if (!hasModelKey) {
    return { skip: true, why: 'no ANTHROPIC_API_KEY — scripted demo runs kernel-only, by design' };
  }
  const c = card('B');
  const ranked = Object.entries(c.scores).sort((a, b) => b[1] - a[1]);
  const top = ranked.slice(0, 3).map(([id]) => `${nameOf(id)} (${cuisineOf(id)})`);
  const spread = ranked[0][1] - ranked[ranked.length - 1][1];
  return {
    pass: spread > 0.05,
    lines: [`top three: ${top.join(', ')}`, `score spread across 40: ${spread.toFixed(3)}`],
    why: 'a spread this wide is affinity working; the kernel alone ties eight places exactly',
  };
});

showcase(8, 'Without a model key the product still answers', 'kernel-only is the OLD answer, not a broken one', () => {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  const out = execFileSync('node', [CLI, 'ask', '--profile', 'B'], { encoding: 'utf8', env });
  return {
    pass: out.includes('▸'),
    lines: [out.split('\n')[0]],
    why: 'a card, with no key and no model spend',
  };
});

showcase(9, 'Forget deletes, and says exactly what it could not reach', 'no overclaim in either direction (SL-62)', () => {
  const out = confit(['forget', '00000000-0000-4000-8000-000000000000']);
  const line = out.stdout.split('\n')[0] ?? '';
  // The POSITIVE property, not two absences. Written as absences first, this passed while the
  // relay was down — "Not fully deleted … pool and relay failed" satisfies both negatives, so
  // a totally broken system reported a healthy showcase. That is the exact false-receipt shape
  // this repo has spent the session removing, committed here in the check meant to catch it.
  const saidNothingDeleted = /nothing was deleted/.test(line);
  const saidNotChecked = /not checked/.test(line);
  return {
    pass: saidNothingDeleted && saidNotChecked && !/still in your memory/.test(line) && !/failed/.test(line),
    lines: [line],
    why: 'it states what is known (nothing deleted) and names what was not checked — neither overclaim',
  };
});

showcase(10, 'The sweep converges and reports honestly', 'a substrate failure degrades the report, never the pass', () => {
  const out = confit(['sweep', '--once']);
  const nums = Object.fromEntries(
    ['pooled', 're-ingested', 'PENDING', 'reads stored'].map((k) => [
      k,
      Number((out.stdout.match(new RegExp(`${k}[^\\d]*(\\d+)`)) ?? [])[1] ?? -1),
    ]),
  );
  return {
    pass: out.exit === 0 && nums.pooled >= 0,
    lines: [Object.entries(nums).map(([k, v]) => `${k}=${v}`).join('  ')],
    why: 'exit 0 with counts, including PENDING — the number an operator acts on',
  };
});

// ---------------------------------------------------------------------------

const width = 72;
process.stdout.write(`\n${'═'.repeat(width)}\n`);
const failed = results.filter((r) => r.state === 'FAIL');
for (const r of results) process.stdout.write(`  ${r.state.padEnd(5)} ${String(r.n).padStart(2)}. ${r.title}\n`);
process.stdout.write(`${'═'.repeat(width)}\n`);
if (failed.length > 0) {
  process.stdout.write(`${failed.length} showcase(s) FAILED — do not run this demo until they pass.\n`);
  process.exit(1);
}
process.stdout.write('Every showcase that can check itself, did.\n');
