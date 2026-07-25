# Foodictador

This repo builds the Confit slice per `docs/confit-implementation-plan.md` (the DAG):
frozen contracts (§3), a parallelizable task DAG cut into six lanes (§4), the clock and
gates (§6), and per-lane task specs (§7). The implementation plan is authoritative for
the build; product decisions are governed by design doc v0.3 (referenced by the plan,
not in this repo).

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
