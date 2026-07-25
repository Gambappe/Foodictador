#!/usr/bin/env node
/**
 * Cross-agent task lock for a plan's work breakdown structure.
 *
 * The registry (`workstream-locks.json`) lives on a dedicated orphan branch
 * (`workstream-locks`) so claim/release/update commits never touch product history or
 * require going through a PR. Concurrency safety comes from git itself: every mutation
 * fetches the branch fresh, edits a local copy in a throwaway worktree, commits, and
 * pushes; a push that loses the race is rejected (non-fast-forward), and the command
 * re-fetches and retries against the new state. Two agents racing to claim the same task
 * cannot both win — at most one push lands.
 *
 * See docs/workstream-locks.md for full usage; run `node scripts/workstream-lock.mjs help`
 * for the command list.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const LOCKS_BRANCH = 'workstream-locks';
const LOCKS_FILE = 'workstream-locks.json';
const MAX_RETRIES = 8;
const VALID_STATUSES = ['available', 'claimed', 'in_review', 'done'];
/** Generic task ids: alphanumeric segments joined by `.` or `-`, starting with a letter.
 * Covers this repo's Confit plan ids (`T0.1`, `A2`, `E3`) as well as `WS3-T2`-style ids
 * from other plans. A trailing `*` is never a task id — that's a group token (see
 * `isGroupToken`), valid only inside `depends_on`. */
const TASK_ID_RE = /^[A-Za-z][A-Za-z0-9]*(?:[.-][A-Za-z0-9]+)*$/;

class UsageError extends Error {}
class ConflictError extends Error {}
/** Thrown inside a `transact` mutate to abort with success semantics BEFORE anything is
 * written or pushed — the "re-running add-tasks is a no-op" guarantee without minting
 * empty timestamp-only commits on the locks branch. */
class NoopSignal extends Error {}

function git(args, opts = {}) {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      ...opts,
    }).trim();
  } catch (err) {
    const stderr = err.stderr?.toString?.() ?? '';
    const e = new Error(`git ${args.join(' ')} failed: ${stderr || err.message}`);
    e.stderr = stderr;
    throw e;
  }
}

function isPushRejection(err) {
  return /rejected|non-fast-forward|fetch first|stale info|cannot lock ref|failed to push/i.test(
    err.stderr ?? err.message,
  );
}

function branchExistsOnRemote() {
  return git(['ls-remote', '--heads', 'origin', LOCKS_BRANCH]).length > 0;
}

