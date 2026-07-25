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

| site | assumption |
| --- | --- |
| `src/memory/pool.ts:35,56` | write `JSON.stringify(read)`, parse it back out |
| `src/memory/forget.ts:58` | find a pool record by `parseRead(JSON.parse(content))` |
| `scripts/gate0.ts:74` | `findRow` locates a read by searching its `read_id` |
| K6 → K4 → K7 | cohort counting, scoring and the card all consume `Read[]` from the pool |

The relay is unaffected: it stores the object itself and is exact.

## The doc already knew, in a different sentence

Design v0.8 §14: "**Prose, not notation.** Structured notation extracted **zero** facts from
eight complete records." And `[E18]` records the tension explicitly — the pool can only
ever receive the structured object, while §14 measures structured input as the
worst-extracting representation. What nobody reconciled is that "worst-extracting" is not a
quality problem here; it is a **round-trip impossibility**. `[E25]` closed the read schema,
`[E11]` sent prose to the user tier, and the pool was left writing notation to a substrate
that only speaks prose.

## Not a decision for an implementer

Three shapes it could take, all product/architecture calls:

1. **The relay becomes the durable pool.** It already stores exact objects. XTrace keeps the
   induction role it is actually good at (§8's measured strength). This inverts `[E14]`,
   which calls the relay "transport, not memory".
2. **Reads go in as prose and structure is re-derived on read.** Costs a model call per
   query and makes cohort counts probabilistic — which the k≥5 privacy floor cannot
   tolerate, since a miscounted cohort is either a lost citation or a leak.
3. **A structured store beside XTrace** — Postgres, as design v0.6's `[prod]` stack had.
   Reintroduces a second substrate that `[E9]` removed on purpose.

## Settle time, measured in passing

Design v0.8 §14 records "ingest→retrievable: 5–8 minutes, consistently", and `[E14]`,
`[E21]` and §11's pre-seed requirement are all built on it. Measured against this API,
repeatedly: **job `succeeded` at t+12s, retrievable at t+13s.** One-message conversations,
so not a like-for-like corpus — but three orders of magnitude off the number the relay was
justified by. It wants re-measuring properly as part of whichever option above is chosen.

## Also found while confirming the contract

A succeeded job's `result.memories_created[]` carries `{id, type, text}`. That is the
job → memory-id mapping `src/memory/README.md` records as an open integrator decision for
M8's user-scope deletion, so that gap is closeable.

## Until this is resolved

Design v0.8 §11 / DAG D-3 still applies, and now for a firmer reason than before: nothing
may assume the sole-store architecture holds, because on this substrate the pool half of it
does not work. `npm run gate:cli` exits 3 and should keep doing so. The `[E9]` sole-store
decision is reopened by evidence, which is exactly the escalation D-3 asked for.
