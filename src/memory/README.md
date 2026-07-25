# src/memory — substrate notes

## D-2: XTrace endpoint paths (status: **UNCONFIRMED**)

The DAG (§4 D-2) requires M1 to confirm ingest/search against the live API and record
what it found here. This checkout has **no live XTrace credentials**, so the client
implements the following assumed surface, derived from the two routes design v0.8
names (`DELETE /v1/memories/{id}`, `POST /v1/memories/trigger`) and conventional REST
shape. Everything downstream depends only on the `MemoryClient` interface, so a
surprise here costs one file.

| Method | Path | Body | Assumed response |
| --- | --- | --- | --- |
| POST | `/v1/memories` | `{user_id, content}` | `{job_id}` |
| POST | `/v1/memories/search` | `{user_id, query, top_k, episode_slots}` | `{rows: [{memory_id, kind, content}]}` |
| DELETE | `/v1/memories/{id}` | `{user_id}` | — |
| GET | `/v1/ingest-jobs/{job_id}` | — | `{status: pending\|complete\|failed}` |

**Confirm these during gate zero (P0.5) — it is the first task that touches the live
substrate — and update this table plus `client.ts` in the same commit.** Auth is
assumed `Authorization: Bearer <XTRACE_API_KEY>`.

Non-negotiables the client enforces regardless of path spelling (design v0.8 §14):

- `user_id` is a required positional on every method; no overload can omit it.
- Search always sends an explicit `episode_slots` reservation — facts are returned
  before episodes, and a flat top-k drops every episode.
- Ingest returns a pollable handle (`jobStatus`), which is the sweeper's D-1 primary
  verification path.

## D-1: relay job annotation (owner: M5/M7)

M5 records the observed `setJob` outcome here once the write path lands.
