# src/memory — substrate notes

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

## User-scope deletion (M8): the missing ingest ledger

`forget(read_id)` deletes pool records (their content embeds the `read_id`) and
purges the relay — but user-scope prose memories carry **no** `read_id` linkage,
so that target deletes only when the caller supplies memory handles and reports
`skipped` otherwise. Closing the gap needs an **ingest ledger**: capture the
prose ingest handle at write time (M5's report already carries it) and resolve
job → memory ids once D-2 confirms whether the API exposes that mapping.
Integrator decision, tracked on the M8 registry entry.
