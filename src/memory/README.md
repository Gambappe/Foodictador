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

## M11: declared settings left XTrace, and `ask`/`confess` started working

DAG §4 D-8's split, implemented. `UsualProfile` and the meal log now live in a durable keyed
store (the relay — see `infra/relay/README.md`); the confession prose stays in XTrace, which is
what it is good at.

**This was not a quality improvement, it was a repair.** `usual()` returned `null` on every
cross-process read against the live substrate, and every CLI invocation is a new process — so
`confit ask` said *"Profile B has no Usual yet"* however many times you provisioned, and
`confit confess` returned `{"kind":"no_profile"}`, because it reads `usual()` for the
off-limits list. Both of the product's two commands, dead, for the whole life of the code.

Root cause: three prostheses for three primitives XTrace does not have. A `kind` field used as
a *search query* instead of addressing, `written_at` ordering to arbitrate the duplicates a
missing upsert guarantees, and a JSON body to survive extraction. All three fail together,
because extraction drops the tag **and** the JSON — probed live, `0` rows carrying
`confit:usual` and `0` verbatim-JSON rows across three queries on two profiles.

Deleted with the move: `findTagged`, `parseTagged`, `newestParsed`, `replaceTagged`,
`written_at` ordering, and both write-through caches. Every one existed only to work around the
absence of a keyed store. The boundary parsers (`parseUsualProfile`, `parseMealLogEntry`) stay
untouched — they were the part that was right, and SL-04 hardened them.

Two behaviours are new rather than ported:

- **A read failure PROPAGATES.** It must not soften to `null`, because X2 reads `null` as "not
  provisioned" — an unreachable store reported as an empty off-limits list is precisely the
  failure D-8 moved this data to avoid. `settingsIntegrity.test.ts` asserts the confession
  cannot be written when the store is unreachable, which is also the fix for **SL-35** (that
  guard was titled "fails CLOSED" while asserting the write went through — true of the old
  store, which could not do better).
- **`setUsual` parses on the way IN.** It is the only write path for off-limits topics (G2, X7,
  U4), so a caller with a hand-built object does not get to put an unhonourable constraint into
  durable storage.

Verified live end to end: `pass provision` → `confess` (7×) → `pass census` (k=7, citable) →
`ask --profile B`, which printed a full card with all four design v0.8 §5 lines for the first
time.

## M12/M14: induction needs grouped conversations AND prose. Measured.

The one role XTrace kept after D-7 and M11 is cross-record synthesis. It was not working, and
neither half of the reason was visible from the code.

`client.ts` minted a fresh `conv_id` per ingest, and XTrace episodes are **conversation
summaries** — so an isolated read could only ever produce a paraphrase of itself. Meanwhile
`pool.writeRead` sent `JSON.stringify(read)`, which is the substrate's worst input (operational
guide R4: *"Structured notation extracted 0 facts from 8 complete records"*).

Twelve reads through the live API, three configurations, the induction query `confit ask`
actually issues:

| configuration | distinct places in one claim | texts leaking a raw id |
| --- | --- | --- |
| one POST per read, JSON (before) | 2 | 12 |
| batched into one conversation, JSON | 4 | 3 |
| batched into one conversation, **prose** | 4 | **0** |

Two independent effects, which is why they shipped together. **Batching** is what produces a
claim spanning several people at all — ungrouped, the episode reads *"The session consisted of
a single structured signal about Harbor Greens"*. **Prose** is what stops `spice_tolerance_low`
coming back out onto a card (L4 — nothing lints the induced claim).

Then the full 220-read seed through the real CLI into a clean scope, queried with the
production query:

> *"The conversation explored a series of examples about people describing their restaurant
> habits in misleading ways… Across places like Miso Hollow, Tortoise Teahouse, Banh Mi Signal,
> Hen & Honey, Rosa's Taqueria, Ash & Rye, Copper Kettle… the repeated conclusion was that each
> place carried something the person would rather not revisit."*

Seventeen places, cross-person, no identifiers. That is design v0.8 §8's differentiator, and it
had never once run before.

Three things fell out, all recorded as tasks:

- **The pool scope must be clean (M15).** Pre-M12 episodes rank ABOVE the new ones for the same
  query — which is what made the first live check look like a failure. The query was never wrong.
- **`INDUCTION_TOP_K` was two rows from losing the claim.** Facts are returned before episodes,
  and the first episode landed at index 10 against a top-k of 12. Raised to 40.
- **`episode_slots` cannot be trusted (M13).** A made-up parameter is accepted with `200`, so
  sending a field proves nothing about whether the server honours it. Top-k headroom is the
  protection that actually works; client-side reservation is the fix.

Incidentally: 220 reads now cost **17 API calls instead of 220**, and the 429s that failed 108
of them are gone.

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
