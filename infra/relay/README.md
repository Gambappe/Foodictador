# The shared relay (P0.4)

The KV service that holds the pool's reads and carries them across devices
(design v0.8 §6, [E14], as amended by DAG §4 D-7).

> **This is memory, not transport.** [E14] called it "transport, not memory: losing it
> loses nothing that has settled", and that was true while XTrace was the durable side.
> Gate zero ended it — XTrace extracts payloads rather than storing them, so a read exists
> verbatim *here and nowhere else*. Losing this service loses every confession in it,
> permanently. The sweeper no longer deletes from it (see `src/memory/sweeper.ts`), and
> `tests/guards/relayDurability.test.ts` keeps it that way.
>
> The durability to match that role is **not yet built**: the dump below is on a
> 10-second timer, is written non-atomically, and is opt-in. Tracked as **P0.8**.

Run: `RELAY_TOKEN=<token> npx tsx infra/relay/main.ts` (port `RELAY_PORT`, default
8787; optional `RELAY_DUMP_PATH` + `RELAY_DUMP_INTERVAL_MS` persist a JSON dump).

## Routes

| Route | Auth | Behaviour |
| --- | --- | --- |
| `POST /reads` `{token, read}` | token | 201; validates against `READ_KEYS` exactly — extra keys (incl. `received_at`, `ingest_job_id`) → 400 |
| `POST /reads/{read_id}/ingest-job` `{token, ingest_job_id}` | token | 204; 404 unknown read |
| `GET /reads?since=` | open | `RelayEntry[]` = `{read, received_at, ingest_job_id?}` |
| `DELETE /reads/{read_id}` `{token}` | token | 204; 404 unknown — **`forget` only.** The sweeper's verified-drop used to call this and no longer may (D-7) |
| `GET /stats` | open | `{count, oldest_entry_age_seconds}` — `count` is the pool size. Oldest age is **no longer** a stuck-entry signal: nothing is removed, so it is just the oldest read ever confessed. Use `SweepReport.pending` |
| `POST /seed` `{token, reads[]}` | token | `{count}`; batch is all-or-nothing, 400 names the failing index |
| `POST /reset` `{token}` | token | `{count: 0}` |

Re-`POST` of an existing `read_id` updates the body but preserves `received_at` and
`ingest_job_id` — retries must not reset the stuck-entry clock or orphan a job
annotation.

## Two-machine curl round-trip (the P0.4 acceptance drill)

Machine 1:

```bash
RELAY_TOKEN=demo npx tsx infra/relay/main.ts
```

Machine 2 (replace HOST):

```bash
curl -sf -X POST http://HOST:8787/reads \
  -H 'content-type: application/json' \
  -d '{"token":"demo","read":{"read_id":"11111111-1111-4111-8111-111111111111","place":"rosas_taqueria","signal":"secret_default","driver":"solo_comfort","cadence":"weekly","weight":0.7}}'

curl -sf http://HOST:8787/reads          # entry visible from the second machine
curl -sf http://HOST:8787/stats          # {"count":1,"oldest_entry_age_seconds":...}

curl -sf -X DELETE http://HOST:8787/reads/11111111-1111-4111-8111-111111111111 \
  -H 'content-type: application/json' -d '{"token":"demo"}'
```

Round-trip pass = the read posted from machine 2 is listed by machine 1's relay and
deletable with the token. This drill is part of hour zero on build day.
