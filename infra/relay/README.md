# The shared relay (P0.4, made durable in P0.8)

Originally the KV service that carried un-settled reads across devices while XTrace
settled behind it (design v0.8 §6, [E14]) — transport, not memory.

**D-7 changed that: the relay is now the store of record.** Losing it now loses data,
so P0.8 replaced "in-memory with a periodic JSON dump" with a file-backed store that
writes every mutation to disk, atomically, before acknowledging it.

Run:

```bash
RELAY_TOKEN=<token> RELAY_DUMP_PATH=/var/lib/confit/relay.json npx tsx infra/relay/main.ts
```

| Variable | Required | Meaning |
| --- | --- | --- |
| `RELAY_TOKEN` | yes | write token for every mutation |
| `RELAY_DUMP_PATH` | yes, unless `RELAY_EPHEMERAL=1` | snapshot file |
| `RELAY_EPHEMERAL` | — | `1` opts out of persistence *on purpose*; a restart loses everything |
| `RELAY_PORT` | — | default 8787 |

`RELAY_DUMP_INTERVAL_MS` is gone. There is no interval: a mutation is on disk before it
returns, which is the only version of "store of record" worth the name. A timer cannot
provide it at any frequency, because the acknowledgement and the durability are not
ordered — the client is told "stored" and *then* the process dies.

## Durability, precisely

- **Atomic.** Write temp → `fsync` temp → `rename` over the target → `fsync` the
  directory. `rename(2)` is atomic within a filesystem, so a reader sees the whole old
  snapshot or the whole new one. The directory `fsync` is what makes the rename itself
  survive power loss; skipping it is the classic "I called fsync and still lost the
  file".
- **A failed write is a failed mutation.** If the snapshot cannot be written the
  in-memory change is rolled back and the caller gets an error, so the relay cannot
  quietly degrade into an in-memory cache that answers 201.
- **A corrupt snapshot stops the boot.** It is moved to `<path>.corrupt-<timestamp>`
  and the relay refuses to start. Booting empty would overwrite the file on the first
  write, turning "we could not read it" into "it is gone" with nobody deciding to.
- **Cost.** The whole snapshot is rewritten per mutation — O(n) per write. At demo
  scale that is microseconds. An append-only journal with compaction is the right shape
  at real volume and is deliberately not built here: it adds torn-tail records, replay
  ordering, and compaction-crash handling, none of which earn their keep for a relay
  that holds a demo.

## Known gap: [E26] is still open

`GET /reads` is unauthenticated and returns full-precision `received_at`, so anyone who
can reach the relay can correlate an arrival time with whoever just visibly confessed.
Design v0.8 §7 accepted this while the relay held minutes of data; **D-7 makes it hold
everything, for ever, which is what P0.8's brief means by "coarse timestamps move from
the [prod] list to required".**

It is not fixed here because neither available fix fits inside `infra/relay/**`:

- Coarsening `received_at` changes `RelayEntry` in `src/contracts/types.ts` (frozen —
  integrator only), and M7's sweeper computes a seconds-precision settle window from
  that exact field. M9 is rewriting the sweeper right now.
- Requiring the token on `GET /reads` contradicts P0.4's tested "reads stay open" and
  breaks M4's client, which sends no token on `list()`.

Tracked as **P0.9**. Doing half of it — coarsening the field while the sweeper still
needs seconds — would break the sweeper and leave the side channel open through
`?since=` anyway.

## Routes

| Route | Auth | Behaviour |
| --- | --- | --- |
| `POST /reads` `{token, read}` | token | 201; validates against `READ_KEYS` exactly — extra keys (incl. `received_at`, `ingest_job_id`) → 400 |
| `POST /reads/{read_id}/ingest-job` `{token, ingest_job_id}` | token | 204; 404 unknown read |
| `GET /reads?since=` | open | `RelayEntry[]` = `{read, received_at, ingest_job_id?}` — see the [E26] gap below |
| `DELETE /reads/{read_id}` `{token}` | token | 204; 404 unknown — used by both the deletion purge and the sweeper's verified-drop |
| `GET /stats` | open | `{count, oldest_entry_age_seconds}` — every present entry is unverified by construction, so oldest age IS the stuck-entry signal |
| `POST /seed` `{token, reads[]}` | token | `{count}`; batch is all-or-nothing, 400 names the failing index |
| `POST /reset` `{token}` | token | `{count: 0}` |

Re-`POST` of an existing `read_id` updates the body but preserves `received_at` and
`ingest_job_id` — retries must not reset the stuck-entry clock or orphan a job
annotation.

## Two-machine curl round-trip (the P0.4 acceptance drill)

Machine 1:

```bash
RELAY_TOKEN=demo RELAY_DUMP_PATH=./relay.json npx tsx infra/relay/main.ts
```

Kill it with `kill -9` partway through and start it again with the same
`RELAY_DUMP_PATH`: the reads posted from machine 2 are still listed. That is the P0.8
half of the drill, and it is the one that fails against a periodic dump.

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
