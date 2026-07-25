# Gate zero results

**Status: NOT RUN** — blocked on live XTrace credentials.

The runner (`npm run gate0`, `scripts/gate0.ts`) is built and tested against a fake
substrate (pass, fail-at-round-3, and zombie-delete cases all covered), but the real
protocol needs `XTRACE_BASE_URL` / `XTRACE_API_KEY` (plus the relay pair) in the
environment, and no agent in this build has them. Running it is ~40 minutes of
wall-clock once credentials exist; the script writes this file with the verdict, the
rounds-to-retrievable distribution, the measured settle window (p50/max → set
`SETTLE_WINDOW_SECONDS`), and the deletion-trial outcome.

**Until a PASS is recorded here, design v0.8 §11 / DAG D-3 applies:** nothing may
assume the sole-store architecture holds. The shipping configuration for any demo run
before that point is the §2 contingency — `flags.pool = 'relay-only'` — under which the
pool serves the S2 induction set plus live relay contents and the card discloses the
degraded pool. G5's gate treats this file's status as the gate-zero check.

If the real run **fails**: stop and escalate — the sole-store decision [E9] reopens
(the contingency above becomes the architecture, not the fallback).