function withWorktree(fn) {
  git(['worktree', 'prune']);
  const dir = mkdtempSync(path.join(tmpdir(), 'ws-locks-'));
  git(['fetch', 'origin', LOCKS_BRANCH]);
  git(['worktree', 'add', '--detach', dir, `origin/${LOCKS_BRANCH}`]);
  try {
    return fn(dir);
  } finally {
    try {
      git(['worktree', 'remove', '--force', dir]);
    } catch {
      /* best-effort cleanup */
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

function readRegistry(dir) {
  return JSON.parse(readFileSync(path.join(dir, LOCKS_FILE), 'utf8'));
}

function writeRegistry(dir, data) {
  data.updated_at = new Date().toISOString();
  writeFileSync(path.join(dir, LOCKS_FILE), JSON.stringify(data, null, 2) + '\n');
}

function commitAndPush(dir, message) {
  git(['add', LOCKS_FILE], { cwd: dir });
  git(['commit', '-m', message], { cwd: dir });
  git(['push', 'origin', `HEAD:${LOCKS_BRANCH}`], { cwd: dir });
}

/**
 * Runs `mutate(data)` against a fresh read of the registry, commits, and pushes.
 * On a losing race (push rejected), resets to the new remote tip and retries the whole
 * read-mutate-commit cycle from scratch — `mutate` must be safe to call more than once
 * and should throw a plain Error (not retried) for a business-rule failure such as "task
 * is not available", vs. letting push races (retried) surface only as git failures.
 */
function transact(mutate, message) {
  return withWorktree((dir) => {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      const data = readRegistry(dir);
      const result = mutate(data);
      writeRegistry(dir, data);
      try {
        commitAndPush(dir, message);
        return result;
      } catch (err) {
        if (!isPushRejection(err) || attempt === MAX_RETRIES) throw err;
        git(['fetch', 'origin', LOCKS_BRANCH], { cwd: dir });
        git(['reset', '--hard', `origin/${LOCKS_BRANCH}`], { cwd: dir });
      }
    }
    throw new ConflictError(`Gave up after ${MAX_RETRIES} attempts — high contention on ${LOCKS_BRANCH}.`);
  });
}

function readOnly(fn) {
  return withWorktree((dir) => fn(readRegistry(dir)));
}

/** A `depends_on` token ending in `*` means "every task whose id starts with this prefix"
 * (e.g. `A*` → A1…A5, `T0*` → T0.1…T0.4). At least one matching task must exist. */
function isGroupToken(token) {
  return /^[A-Za-z][A-Za-z0-9.-]*\*$/.test(token);
}

function groupMembers(taskIds, token) {
  const prefix = token.slice(0, -1);
  return taskIds.filter((id) => id.startsWith(prefix));
}

function depsReady(data, dependsOn) {
  return dependsOn.every((dep) => {
    if (isGroupToken(dep)) {
      const members = groupMembers(Object.keys(data.tasks), dep);
      return members.length > 0 && members.every((id) => data.tasks[id].status === 'done');
    }
    const t = data.tasks[dep];
    if (!t) throw new UsageError(`Unknown dependency "${dep}"`);
    return t.status === 'done';
  });
}

function requireTask(data, taskId) {
  const task = data.tasks[taskId];
  if (!task) throw new UsageError(`Unknown task "${taskId}". Run "status" to list all tasks.`);
  return task;
}

function withReady(data, taskId) {
  const task = requireTask(data, taskId);
  return { ...task, ready: depsReady(data, task.depends_on) };
}

// ---- commands ----

function cmdInit({ flags }) {
  if (branchExistsOnRemote() && !flags.force) {
    throw new UsageError(
      `origin/${LOCKS_BRANCH} already exists. Pass --force to overwrite (destroys current lock state).`,
    );
  }
  let seedTasks = {};
  if (flags.seed) {
    const seeded = JSON.parse(readFileSync(flags.seed, 'utf8'));
    seedTasks = seeded.tasks ?? seeded;
  }
  git(['worktree', 'prune']);
  const dir = mkdtempSync(path.join(tmpdir(), 'ws-locks-init-'));
  git(['worktree', 'add', '--detach', dir, 'HEAD']);
  try {
    git(['checkout', '--orphan', LOCKS_BRANCH], { cwd: dir });
    git(['rm', '-rf', '--quiet', '.'], { cwd: dir });
    writeFileSync(
      path.join(dir, LOCKS_FILE),
      JSON.stringify(
        { schema_version: 1, updated_at: new Date().toISOString(), tasks: seedTasks },
        null,
        2,
      ) + '\n',
    );
    writeFileSync(
      path.join(dir, 'README.md'),
      '# workstream-locks\n\n' +
        'This branch holds exactly one file, `workstream-locks.json` — the cross-agent task\n' +
        'lock registry for this repo\'s work breakdown structure. It has no history in\n' +
        'common with the default branch on purpose (an orphan branch): it is operational\n' +
        'state, not product code, and is mutated by direct pushes from\n' +
        '`scripts/workstream-lock.mjs` (run from a normal checkout), never by hand.\n\n' +
        'Full usage instructions: `docs/workstream-locks.md` on the default branch.\n',
    );
    git(['add', '-A'], { cwd: dir });
    git(['commit', '-m', 'chore(locks): bootstrap workstream lock registry'], { cwd: dir });
    git(['push', '--force', 'origin', `HEAD:${LOCKS_BRANCH}`], { cwd: dir });
  } finally {
    try {
      git(['worktree', 'remove', '--force', dir]);
    } catch {
      /* best-effort */
    }
    rmSync(dir, { recursive: true, force: true });
  }
  console.log(`Initialized origin/${LOCKS_BRANCH} with ${Object.keys(seedTasks).length} tasks.`);
}

function cmdStatus({ positional, flags }) {
  const [taskId] = positional;
  const data = readOnly((d) => d);
  if (taskId) {
    console.log(JSON.stringify(withReady(data, taskId), null, 2));
    return;
  }
  if (flags.json) {
    const withReadyAll = Object.fromEntries(
      Object.keys(data.tasks).map((id) => [id, withReady(data, id)]),
    );
    console.log(JSON.stringify({ ...data, tasks: withReadyAll }, null, 2));
    return;
  }
  const rows = Object.entries(data.tasks).map(([id, t]) => ({
    id,
    status: t.status,
    phase: t.phase ?? '',
    ready: depsReady(data, t.depends_on) ? 'yes' : 'no',
    owner: t.owner ?? '',
    mock_start: t.mock_start_ok ? 'yes' : '',
    note: t.note ? `${t.note.slice(0, 60)}${t.note.length > 60 ? '…' : ''}` : '',
  }));
  console.table(rows);
}

function cmdListReady({ flags }) {
  const data = readOnly((d) => d);
  const ready = Object.entries(data.tasks)
    .filter(([, t]) => t.status === 'available')
    .filter(([, t]) => t.mock_start_ok || depsReady(data, t.depends_on))
    .filter(([, t]) => !flags.phase || t.phase === flags.phase)
    .map(([id, t]) => ({
      id,
      title: t.title,
      phase: t.phase ?? '',
      mock_start_ok: t.mock_start_ok,
      note: t.note ?? '',
    }));
  if (flags.json) {
    console.log(JSON.stringify(ready, null, 2));
  } else {
    console.table(ready);
    if (ready.some((r) => r.note)) {
      console.log('\nRead the "note" column before claiming — some tasks have caveats the plan encodes only as prose.');
    }
  }
}

function cmdClaim({ positional, flags }) {
  const [taskId] = positional;
  if (!taskId) throw new UsageError('Usage: claim <taskId> --owner <id> [--branch <name>]');
  if (!flags.owner) throw new UsageError('--owner is required (an identifier for this agent/session).');
  const result = transact((data) => {
    const task = requireTask(data, taskId);
    if (task.status !== 'available') {
      throw new UsageError(
        `${taskId} is not available (status=${task.status}, owner=${task.owner ?? 'none'}).`,
      );
    }
    if (!task.mock_start_ok && !depsReady(data, task.depends_on)) {
      throw new UsageError(
        `${taskId} dependencies are not all done yet: ${task.depends_on.join(', ')}. ` +
          'This task is not marked mock-start-eligible.',
      );
    }
    task.status = 'claimed';
    task.owner = flags.owner;
    task.branch = flags.branch ?? task.branch ?? null;
    task.note = flags.note ?? task.note;
    task.claimed_at = new Date().toISOString();
    task.updated_at = task.claimed_at;
    return task;
  }, `chore(locks): claim ${taskId} (${flags.owner})`);
  console.log(`Claimed ${taskId} for ${flags.owner}.`);
  console.log(JSON.stringify(result, null, 2));
}

const CLEARABLE_FIELDS = ['note', 'pr', 'branch', 'owner'];

function applyClear(task, flags) {
  if (!flags.clear) return;
  for (const field of String(flags.clear).split(',').map((s) => s.trim())) {
    if (!CLEARABLE_FIELDS.includes(field)) {
      throw new UsageError(`--clear "${field}" is not clearable; choose from ${CLEARABLE_FIELDS.join(', ')}`);
    }
    task[field] = null;
  }
}

function cmdUpdate({ positional, flags }) {
  const [taskId] = positional;
  if (!taskId)
    throw new UsageError(
      'Usage: update <taskId> --status <status> [--branch <n>] [--pr <url>] [--note <text>] [--clear note,pr,...]',
    );
  if (flags.status && !VALID_STATUSES.includes(flags.status)) {
    throw new UsageError(`--status must be one of: ${VALID_STATUSES.join(', ')}`);
  }
  const result = transact((data) => {
    const task = requireTask(data, taskId);
    if (flags.status === 'done' && !depsReady(data, task.depends_on)) {
      throw new UsageError(
        `Cannot mark ${taskId} done — dependencies not all done yet: ${task.depends_on.join(', ')}. ` +
          `(Mock-start lets you begin early, but you cannot merge first — see docs/workstream-locks.md.)`,
      );
    }
    if (flags.status) task.status = flags.status;
    if (flags.branch) task.branch = flags.branch;
    if (flags.pr) task.pr = flags.pr;
    if (flags.note) task.note = flags.note;
    applyClear(task, flags);
    task.updated_at = new Date().toISOString();
    return task;
  }, `chore(locks): update ${taskId}${flags.status ? ` -> ${flags.status}` : ''}`);
  console.log(`Updated ${taskId}.`);
  console.log(JSON.stringify(result, null, 2));
}

function cmdRelease({ positional, flags }) {
  const [taskId] = positional;
  if (!taskId) throw new UsageError('Usage: release <taskId> [--note <text>]');
  const result = transact((data) => {
    const task = requireTask(data, taskId);
    task.status = 'available';
    task.owner = null;
    task.branch = null;
    task.pr = null;
    task.claimed_at = null;
    if (flags.note) task.note = flags.note;
    else task.note = null;
    task.updated_at = new Date().toISOString();
    return task;
  }, `chore(locks): release ${taskId}`);
  console.log(`Released ${taskId}.`);
  console.log(JSON.stringify(result, null, 2));
}

function cmdAddTask({ positional, flags }) {
  const [taskId] = positional;
  if (!taskId || !flags.title) {
    throw new UsageError(
      'Usage: add-task <taskId> --title <text> [--phase P0] [--depends a,b,c] [--mock-start-ok] [--note <text>]',
    );
  }
  if (!TASK_ID_RE.test(taskId)) {
    throw new UsageError(`"${taskId}" doesn't look like a task id (expected e.g. A2, T0.1, or WS15-T1).`);
  }
  const dependsOn = flags.depends
    ? String(flags.depends)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
  const result = transact((data) => {
    if (data.tasks[taskId]) {
      throw new UsageError(`${taskId} already exists. Use "update" to change it.`);
    }
    const now = new Date().toISOString();
    data.tasks[taskId] = {
      title: flags.title,
      phase: flags.phase ?? null,
      depends_on: dependsOn,
      mock_start_ok: Boolean(flags['mock-start-ok']),
      note: flags.note ?? null,
      status: 'available',
      owner: null,
      branch: null,
      pr: null,
      claimed_at: null,
      updated_at: now,
    };
    return data.tasks[taskId];
  }, `chore(locks): add ${taskId}`);
  console.log(`Added ${taskId}.`);
  console.log(JSON.stringify(result, null, 2));
}

/**
 * Pure merge of a seed's tasks into registry `data` (mutates `data.tasks`).
 * Existing IDs are NEVER overwritten — they come back as `skipped`, which is what makes
 * `add-tasks` safe to re-run after a partial failure or when two agents race it.
 * Dependencies must resolve inside the merged view (registry ∪ this seed) — either a
 * task id or a `prefix*` group token with at least one member. Seed entries are always
 * born `status: available` with no owner — a seed file cannot smuggle in claims or
 * completed states.
 * Exported for unit tests (`scripts/workstream-lock.test.mjs`).
 */
function mergeSeedTasks(data, seedTasks, now) {
  const ids = Object.keys(seedTasks ?? {});
  if (ids.length === 0) throw new UsageError('Seed contains no tasks.');
  for (const id of ids) {
    if (!TASK_ID_RE.test(id)) {
      throw new UsageError(`Seed task id "${id}" is invalid (expected e.g. A2, T0.1, or WS15-T1).`);
    }
  }
  const merged = { ...data.tasks };
  const skipped = [];
  for (const id of ids) {
    if (data.tasks[id]) skipped.push(id);
    else merged[id] = seedTasks[id]; // provisional — lets seed-internal deps resolve below
  }
  const added = [];
  for (const id of ids) {
    if (data.tasks[id]) continue;
    const seed = seedTasks[id];
    if (typeof seed?.title !== 'string' || seed.title.trim() === '') {
      throw new UsageError(`Seed task ${id} needs a non-empty "title".`);
    }
    const dependsOn = seed.depends_on ?? [];
    if (!Array.isArray(dependsOn) || dependsOn.some((d) => typeof d !== 'string')) {
      throw new UsageError(`Seed task ${id} has a malformed "depends_on" (want an array of id strings).`);
    }
    for (const dep of dependsOn) {
      const resolvable = isGroupToken(dep)
        ? groupMembers(Object.keys(merged), dep).length > 0
        : Boolean(merged[dep]);
      if (!resolvable) {
        throw new UsageError(
          `Seed task ${id} depends on unknown "${dep}" (not in the registry or this seed).`,
        );
      }
    }
    data.tasks[id] = {
      title: seed.title,
      phase: seed.phase ?? null,
      depends_on: dependsOn,
      mock_start_ok: Boolean(seed.mock_start_ok),
      note: seed.note ?? null,
      status: 'available',
      owner: null,
      branch: null,
      pr: null,
      claimed_at: null,
      updated_at: now,
    };
    added.push(id);
  }
  return { added, skipped };
}

function cmdAddTasks({ flags }) {
  if (!flags.seed || flags.seed === true) {
    throw new UsageError(
      'Usage: add-tasks --seed <file.json> — shape {"tasks": {"A1": {"title": "...", "phase": "P0", "depends_on": [], "mock_start_ok"?: true, "note"?: "..."}}}',
    );
  }
  const seeded = JSON.parse(readFileSync(String(flags.seed), 'utf8'));
  const seedTasks = seeded.tasks ?? seeded;
  let outcome;
  try {
    outcome = transact((data) => {
      const result = mergeSeedTasks(data, seedTasks, new Date().toISOString());
      if (result.added.length === 0) {
        throw new NoopSignal(
          `All ${result.skipped.length} seed task(s) are already registered — nothing to do.`,
        );
      }
      return result;
    }, `chore(locks): add-tasks from ${path.basename(String(flags.seed))}`);
  } catch (err) {
    if (err instanceof NoopSignal) {
      console.log(err.message);
      return;
    }
    throw err;
  }
  console.log(`Added ${outcome.added.length} task(s): ${outcome.added.join(', ')}`);
  if (outcome.skipped.length > 0) {
    console.log(
      `Skipped ${outcome.skipped.length} already-registered (left untouched): ${outcome.skipped.join(', ')}`,
    );
  }
}

function cmdRemoveTask({ positional }) {
  const [taskId] = positional;
  if (!taskId) throw new UsageError('Usage: remove-task <taskId>');
  transact((data) => {
    const task = requireTask(data, taskId);
    if (task.status !== 'available') {
      throw new UsageError(
        `Refusing to remove ${taskId} while status=${task.status}. Release it first.`,
      );
    }
    const dependents = Object.entries(data.tasks).filter(([, t]) => t.depends_on.includes(taskId));
    if (dependents.length > 0) {
      throw new UsageError(
        `Refusing to remove ${taskId} — still listed in depends_on by: ${dependents.map(([id]) => id).join(', ')}.`,
      );
    }
    delete data.tasks[taskId];
  }, `chore(locks): remove ${taskId}`);
  console.log(`Removed ${taskId}.`);
}

function printHelp() {
  console.log(`workstream-lock.mjs — cross-agent task lock (see docs/workstream-locks.md)

Commands:
  init [--seed <file>] [--force]         Bootstrap or (with --force) reset the registry
  status [taskId] [--json]               Show all tasks, or one task, with computed readiness
  list-ready [--phase P0] [--json]       Tasks claimable right now (available + deps done)
  claim <taskId> --owner <id> [--branch <name>]
                                          Claim a task (fails if unavailable or not ready)
  update <taskId> --status <s> [--branch <n>] [--pr <url>] [--note <text>] [--clear f1,f2]
                                          Move a task through claimed -> in_review -> done
  release <taskId> [--note <text>]       Return a task to available (abandon / unstick)
  add-task <taskId> --title <text> [--phase P0] [--depends a,b,c] [--mock-start-ok]
                                          Register a new task added after seeding
  add-tasks --seed <file.json>           Register a whole plan's tasks at once (skips
                                          existing ids; re-run is a no-op)
  remove-task <taskId>                   Delete a task (must be available, no dependents)
`);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const positional = [];
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }

  const handlers = {
    init: cmdInit,
    status: cmdStatus,
    'list-ready': cmdListReady,
    claim: cmdClaim,
    update: cmdUpdate,
    release: cmdRelease,
    'add-task': cmdAddTask,
    'add-tasks': cmdAddTasks,
    'remove-task': cmdRemoveTask,
    help: printHelp,
  };

  const handler = handlers[cmd];
  if (!handler) {
    printHelp();
    process.exit(cmd ? 1 : 0);
  }
  try {
    await handler({ positional, flags });
  } catch (err) {
    if (err instanceof UsageError || err instanceof ConflictError) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}

export { mergeSeedTasks, NoopSignal, UsageError };

// Run the CLI only when executed directly (`node scripts/workstream-lock.mjs …`) —
// importing this module (the unit tests do) must not trigger git side effects.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
