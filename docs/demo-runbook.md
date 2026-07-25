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

## One machine (a laptop, no cloud box)

Everything above assumes demo day: three laptops, a hosted relay, an audience. For
development, rehearsal, or showing one person over your shoulder, all four roles collapse
onto one MacBook — **you host the relay yourself**, which is the only structural difference.

Verified end to end on the merged trunk; the numbers below are from that run.

**Prerequisites.** Node ≥ 20 (`brew install node`) and an XTrace API key.

> The XTrace key is required even though a single-machine run never needs the pool:
> `loadConfig` demands `XTRACE_API_KEY` before any command does anything, so without it
> every invocation exits with `Missing required environment variable(s)`. Making
> relay-only stop requiring credentials it does not use is outstanding work under
> DEPLOY.1 — until it lands, this is a hard prerequisite rather than an inconvenience.

**1. Install.**

```bash
git clone <repo> && cd Foodictador
bash scripts/install.sh --operator
```

`npm ci`, build, `confit` linked onto PATH, and a `.confit.env` template at mode 600
(gitignored). It writes no secrets — blanks and instructions. If `npm link` fails, which
needs sudo on some setups, the installer prints the alias fallback.

Fill in `.confit.env`:

```bash
export RELAY_URL=http://127.0.0.1:8787
export RELAY_TOKEN=any-local-value       # you are both ends; it still travels on every request
export XTRACE_BASE_URL=https://api.production.xtrace.ai
export XTRACE_API_KEY=<key>
export SETTLE_WINDOW_SECONDS=480
export CONFIT_SCRIPTED=1                 # drop this line if you set ANTHROPIC_API_KEY
```

**2. Relay, in its own terminal.** It runs in the foreground; leave it there.

```bash
RELAY_TOKEN=any-local-value \
RELAY_DUMP_PATH=$HOME/confit-relay.json \
node dist/infra/relay/main.js
# relay: listening on :8787 (durable → /Users/you/confit-relay.json)
```

`RELAY_DUMP_PATH` is the store of record here exactly as it is on the cloud box (D-7).
It is a path in your home directory rather than a Docker volume, which makes it *easier*
to delete by accident, not harder. `RELAY_EPHEMERAL=1` if you genuinely want a scratch run
that discards everything on exit.

**3. Seed, in a second terminal.**

```bash
cd Foodictador && source .confit.env
npm run demo:pack            # writes data/demo/pack.json (deterministic; commit-safe)
confit pass provision
confit pass seed --pack      # 326 pooled = 220 base + 106 pack
npm run preflight
```

**`--pack` is the line that matters.** Without it you get the base corpus alone, and the
five drivers a `UsualProfile` can actually evidence sit one or two reads over the k≥5
floor — so every card cites "5 of them" and the score landscape is flat enough that eight
places tie at exactly 0.6625. With it:

```
spice_tolerance_low   k= 41  citable      manifest=  7  over
budget_ceiling        k= 32  citable      manifest=  6  over
portion_small         k= 21  citable      manifest=  5  over
solo_comfort          k= 29  citable      manifest=  7  over
gi_constraint         k= 13  citable      manifest=  5  over
Cross-check clean: no driver counted below its manifest total.
```

`over` is not a warning. The manifest describes the base seed, and the report already
reads a count above it as live reads joined — `MISMATCH`, counting *below* manifest, is
the one that stops a demo. `pass neartie` stays clean with the pack loaded; the base seed
is deliberately not regenerated, because it is PRNG-tuned so that invariant provably holds.

Pre-flight should end `READY`. On an empty pool it hard-fails instead, which is the whole
point of running it.

**4. Run the showcases.**

```bash
npm run demo
```

Ten beats driven end to end, each asserting the claim it exists to demonstrate. Expect
**9 PASS / 1 SHOW** with an Anthropic key, **8 PASS / 1 SHOW / 1 SKIP** without one — the
skip is the affinity beat (D-14), which reports itself skipped rather than passing
vacuously. `--list` names them; `--only 3,5` runs a subset.

The standing `SHOW` is off-limits: both committed profiles ship `offLimits: []` and no CLI
command sets a topic, so `[E24]` cannot be shown from the CLI at all. It has unit coverage;
the showcase says so rather than implying the confession text merely missed.

**5. Or drive it by hand.**

```bash
confit ask --profile B
confit confess --profile A --text "I only order the safe thing when I'm alone"
confit sweep --once
confit pass census
```

A real card from the verification run:

```
▸ Umami Dive
… Umami Dive is where that leads tonight — 42 people with your real spice tolerance say so.
[people with your real spice tolerance · 42 of them]
Not shoyu ramen — twice this week already, and you turn on it by the third.
Fine to eat alone.
```

### Two things that will catch you out

**`--pack` is opt-in, and `npm run demo` only auto-seeds an *empty* pool.** If you already
ran `confit pass seed` without it, the runner finds reads, seeds nothing, and you rehearse
the thin corpus. Re-run `confit pass seed --pack` explicitly. Re-seeding is safe: it
creates pool duplicates that K6's dedup collapses, and the command discloses it.

**`CONFIT_SCRIPTED=1` together with `ANTHROPIC_API_KEY` makes pre-flight warn.** The
variable is a declaration of intent for pre-flight, not a degrade switch — it does not
suppress model calls. Set one or the other.

---

## Deploying the relay

**On fly.io — the chosen path — follow `docs/deploy-flyio.md`.** It is a step-by-step list
an agent can execute top to bottom. fly's private network replaces the Tailscale sidecar
entirely: the app gets no public IP and laptops reach it with `fly proxy`, which is the
same security property with far less setup and no second account.

The Tailscale + Docker Compose path below remains valid for a generic cloud box.

### Generic cloud box (Tailscale + Docker Compose)

