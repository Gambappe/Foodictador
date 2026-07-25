# Foodictador

This repo builds the Confit slice per `docs/confit-v0.8-task-dag.md` (the CLI-first task
DAG): engineering rules (§1), exclusive lane/file ownership (§2), contract deltas (§3),
the CLI surface (§5), and per-task specs (§7). The DAG is authoritative for the build;
product decisions are governed by design doc v0.8 (`docs/confit-design-v0.8.md`). Plan
v1.0 and designs v0.6–v0.7 are superseded — do not build against them.

## Before starting implementation work

This repo is built by multiple parallel agents against the plan's §4 task DAG. **Read
`docs/workstream-locks.md` and run `node scripts/workstream-lock.mjs list-ready` before
picking a task** — it's the cross-agent lock that stops two agents from grabbing the
same task, or one agent starting work whose dependency hasn't actually merged. Claim
before you branch; update to `in_review`/`done` as your work progresses; release if you
stop.

Everything else about how to work a task — exclusive file ownership per lane (§3.6),
contract-freeze rules (§3, only the integrator edits `src/contracts/**`), trunk-based
merges and parallel-safety rules (§5), gates and the cut order (§6) — is in the
implementation plan.
