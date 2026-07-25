# Workstream locks — coordinating parallel agents on the Confit DAG

Multiple Claude agents (or humans) can work on different tasks from the implementation
plan's work breakdown (`docs/confit-implementation-plan.md` §4) at the same time. This
document is the usage guide for the tool that stops two agents from claiming — or
shipping — the same task at once.

**If you are an agent about to start implementation work on this repo, read this file
before picking a task.**

## The short version

```bash
# 1. See what you can start right now
node scripts/workstream-lock.mjs list-ready

# 2. Claim the one you're taking (fails loudly if someone beat you to it)
node scripts/workstream-lock.mjs claim A2 --owner "<your session/agent id>" --branch "feat/a2-vault-store"

# 3. Do the work on that branch, inside your lane's file-ownership globs (plan §3.6)

# 4. When you open a PR (if your flow uses PRs — the plan itself is trunk-based, §5.4)
node scripts/workstream-lock.mjs update A2 --status in_review --pr "<pr url>"

# 5. When it merges
node scripts/workstream-lock.mjs update A2 --status done

# If you have to stop before finishing (blocked, out of scope, whatever)
node scripts/workstream-lock.mjs release A2 --note "blocked on x-vec spike verdict, see channel"
```

Run `node scripts/workstream-lock.mjs help` any time for the full command list.

## Why this exists

§4 of the implementation plan lays out ~30 tasks across six lanes with an explicit
dependency DAG, precisely so multiple agents can build the product in parallel. The one
thing the plan can't do on paper is stop two agents from independently grabbing the same
task, or one agent starting a task whose dependency hasn't actually merged yet. That's
what this tool is for — a shared, git-backed registry of "who's doing what," with the
actual claim/release operations made safe under concurrency.

This tool coordinates **who is doing which task**. It does not replace anything in the
plan — exclusive file ownership (§3.6), the contract freeze (§3), trunk-based small
merges and the parallel-safety rules (§5), gates and cut order (§6) all still apply.
Claiming a task here is the first step, not a substitute for the rest of the workflow.

## Where the data lives

The registry is a single file, `workstream-locks.json`, on a dedicated **orphan branch**
called `workstream-locks` — it shares no history with the default branch on purpose. It
holds operational state (who's claimed what), not product code, so it's mutated by direct
pushes from `scripts/workstream-lock.mjs`, never through a PR and never by hand-editing.

You will not see this branch or file in your normal working tree. The script manages it
in a throwaway `git worktree` on every invocation — you don't need to check it out,
switch to it, or merge it into your feature branch. Just run the script from anywhere
inside a checkout of this repo with `origin` reachable.

## How the concurrency guarantee actually works

There's no server, database, or file lock here — just git. Every mutating command
(`claim`, `update`, `release`, `add-task`, `add-tasks`, `remove-task`):

1. Fetches `origin/workstream-locks` fresh.
2. Reads the registry, applies your change to an in-memory copy, and checks business
   rules (is the task actually `available`? are its dependencies actually `done`?).
3. Commits and pushes straight to `workstream-locks`.

If another agent's push landed first, your push is rejected (non-fast-forward) — that's
git's atomic ref update doing the work of a compare-and-swap. The script detects the
rejection, re-fetches, resets to the new tip, and **re-runs the whole read → check →
commit cycle from scratch** against the current state (up to 8 attempts). So if the
other agent claimed the *same* task you wanted, your retry will correctly see
`status: claimed` and fail with a clear error instead of silently double-claiming it. If
they claimed a *different* task, your claim goes through on the next attempt with no
special handling needed on your part.

Net effect: two agents racing to claim the same task can never both win. You don't need
to do anything to get this guarantee — it's built into every command. You also don't
need to worry about corrupting the registry by running commands concurrently with other
agents; worst case you retry a few times.

## Task states

| Status | Meaning |
|---|---|
| `available` | Nobody's on it. Claimable if `ready` (see below). |
| `claimed` | Someone's actively working it. |
| `in_review` | PR is open (set this yourself when you open one). |
| `done` | Merged. Other tasks that depend on it become ready. |

`ready` isn't a stored field — it's computed from `depends_on` every time you run
`status` or `list-ready`, so it's never stale. A task's dependencies can be specific
task IDs (`"A2"`, `"T0.3"`) or a **prefix group token** ending in `*` (`"T0*"`, meaning
*every* registered task whose id starts with `T0` must be `done`). Task ids are generic —
letters/digits in segments joined by `.` or `-` (`T0.1`, `A2`, `WS3-T2` all work), so the
same tool serves whatever plan gets registered next.

## Mock-start tasks

Some tasks are marked `mock_start_ok: true` — in this repo those are the stub-first UI
tasks the plan explicitly schedules before their backend dependencies merge (`E2`, `E3`;
§5.2: "the stub is the spec", integrator wires stub→live at the gates). For these,
`claim` **skips** the dependency-readiness check, because the whole point is you can
start coding against the frozen contracts and stubs before the upstream task merges.

The tool still enforces the other half of that rule: `update <task> --status done` is
**always** gated on real dependency-readiness, mock-start or not. You can start early;
you cannot merge first. If you try, you'll get an error naming exactly which dependency
is still outstanding.

## Reading the `note` field

A handful of tasks have dependencies the plan states as prose rather than a clean task
list — e.g. `F5`'s dependency is literally "all" (recorded as `[F3, F4]` per the DAG
figure), `B2` lists `T0.3/4` where either backend suffices in practice, and `A5`/`C3`
are stretch/non-spine work with an explicit cut order (§6). These caveats are recorded
in the task's `note`. `status` and `list-ready` both surface the note — read it before
claiming anything that has one. A short `depends_on` does not always mean "claimable in
wave 1."

