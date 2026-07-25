# The shared relay (P0.4, made durable in P0.8)

The KV service that holds the pool's reads and carries them across devices
(design v0.8 §6, [E14], as amended by DAG §4 D-7).

> **This is memory, not transport.** [E14] called it "transport, not memory: losing it
> loses nothing that has settled", and that was true while XTrace was the durable side.
> Gate zero ended it — XTrace extracts payloads rather than storing them, so a read exists
> verbatim *here and nowhere else*. Losing this service loses every confession in it,
> permanently. The sweeper no longer deletes from it (see `src/memory/sweeper.ts`), and
> `tests/guards/relayDurability.test.ts` keeps it that way.
>
> **P0.8 built the durability to match that role.** The 10-second, non-atomic, opt-in
> dump is gone: every mutation is written to disk atomically before it is acknowledged.

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

## [E26] closed for the slice (P0.9 / D-12)

`GET /reads` and `GET /stats` stay open — the disclosure posture is the point: anyone can
see WHAT the pool holds, six identity-free fields per read. What the open surface no longer
serves is WHEN and IN WHAT ORDER:

- open `received_at` is **day precision** (`2026-07-25`), entries sorted by `read_id`
  (arrival-independent), and `ingest_job_id`/`pool_memories` are omitted;
- open `?since=` is refused with `401` — it is an ordering query by construction;
- open `/stats` floors `oldest_entry_age_seconds` to whole days; `count` stays exact.

The same routes with the `x-relay-token` header (M11's convention) serve exactly the
pre-P0.9 view: seconds precision, arrival order, `since` filtering, full metadata. M4's
client sends the header on every request, so the sweeper's settle window, PoolView counting,
and the pass reports are unchanged — `RelayEntry` in the frozen contracts did not move.

What remains, deliberately: a live poller diffing open snapshots still observes new arrivals
as they happen. That is the [E26] risk design v0.8 §7 accepted and disclosed for the slice —
it needs no timestamp to work, and closing it means closing the open surface entirely
([prod]'s call, not ours). What D-7 had silently added — reconstructing ANY PAST DAY's
arrival ordering from a one-shot open read — is what this closes.

## Routes

| Route | Auth | Behaviour |
| --- | --- | --- |
| `POST /reads` `{token, read}` | token | 201; validates against `READ_KEYS` exactly — extra keys (incl. `received_at`, `ingest_job_id`) → 400 |
| `POST /reads/{read_id}/ingest-job` `{token, ingest_job_id}` | token | 204; 404 unknown read |
| `GET /reads` | open | coarse view: `{read, received_at}` day-precision, `read_id` order, no metadata; `?since=` → 401 ([E26]/P0.9) |
| `GET /reads?since=` | `x-relay-token` | operator view: `RelayEntry[]` = `{read, received_at, ingest_job_id?, pool_memories?}`, seconds precision, arrival order |
| `DELETE /reads/{read_id}` `{token}` | token | 204; 404 unknown — **`forget` only.** The sweeper's verified-drop used to call this and no longer may (D-7) |
| `GET /stats` | open (coarse) / `x-relay-token` (precise) | `{count, oldest_entry_age_seconds}` — `count` is the pool size, exact on both views; open age is day-floored (P0.9). Oldest age is **no longer** a stuck-entry signal: nothing is removed, so it is just the oldest read ever confessed. Use `SweepReport.pending` |
| `POST /seed` `{token, reads[]}` | token | `{count}`; batch is all-or-nothing, 400 names the failing index |
| `POST /reset` `{token}` | token | `{count: 0}` |

Re-`POST` of an existing `read_id` updates the body but preserves `received_at` and
`ingest_job_id` — retries must not restart the settle window the sweeper measures from,
or orphan a job annotation.

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

## Settings (M11, DAG §4 D-8)

The relay also holds **declared settings** — what the user stated about themselves. D-8 splits
by who authored a fact: assertions (allergies, intolerances, budget band, portion, solo
comfort, off-limits topics, the meal log) need exactness, so they live here; experiences go to
XTrace, which extracts rather than stores.

They are here because P0.8's guarantee is the one an allergy list needs: written atomically and
fsynced **before** the mutation is acknowledged. XTrace offered no addressing, no upsert and no
byte fidelity, and `~11/16` non-deterministic retention — a dropped off-limits topic is a
confession that should have been blocked, written to the pool.

| Route | Auth | Behaviour |
| --- | --- | --- |
| `GET /settings/{profile}/{key}` | **token, in `x-relay-token`** | `200` `{profile, key, value}`; `value: null` for absent |
| `PUT /settings/{profile}/{key}` `{token, value}` | token | `204`; `400` without a `value` |

**The token is required on the GET, unlike `/reads`.** A pool read carries no account linkage
([E26]); settings are one named person's allergies. No schema check happens here on purpose —
the boundary parser is M3's `parseUsualProfile`, so one implementation owns the rule rather
than two that can drift.

**`POST /reset` does not clear settings**, and must not: `pass reset` empties the pool between
demos, and wiping a user's declared allergies along with it would be the worst possible reading
of "reset". `infra/relay/durability.test.ts` pins that.

> **KNOWN LIMITATION.** The relay has ONE token, so any client holding it can read ANY
> profile's settings. That is acceptable for a two-profile demo run by one operator and is
> **not** acceptable for real multi-user use, which needs per-profile credentials first.
> Stated here rather than left to be discovered.

Snapshot format grew a `settings` object alongside `entries`. A snapshot written before this
existed has no such key and restores as "no settings" rather than failing the boot.
