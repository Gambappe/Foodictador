# The shared relay (P0.4)

The ~60-line-of-state KV service that carries un-settled reads across devices while
XTrace settles behind it (design v0.8 §6, [E14]). Transport, not memory: losing it
loses nothing that has settled.

Run: `RELAY_TOKEN=<token> npx tsx infra/relay/main.ts` (port `RELAY_PORT`, default
8787; optional `RELAY_DUMP_PATH` + `RELAY_DUMP_INTERVAL_MS` persist a JSON dump).

## Routes

| Route | Auth | Behaviour |
| --- | --- | --- |
| `POST /reads` `{token, read}` | token | 201; validates against `READ_KEYS` exactly — extra keys (incl. `received_at`, `ingest_job_id`) → 400 |
| `POST /reads/{read_id}/ingest-job` `{token, ingest_job_id}` | token | 204; 404 unknown read |
| `GET /reads?since=` | open | `RelayEntry[]` = `{read, received_at, ingest_job_id?}` |
| `DELETE /reads/{read_id}` `{token}` | token | 204; 404 unknown — used by both the deletion purge and the sweeper's verified-drop |
| `GET /stats` | open | `{count, oldest_entry_age_seconds}` — every present entry is unverified by construction, so oldest age IS the stuck-entry signal |
| `POST /seed` `{token, reads[]}` | open? no — token | `{count}`; batch is all-or-nothing, 400 names the failing index |
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
