# Gate zero results

**Status: BLOCKED** — not on credentials any more. On an architectural contradiction that
gate zero surfaced on its first contact with the live substrate.

Credentials arrived and `api.production.xtrace.ai` was probed directly. The D-2 endpoint
contract is now **CONFIRMED** and recorded in `src/memory/README.md`; the client was wrong
in five ways and has been corrected, and a full `ingest → poll → search → delete`
round-trip now works. Gate zero was then started and **stopped deliberately**, because it
cannot pass as written and the reason is not data loss.

## The contradiction

The pool is designed to store a read as the six-field object and read it back
(`PoolStore.writeRead` ingests `JSON.stringify(read)`; `readsForDriver` parses rows with
`parseRead(JSON.parse(row.content))`). **XTrace does not store payloads. It extracts them.**

Ingesting one read as JSON content produced five prose facts and no JSON:

```
POST /v1/memories  {messages:[{role:'user',content:'{"read_id":"…","place":"rosas_taqueria",…}'}]}
→ job succeeded, memories_created:
    "User's place is rosas_taqueria."
    "User's signal is regret_after_order."
    "User's driver is spice_tolerance_low."
    "User's cadence is weekly."
    …
```

Searching for the `read_id`, and for `rosas_taqueria`, each returned 5 rows and **0
verbatim-JSON rows**. There is no query that returns the object that went in, because the
object never existed in the store — only sentences about it.

## What that invalidates

Everything that assumes a read survives a pool round-trip:

| site | assumption | resolution |
| --- | --- | --- |
| `src/memory/pool.ts` | write `JSON.stringify(read)`, parse it back out | `readsForDriver` deleted (M9) — induction feed only |
| `src/memory/poolView.ts` | pool ∪ relay | relay only (M9) |
| `src/memory/sweeper.ts` | verified → drop the relay entry | never drops (M9); guarded by `tests/guards/relayDurability.test.ts` |
| `src/memory/forget.ts` | find a pool record by `parseRead(JSON.parse(content))` | reports `skipped`, deletes by handle only (M9); closeable as M10 |
| `scripts/gate0.ts:74` | `findRow` locates a read by searching its `read_id` | **still broken** — this script is void, see below (G7) |
| K6 → K4 → K7 | cohort counting, scoring and the card all consume `Read[]` from the pool | unchanged: they consume `Read[]` from `PoolView`, which is the relay now |

The relay is unaffected: it stores the object itself and is exact.

## The doc already knew, in a different sentence

Design v0.8 §14: "**Prose, not notation.** Structured notation extracted **zero** facts from
eight complete records." And `[E18]` records the tension explicitly — the pool can only
ever receive the structured object, while §14 measures structured input as the
worst-extracting representation. What nobody reconciled is that "worst-extracting" is not a
quality problem here; it is a **round-trip impossibility**. `[E25]` closed the read schema,
`[E11]` sent prose to the user tier, and the pool was left writing notation to a substrate
that only speaks prose.

## Resolved: option 1, recorded as D-7

Three shapes it could have taken, all product/architecture calls:

1. **The relay becomes the durable pool.** It already stores exact objects. XTrace keeps the
   induction role it is actually good at (§8's measured strength). This inverts `[E14]`,
   which calls the relay "transport, not memory". ← **CHOSEN by the product owner.**
2. **Reads go in as prose and structure is re-derived on read.** Costs a model call per
   query and makes cohort counts probabilistic — which the k≥5 privacy floor cannot
   tolerate, since a miscounted cohort is either a lost citation or a leak.
3. **A structured store beside XTrace** — Postgres, as design v0.6's `[prod]` stack had.
   Reintroduces a second substrate that `[E9]` removed on purpose.

The read-path changes landed as **M9**: the sweeper became an induction backfill that
deletes nothing, `PoolView` reads the relay, `PoolStore` lost its counting query, and
`forget` reports `skipped` where it used to claim `nothing_to_delete`. Full consequence list
in DAG §4 D-7 and `src/memory/README.md`.

## This gate's protocol is now void, and the script cannot pass

Worth stating plainly, because a `NOT RUN` status invites someone to go and run it.

`scripts/gate0.ts` asks whether a **dropped** read can be recovered by re-ingesting it. That
question exists only because the sweeper dropped verified entries; under D-7 nothing drops,
so there is nothing to recover. Worse, the script's `findRow` locates a read by searching for
its `read_id` — the exact round-trip this document disproved above. It will report every read
as missing, for ever, and a pass would not mean anything if it somehow arrived.

**Do not run `npm run gate0` expecting to clear the gate.** Rewriting it is registered as
**G7**, and it is blocked on **P0.8** because the first thing the new protocol must verify is
relay durability that does not exist yet.

What the replacement must prove:

| # | claim | why it is now load-bearing |
| --- | --- | --- |
| 1 | the relay survives restart losing nothing | it is the sole store of reads — this is the position `[E9]`'s sole store used to hold |
| 2 | deletion deletes, by handle | §7's promise, and `forget` currently reports `skipped` at both XTrace targets (M10) |
| 3 | induction yields a usable claim from N reads | the one role XTrace kept, so far measured only in passing |

## Settle time, measured in passing

Design v0.8 §14 records "ingest→retrievable: 5–8 minutes, consistently", and `[E14]`,
`[E21]` and §11's pre-seed requirement are all built on it. Measured against this API,
repeatedly: **job `succeeded` at t+12s, retrievable at t+13s.** One-message conversations,
so not a like-for-like corpus — but three orders of magnitude off the number the relay was
justified by. It wants re-measuring properly as part of whichever option above is chosen.

## Also found while confirming the contract

A succeeded job's `result.memories_created[]` carries `{id, type, text}`. That is the
job → memory-id mapping `src/memory/README.md` recorded as an open integrator decision for
M8's deletion targets. It closes the question — registered as **M10** — and it now covers
*both* XTrace scopes rather than just the user one, because after M9 the pool target needs
handles too.

## Status of the gate itself

`npm run gate:cli` exits 3 and should keep doing so — but the reason has changed. It is no
longer "we have not checked"; it is "the thing that needed checking turned out to be false,
we changed the architecture, and the new assumptions are unverified." `[E9]`'s sole-store
decision is reopened by evidence, which is exactly the escalation D-3 asked for.

The gate clears when P0.8 lands and G7's rewritten protocol records a PASS here. The record
format is unchanged: `**Status: PASS**` on its own line is what `scripts/gate-cli.sh` greps
for, and nothing else can clear it.