## Command reference

```
init [--seed <file>] [--force]
```
Bootstraps the `workstream-locks` branch. Already done for this repo (seeded from
`docs/confit-tasks.seed.json`) — you should not need this unless you're intentionally
resetting the whole registry (`--force`, destroys current state) or spinning up the same
pattern in a different repo. Seed files use the same shape and normalization as
`add-tasks` — entries are validated and born `available`/unowned either way.

```
status [taskId] [--json]
```
No args: table of every task (id, status, phase, computed `ready`, owner, mock-start
flag, truncated note). With a task ID: full JSON for that one task, including `ready`.

```
list-ready [--phase P0] [--json]
```
The actual "what can I start right now" list: `status: available` and either
`mock_start_ok` or all dependencies `done`. Filter to a phase if you're only working one
lane — in this repo `phase` is `P0` for the Phase-0 tasks and the lane letter (`A`–`F`)
otherwise.

```
claim <taskId> --owner <id> [--branch <name>]
```
Claims a task. Fails immediately (no point retrying) if it's not `available`, or if it's
not ready and not mock-start-eligible. `--owner` should be something that identifies
*you* to a human later — your git branch name, session id, or similar; there's no
enforced identity scheme, this is a cooperative tool between trusted agents, not an auth
boundary.

```
update <taskId> --status <available|claimed|in_review|done> [--branch <n>] [--pr <url>] [--note <text>] [--clear field1,field2]
```
Moves a task through its lifecycle. `--clear` nulls out fields (`note`, `pr`, `branch`,
`owner`) that flags can only ever set to a truthy value. Marking `done` is blocked if
dependencies aren't actually satisfied yet (see Mock-start above).

```
release <taskId> [--note <text>]
```
Returns a task to `available` and clears `owner`/`branch`/`pr`/`claimed_at`. Use this to
abandon work you started, or to unstick a claim that looks dead (see below) — there's no
ownership check, so anyone can release anyone's claim. Leave a `--note` explaining why
when it's not your own claim, so the next agent (and any human watching) has context.

```
add-task <taskId> --title <text> [--phase P0] [--depends a,b,c] [--mock-start-ok] [--note <text>]
remove-task <taskId>
```
For when the plan grows a new lane or task after this registry was seeded. `remove-task`
refuses if the task isn't `available` or if another task still lists it in `depends_on`
— release/re-point dependents first.

```
add-tasks --seed <file.json>
```
Batch form of `add-task` for registering a whole plan at once. This is how the Confit
DAG (`docs/confit-implementation-plan.md` §4) was registered:

```bash
node scripts/workstream-lock.mjs add-tasks --seed docs/confit-tasks.seed.json
```

Existing IDs are never overwritten (reported as skipped) and re-running the command is a
no-op, so it's safe after partial failures or racing agents. Seed entries always enter
as `status: available` with no owner regardless of what the file says; a dependency that
resolves to nothing in the merged view (registry ∪ seed) rejects the whole batch.
Dependency tokens may be task ids or `prefix*` group tokens. Merge logic is unit-tested:
`node --test scripts/workstream-lock.test.mjs`.

## Handling a stale claim

There's no automatic expiry. If a task has been `claimed` for a long time with no
corresponding branch activity or PR, and you (or a human) conclude it's abandoned:

```bash
node scripts/workstream-lock.mjs release D3 --note "no activity since <date>, releasing — see <link> if reviving"
```
Then it's claimable again. Prefer investigating (check the recorded `branch`/`pr` field
first) over reflexively releasing — someone might just be mid-task.

## Troubleshooting

- **"origin/workstream-locks already exists"** on `init` — expected; it's already
  bootstrapped. You don't need to run `init` again.
- **A command hangs or errors on `git worktree add`** — a previous invocation may have
  left a stale worktree registration (e.g. it was killed mid-run). Run
  `git worktree prune` yourself and retry; the script also runs this automatically at the
  start of every command.
- **`Gave up after 8 attempts`** — real contention (many agents claiming at once) or a
  network issue talking to `origin`. Just re-run the command.
