# src/memory — substrate notes

## D-7: the relay is the durable store; XTrace does induction

Read this first — it changes what several modules in this directory are for.

**XTrace does not store payloads. It extracts them.** Gate zero ingested one read as JSON
and got back five prose facts (`"User's place is rosas_taqueria."`) with nothing joining
them. Searching for the `read_id`, and for the place, each returned five rows and **zero**
verbatim-JSON rows. There is no query that returns the object that went in, because the
object never existed in the store.

So the pool cannot round-trip a read, and every module here that assumed it could has been
changed:

| module | before | now |
| --- | --- | --- |
| `pool.ts` | `writeRead` + `readsForDriver` counting query | `writeRead` (induction feed) + `inducedClaim`. **No read path.** |
| `poolView.ts` | pool ∪ relay, deduped | the relay, deduped. `degraded` now means "no induced claim", not "counts may be incomplete" |
| `sweeper.ts` | verify against the pool, then **drop** the relay entry | confirm the ingest job, re-ingest what failed, **delete nothing** |
| `forget.ts` | search the pool for the read, delete matches | relay delete is authoritative; XTrace targets need handles or report `skipped` |

The sweeper change is the one that matters. Against a durable relay, verified-drop is the
read destroyed with no second copy — design v0.8 [E12]'s failure, committed by the module
written to prevent it. `tests/guards/relayDurability.test.ts` fails the build if any
read-path module regains a `drop` call.

Consequences worth knowing before you touch anything here:

- **`SETTLE_WINDOW_SECONDS` no longer gates correctness.** A read is countable the instant
  it reaches the relay. The window only decides when the sweeper starts asking XTrace
  about it.
- **`RelayStats.oldest_entry_age_seconds` is no longer a health signal.** Nothing is ever
  removed, so the oldest entry is just the oldest read ever confessed. Use
  `SweepReport.pending`.
- **`COUNTING_K` is gone.** The relay's `GET /reads` takes no limit, so there is no top-k
  to size wrong. G4 now guards that the path does not cap, instead of guarding the number.
- **The relay needs real durability**, which it does not yet have: `infra/relay/main.ts`
  dumps on a 10-second timer with a non-atomic write, and only when `RELAY_DUMP_PATH` is
  set. Tracked as **P0.8**.

Design v0.8 is superseded on this point ([E9], [E12], [E14], [E21]) — DAG §4 D-7 is
authoritative until a v0.9 absorbs it.

## D-2: XTrace endpoint paths (status: **CONFIRMED** against the live API)

Confirmed by direct probing of `api.production.xtrace.ai`. **Every one of the four shapes
this file previously assumed was wrong**, and because `client.test.ts` mocked the
assumptions, all six of its tests passed against a client that could not talk to the
substrate at all. A mock is a claim about someone else's API; an unverified mock makes a
suite an echo of its author.

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| POST | `/v1/memories` | `{user_id, conv_id, messages: [{role, content}]}` | `202` `{object: 'ingest_job', id: 'job_…', status: 'pending'}` |
| GET | `/v1/memories/jobs/{id}` | — | `200` `{object: 'ingest_job', id, status, result}` |
| POST | `/v1/memories/search` | `{user_id, query, top_k, episode_slots}` | `200` `{object: 'search', mode, data: [...], context, stage_timings}` |
| DELETE | `/v1/memories/{id}` | — | `204`; `404 memory_not_found` for an unknown id |

Auth is `Authorization: Bearer <XTRACE_API_KEY>` — that part was right.

### What was wrong, and what it would have cost

| assumed | actual |
| --- | --- |
| ingest body `{user_id, content}` | needs `conv_id` and `messages`; a bare `content` is rejected `422` naming all three required fields |
| ingest returns `{job_id}` | returns `{id}` |
| `GET /v1/ingest-jobs/{id}` | `404`; the route is `GET /v1/memories/jobs/{id}` |
| terminal status `complete` | `pending` → `running` → **`succeeded`**, or `failed`. `complete` never appears, so every poll fell through to `unknown` and no verification could ever pass |
| search returns `{rows: [{memory_id, kind, content}]}` | returns `{data: [{id, type, text, …}]}` |

### A row, in full

```json
{
  "id": "4b85c470-…", "object": "memory", "type": "fact",
  "text": "User keeps going back to Rosa's Taqueria even after a hygiene notice.",
  "user_id": "confit:settle:…", "agent_id": null, "conv_id": "settle-…",
  "app_id": null, "group_ids": [], "categories": ["context"], "score": 1,
  "details": { "fact_type": "context", "status": "active", "supersedes": null,
               "source_role": "user", "episode_id": "ad3a0778-…" }
}
```

`group_ids` is `[]`, which confirms design v0.8 §14's finding empirically: group-scoped
search cannot see these, which is why the pool is a synthetic user.

### The ingest ledger is not missing after all

A succeeded job's `result` carries `memories_created: [{id, type, text}]`. That is exactly
the job → memory-id mapping the M8 section below records as an open integrator decision,
and it closes it: capture the handle at write time, poll to `succeeded`, and read the ids
out of the result. User-scope deletion can be made real rather than `skipped`.

### Settle time is not 5–8 minutes

Design v0.8 §14 records "ingest→retrievable: 5–8 minutes, consistently", and the entire
relay/sweeper/pre-seed architecture ([E14], [E21], §11) is built on that number. Measured
here: **job `succeeded` at t+12s, retrievable at t+13s.** See the gate-zero record for the
N=12 distribution. If the fast number holds, the relay's justification needs revisiting —
that is a design decision, not a code change, and it belongs to the integrator.

Non-negotiables the client enforces regardless of path spelling (design v0.8 §14):

- `user_id` is a required positional on every method; no overload can omit it.
- Search always sends an explicit `episode_slots` reservation — facts are returned
  before episodes, and a flat top-k drops every episode.
- Ingest returns a pollable handle (`jobStatus`), which is the sweeper's D-1 primary
  verification path.

## D-1: relay job annotation (owner: M5/M7)

M5 records the observed `setJob` outcome here once the write path lands.

## XTrace-scope deletion (M8): the ingest ledger, now registered as M10

`forget(read_id)` removes the read itself via the relay — that delete is authoritative and
takes the read out of every cohort count immediately.

Neither XTrace scope can be keyed by `read_id`, and for the same reason: both hold prose
*derived* from the read, and a derived memory carries no back-reference. Searching for the
id and deleting what comes back would let a fuzzy match choose destruction targets, so both
targets delete only against caller-supplied handles and report **`skipped`** with the reason
otherwise.

`skipped`, not `nothing_to_delete`. The pool target used to search for JSON rows holding the
`read_id`, find none — because there are none, ever — and report `nothing_to_delete`, which
told the user nothing was there while five prose facts derived from their confession stayed
put. A deletion report that overstates itself is the one bug this flow cannot have.

The gap is closeable and is no longer an open question: a succeeded job's `result` carries
`memories_created: [{id, type, text}]`, so the handles exist. Capture them at write time and
both targets become real. Registered as **M10**.
