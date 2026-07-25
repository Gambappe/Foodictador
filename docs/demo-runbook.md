# Confit demo runbook

Three laptops, one cloud-hosted relay. This is an operations document — read it before
demo day, follow it on demo day. It is not executable; `npm run preflight` is the part
that enforces rather than explains.

**The one thing to internalise:** every failure that ruins this demo is silent. A cohort
that counted below its manifest still prints a card. A near-tie that has drifted still
prints a pick. The audience sees a confident wrong answer, not an error. That is what
pre-flight is for.

---

## Topology

| Role | Runs | Holds |
| --- | --- | --- |
| **Relay** (cloud box) | `node dist/infra/relay/main.js` | `RELAY_TOKEN` |
| **Sweeper** (any always-on machine) | `confit sweep --watch` | XTrace + relay creds |
| **Operator laptop** | `confit …` | XTrace + Anthropic + relay creds |
| **Diner laptops** ×2 | `confit …` | XTrace + relay creds |

The relay is the **store of record** (DAG §4 D-7). Its `RELAY_DUMP_PATH` must be on a
volume that survives restarts — lose that file and every confession is gone, permanently.
Each write is atomic and fsynced *before* the client is acknowledged (P0.8), so a crash
costs nothing; a lost disk costs everything.

### Network

**P0.9 closed the ordering side channel.** The open `GET /reads` now serves day-precision
timestamps in `read_id` order with metadata stripped, `?since=` is refused with 401, and
open `/stats` floors the age to whole days. Precise, arrival-ordered data requires the
`x-relay-token` header. So an exposed relay no longer lets a passer-by reconstruct when
each confession arrived.

> **It still must not run on plain HTTP.** The operator token now travels as an
> `x-relay-token` header on *every* request — sweeper, census, ask, confess. On conference
> wifi that is a shared bearer secret in cleartext, and this is a demo about privacy.
>
> Put the relay behind Tailscale/WireGuard (recommended — outbound-only, so venue client
> isolation cannot block it, and the box is never publicly reachable), or terminate TLS in
> front of it. Either is fine now that P0.9 has landed; the choice is operational rather
> than a release blocker.
>
> What remains by design: a live poller diffing open snapshots still sees new arrivals as
> they happen. Design v0.8 §7 accepted and disclosed that for the slice — it needs no
> timestamp to work, and closing it means closing the open surface entirely.

---

## Environment

**Relay box**

```bash
RELAY_TOKEN=<secret>
RELAY_DUMP_PATH=/var/lib/confit/relay.json    # persistent volume, required
RELAY_PORT=8787
```

`RELAY_DUMP_PATH` is mandatory unless you set `RELAY_EPHEMERAL=1`, which means a restart
loses everything. That is deliberate: losing the pool should be something a command line
says, not something an omission causes.

**Every laptop**

```bash
RELAY_URL=https://relay.internal:8787
RELAY_TOKEN=<same secret>
XTRACE_BASE_URL=https://api.production.xtrace.ai
XTRACE_API_KEY=<key>
SETTLE_WINDOW_SECONDS=480
```

**Operator laptop only, additionally**

```bash
ANTHROPIC_API_KEY=<key>
```

Models are pinned in code: `claude-haiku-4-5` for chip extraction, `claude-sonnet-5` for
card copy. Budget one Haiku call per confession and one Sonnet call per `ask`.

Laptops without `ANTHROPIC_API_KEY` degrade automatically and log the reason
(`flag narrator live→template reason=no-api-key`). Their cards are L1 template copy —
good copy, visibly not model copy.

**Do not skip `XTRACE_*` on the diner laptops.** Reads still pool and cohorts still cite
without it, but the confessor's *own memory tier* is not written — and that is half of
what the `[E27]` consent copy promises them. Pre-flight warns about this; take the warning
literally and do not claim the personal-memory half from a machine showing it.

---

## Timeline

### T−24h — seed

```bash
confit pass provision --profile all
confit pass seed
```

Reads are countable from the relay the moment they land. What needs hours is XTrace
building an *induced claim* worth showing — the loader says so on the way out:
*"Seed hours ahead for a good induced claim, not to make the demo work."*