Needs Docker and nothing else.

**1. Make a Tailscale auth key** in the admin console (Settings → Keys). Tick *Ephemeral*
off (you want the node to survive a restart) and *Reusable* on if you may redeploy. If you
use the `tag:confit-relay` tag the compose file advertises, create that tag in your ACL
policy first — `tailscaled` refuses a key whose tag does not exist.

**2. Bring it up.**

```bash
git clone <repo> && cd infra/relay
export TS_AUTHKEY=tskey-auth-...
export RELAY_TOKEN=...          # the same value every laptop uses
docker compose up -d
docker compose logs -f relay    # expect: relay: listening on :8787 (durable → …)
```

**There is no `ports:` stanza in the compose file, and that is the point.** Nothing is
published to the host, so the relay is on no public interface. It shares the Tailscale
container's network namespace, which makes it reachable at `confit-relay:8787` from the
tailnet and from nowhere else. If you ever find yourself adding `ports:` to make something
work, stop — that undoes the entire security posture.

**3. On each laptop**, join the same tailnet and point at the box:

```bash
tailscale up
export RELAY_URL=http://confit-relay:8787   # MagicDNS; or use the tailnet IP
npm run preflight
```

If preflight cannot reach the relay it will tell you to check `tailscale status` first —
on this topology the tunnel is a likelier culprit than the box.

### Why Tailscale rather than a public listener with TLS

The operator token travels as an `x-relay-token` header on *every* request. P0.9 closed
the ordering side channel on the open read view, but the token is still a shared bearer
secret, and on conference wifi over plain HTTP it is readable. Tailscale encrypts it end
to end and is outbound-only, so venue client isolation cannot block the laptops. A public
box with a TLS proxy would also work; this is fewer moving parts and keeps the relay off
the internet entirely.

### The volume is the demo

`relay-data` holds the snapshot. Under D-7 a read exists verbatim there and nowhere else —
XTrace extracts prose rather than storing objects. **Losing that volume loses every
confession, permanently.** `docker compose down` keeps it; `docker compose down -v`
destroys it. Back it up if the demo content matters afterwards:

```bash
docker run --rm -v confit_relay-data:/d -v "$PWD":/b alpine \
  tar czf /b/relay-backup.tgz -C /d .
```

The image is two-stage: it compiles from source rather than trusting a `dist/` someone
built on a laptop, and the runtime layer is node plus ~2.5 MB of `dist/` with **no
`node_modules` at all** — the compiled relay imports nothing outside node builtins. Tests
are deleted before the runtime layer, since they are the only thing that would drag
`vitest` into the image.

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

**Scripted demo (the configured mode): do NOT set `ANTHROPIC_API_KEY` anywhere**

```bash
CONFIT_SCRIPTED=1
```

The demo runs on the seeded profiles, so template copy and seeded chips are the *intent*,
not a degradation — deterministic output is worth more here than model copy, and the spend
is exactly zero. `CONFIT_SCRIPTED=1` tells pre-flight that, so an absent key reads as a
pass rather than a warning.

**Leave the key unset rather than setting flags.** The CLI goes live *by default*; the
flags are what you'd have to remember to set, on all three laptops, every session. A flag
can be forgotten. An absent key cannot spend. Pre-flight warns if `CONFIT_SCRIPTED=1` and
a key is present together, for exactly that reason.

The template card is genuinely good — this is L1 output, with no model involved:

> ▸ Mabel's Diner
> Mabel's Diner — people with your real spice tolerance keep steering the same way. 7 of
> them now.

<details>
<summary>If you later want live model copy (live audience confessions)</summary>

Set `ANTHROPIC_API_KEY` on the operator laptop and drop `CONFIT_SCRIPTED`. Pre-flight then
makes a one-token call to prove the key actually works — a key that authenticates but has
no credit balance returns HTTP 400 at call time, and the narrator would burn a doomed
round-trip per card before flipping to template after three failures.

You need this only if people are confessing live: seeded extraction keyword-matches a
small canned set and falls back to its *first* entry, so an unmatched confession produces
chips that do not reflect what the person actually said.
</details>

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
npm run demo:pack
confit pass seed --pack
```

Reads are countable from the relay the moment they land. What needs hours is XTrace
building an *induced claim* worth showing — the loader says so on the way out:
*"Seed hours ahead for a good induced claim, not to make the demo work."*

Three people confessing live will never reach the k≥5 citation floor on their own. The
seeded reads are what make cohorts citable. Seeding is not set-dressing; it is the demo's
central beat.

**Seed with `--pack`.** The base corpus is 220 reads, but 190 of them sit on six drivers
no `UsualProfile` can evidence, leaving the five that matter at 7/6/5/7/5 — barely over
the floor, which is why an unpacked demo cites "5 of them" everywhere. The pack adds 106
reads across all 26 cuisines and takes those five to 41/32/21/29/13. Plain
`confit pass seed` still works and is still a valid demo; it is just the thin one.

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
2. **The settle window is still an estimate**, even though gate zero now passes.
   `docs/gate0-results.md` records **PASS** on all three D-7 claims against the live
   substrate — the relay survives a kill losing nothing, deletion deletes by handle, and
   induction yields a claim that grounds in a seeded place name. What it does *not* do is
   measure the settle time: `SETTLE_WINDOW_SECONDS=480` remains a guess, and it is what
   the sweeper's re-ingest timing and the seed's "warm no earlier than" both key off. If
   induction looks cold at T−1h, seeding earlier is the lever, not a smaller number here.
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
confit pass seed --pack    # --pack if you seeded with it; census will show fewer cohorts if not
confit pass census         # must exit 0 before you continue
```

Seeded reads come back exactly — both artifacts are deterministic, so recovery restores
the same corpus rather than a similar one. Live confessions do not come back.