Three people confessing live will never reach the k≥5 citation floor on their own. The
220 seeded reads are what make cohorts citable. Seeding is not set-dressing; it is the
demo's central beat.

### T−12h — start the sweeper

```bash
confit sweep --watch
```

Polls every `settleWindow/2` (4 min at the default). Under D-7 it **deletes nothing** —
it is an induction backfill. Your card does not depend on it; a fully cited card is
produced with zero reads pooled to XTrace. Watch `pending`: it is the only number that
means something is wrong.

### T−1h — pre-flight, on every laptop

```bash
npm run preflight
```

Node, not bash — two of the three laptops are Windows and Git Bash is not a dependency
worth adding to a machine whose job is to run one command on stage. Identical output and
exit code on macOS and Windows.

Must exit 0. It checks node ≥ 20, `dist/`, credentials, relay reachability, that the pool
is not empty, and then the two invariants:

- **`pass census`** — `[E22]`. Any driver counted below its manifest means the seed did
  not fully land. Exit 1 here means **do not start**.
- **`pass neartie`** — the peak beat: the top1−top3 spread and the shift a judge read
  applies. Exit 1 means the climax will not land.

### T−0 — rehearse the exact commands

Type the commands you will type on stage, including a real `confess`, so you see live
Haiku extraction before an audience does.

```bash
confit confess --profile A --text "I order the mild one and call it a preference."
confit ask --profile B
```

---

## When it breaks live

Each of these logs exactly one transition, so you can see it took effect.

```bash
confit pass flags --set narrator=template     # Anthropic slow or down → L1 copy, instant
confit pass flags --set extraction=seeded     # extraction flaky → canned chips
confit pass flags --set demoMode=true         # pins context, makes ask deterministic
confit pass flags                             # show current state
```

**Rehearse `narrator=template`.** It is the difference between a five-second pause and a
dead demo, and the template card is genuinely good. Know what it looks like before you
need it.

| Symptom | Do this |
| --- | --- |
| `ask` hangs or errors on the model | `--set narrator=template` |
| `confess` chip preview hangs | `--set extraction=seeded` |
| Card cites nothing / "first to tell me" | Cohort is below k=5 — check `pass census`; the seed did not land |
| Relay unreachable | Nothing works. Check the tunnel first, the box second |
| Cards vary between runs | `--set demoMode=true` |

---

## What is NOT true yet — do not claim these

Three things this build does not do. Say them accurately if asked; do not discover them
on stage.

1. **`confit forget` deletes by recorded handle, and says so when it cannot.** M10 landed
   the ingest ledger, so a read whose pool ingest succeeded is deleted from XTrace too.
   A read with no recorded handle — confessed before the ledger existed, or whose ingest
   job never succeeded — is reported `skipped` rather than dressed up as deleted. If
   asked, the accurate answer is "yes, and it tells you when it couldn't."
2. **The settle window is still an estimate.** `SETTLE_WINDOW_SECONDS=480` was meant to
   be *measured*. G7's rewritten gate zero records claim 1 (the relay survives a kill
   losing nothing) as a **PASS**, but the two claims needing live credentials — deletion
   by handle, and induction yielding a usable claim — are still outstanding, and nothing
   has measured the real settle time against the live substrate.
3. **A live poller still sees arrivals as they happen.** P0.9 closed the reconstruct-any-
   past-day channel, not this one; §7 accepted it for the slice. If your relay is
   reachable by the audience, someone watching it in real time can correlate an arrival
   with whoever just visibly confessed.

---

## Recovery

**Relay restarted** — nothing to do. Every write was durable before it was acknowledged;
the snapshot is reloaded on boot and it logs `relay: restored N entries`.

**Relay will not start, reporting a corrupt snapshot** — it moved the file to
`<path>.corrupt-<timestamp>` and refused to boot rather than start empty and overwrite it
on the first write. Inspect the quarantined file. If you must proceed, move it aside and
re-seed; you will lose live confessions but the seeded pool is reproducible.

**Pool emptied by accident** (`pass reset` is one mis-click and there is no undo):

```bash
confit pass seed
confit pass census    # must exit 0 before you continue
```

Seeded reads come back exactly. Live confessions do not.
