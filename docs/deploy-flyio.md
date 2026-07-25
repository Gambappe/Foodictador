# Deploy instructions — fly.io relay + three demo laptops

**Hand this whole file to an agent (or a person) and they can execute it top to bottom.**
Every step has a command and an expected result. If a step's expected result does not
appear, stop and report it — do not continue past a failed step.

**Configuration this assumes** (already decided):

- Scripted demo on the seeded profiles → **template copy, seeded chips, zero model spend**
- `ANTHROPIC_API_KEY` is **deliberately not set anywhere**
- Relay on fly.io, reachable only over fly's private network
- Three laptops: macOS and Windows, CLI only, no UI

---

## Part 0 — What the operator must supply

Two secrets. Everything else is generated.

| Secret | Where it comes from |
| --- | --- |
| `XTRACE_API_KEY` | already held |
| `RELAY_TOKEN` | invent one now: `openssl rand -hex 32` |

`RELAY_TOKEN` must be **the same string** on the relay and all three laptops. Generate it
once, write it down, use it everywhere.

---

## Part 1 — Deploy the relay (once, on any machine with `flyctl`)

### 1.1 Install flyctl and log in

```bash
curl -L https://fly.io/install.sh | sh     # macOS/Linux
fly auth login
```
**Expect:** `successfully logged in as <email>`.

### 1.2 Create the app — without a public IP

```bash
cd <repo root>
fly apps create confit-relay
```
**Expect:** `New app created: confit-relay`.

> Do **not** run `fly launch`. It is interactive and will offer to allocate a public IP
> and rewrite `fly.toml`. The committed `fly.toml` deliberately has no `[http_service]`
> and no `[[services]]` block, which is what keeps the relay off the public internet.

### 1.3 Create the volume

```bash
fly volumes create relay_data --region lhr --size 1 --app confit-relay --yes
```
**Expect:** a volume printed with `relay_data` and state `created`.

Match `--region` to `primary_region` in `fly.toml`. **This volume is the store of record —
destroying it destroys every confession, permanently.**

### 1.4 Set the token

```bash
fly secrets set RELAY_TOKEN=<the token from Part 0> --app confit-relay
```
**Expect:** `Secrets are staged for the first deployment`.

### 1.5 Deploy

```bash
fly deploy --app confit-relay
```
**Expect:** the build runs `npm ci` and `npm run build`, then `1 desired, 1 placed, 1
healthy`. Takes a few minutes on first build.

### 1.6 Confirm it is running and NOT public

```bash
fly logs --app confit-relay | head -20
```
**Expect:** `relay: listening on :8787 (durable → /data/relay.json)`

```bash
fly checks list --app confit-relay
```
**Expect:** the `stats` check `passing`. It is an HTTP probe of `/stats` declared in
`fly.toml`; fly ignores the Dockerfile `HEALTHCHECK`, so this is the only thing that
distinguishes "the machine is up" from "the relay answers". A `critical` check here means
the process is wedged — read the logs, do not proceed.

```bash
fly ips list --app confit-relay
```
**Expect: an empty list, or only a private `v6` entry.** If a **public** IPv4 or IPv6 is
listed, the relay is on the internet — remove it with
`fly ips release <address> --app confit-relay` before continuing.

### 1.7 Write one read and delete it — proves the volume is writable

The relay is the store of record, and a volume it cannot write to is invisible until the
first confession: `/stats` answers `200`, the machine reports healthy, and every write
fails. Prove it now, from the machine you deployed from:

```bash
fly proxy 8787:8787 --app confit-relay &     # or a second terminal
curl -s -X POST http://127.0.0.1:8787/reads \
  -H 'content-type: application/json' \
  -d '{"token":"<RELAY_TOKEN>","read":{"read_id":"00000000-0000-4000-8000-000000000000",
       "place":"rosas_taqueria","signal":"pretends_preference","driver":"spice_tolerance_low",
       "cadence":"weekly","weight":0.85}}'
```
**Expect:** `{"read_id":"00000000-…","received_at":"…"}` — HTTP 201.

`{"error":"EACCES: permission denied, open '/data/relay.json.tmp'"}` means the volume is
root-owned and the relay is not running through its entrypoint (SL-61). Stop — seeding and
every confession will fail.

Then remove the probe read, so the pool is exactly the seed:

```bash
curl -s -X DELETE http://127.0.0.1:8787/reads/00000000-0000-4000-8000-000000000000 \
  -H 'content-type: application/json' -d '{"token":"<RELAY_TOKEN>"}'
```
**Expect:** HTTP 204 with no body, and `curl -s http://127.0.0.1:8787/stats` back to
`{"count":0,…}`.

---

## Part 2 — Each laptop (repeat three times)

### 2.1 Install Node 20+ and flyctl

macOS:
```bash
brew install node
curl -L https://fly.io/install.sh | sh
```

Windows (PowerShell):
```powershell
winget install OpenJS.NodeJS.LTS
iwr https://fly.io/install.ps1 -useb | iex
```
**Expect:** `node -v` prints v20 or higher.

### 2.2 Get the code and build

```bash
git clone <repo url> confit && cd confit
bash scripts/install.sh          # macOS
# powershell -ExecutionPolicy Bypass -File scripts\install.ps1    # Windows
```
**Expect:** `Wrote .confit.env` and no build errors.

### 2.3 Open the tunnel — leave this running

```bash
fly auth login
fly proxy 8787:8787 --app confit-relay
```
**Expect:** `Proxying local port 8787 to remote [confit-relay.internal]:8787`.

This is the whole network story: the relay has no public address, and `fly proxy` forwards
a local port to it over fly's private WireGuard. Encrypted, outbound-only, so venue wifi
client isolation cannot block it.

**Leave this terminal open for the entire demo.** If it closes, every command fails until
it is restarted.

### 2.4 Fill in the environment

Edit `.confit.env` (macOS) or `.confit.env.ps1` (Windows):

```bash
export RELAY_URL=http://127.0.0.1:8787     # the local end of the fly proxy
export RELAY_TOKEN=<the token from Part 0>
export XTRACE_BASE_URL=https://api.production.xtrace.ai
export XTRACE_API_KEY=<the key>
export SETTLE_WINDOW_SECONDS=480
export CONFIT_SCRIPTED=1
```

**Do not add `ANTHROPIC_API_KEY`.** Its absence is what guarantees zero spend — the CLI
goes live by default, and a flag can be forgotten.

Then, in a second terminal (the first is running the proxy):

```bash
source .confit.env              # macOS
. .\.confit.env.ps1             # Windows
```

### 2.5 Verify

```bash
npm run preflight
```
**Expect on the first laptop:** `NOT READY` with `the pool is EMPTY` — correct, nothing is
seeded yet. Every other line should be `ok`.

Specifically confirm:
- `ok XTRACE — key works (authenticated, live)`
- `ok ANTHROPIC_API_KEY unset — scripted demo: … zero spend`
- `ok reachable — count=0`

If XTrace shows `SET but does not work`, stop — the key is wrong or has no quota. If it
shows `XTRACE_BASE_URL/XTRACE_API_KEY unset`, stop too: the CLI requires both, so every
command exits 1 before it starts.

`pass provision` in Part 3 does not have to be repeated here. Profile settings live on the
relay (`/settings/{profile}/{key}`), not on disk, so provisioning once reaches every laptop
pointed at the same relay — which is also why every laptop must use the same
`RELAY_TOKEN`.

---

## Part 3 — Seed (once, from any one laptop, T−24h)

```bash
node dist/src/cli/main.js pass provision --profile all
node dist/src/cli/main.js pass seed
```
**Expect:** `Provisioned profile A/B` then `Seeded: …/220 pooled, 220 on the relay.`

`0/220 pooled` with a `pool feed failed` warning is **acceptable** — reads are countable
from the relay immediately (D-7); only XTrace induction is degraded. `220 on the relay` is
the number that matters.

> Seeding writes 220 records to the XTrace account. Do this once, not per laptop.

---

## Part 4 — Final check (T−1h, on every laptop)

```bash
npm run preflight
```
**Expect: `READY.`** with no warnings and exit code 0. In particular:

- `ok pool holds 220 read(s)`
- `ok pass census — clean` ([E22]: every driver at or above its manifest)
- `ok pass neartie — clean` (the peak beat's spread and judge shift)

**A `FAIL` on census or neartie means do not start.** Both failures are silent on stage:
a short cohort still prints a card, a drifted near-tie still prints a pick.

---

## Part 5 — The demo commands

```bash
node dist/src/cli/main.js ask --profile B
node dist/src/cli/main.js confess --profile A --text "<the scripted line>" --yes
node dist/src/cli/main.js pass census
```

Rehearse these exact commands before the audience is in the room.

---

## If something breaks

| Symptom | Cause | Fix |
| --- | --- | --- |
| Every command: `cannot reach … 127.0.0.1:8787` | the `fly proxy` terminal closed | restart it (2.3) |
| `Missing required environment variable(s)` | env not sourced in this terminal | `source .confit.env` |
| `pool is EMPTY` | seed did not run, or ran against a different relay | re-run Part 3; check `RELAY_TOKEN` matches |
| `pass census` exits 1 | seed did not fully land | re-run `pass seed`, then census again |
| Relay unreachable, proxy fine | machine stopped | `fly status --app confit-relay`, then `fly machine start <id>` |
| `fly deploy` refuses: `config file … is not valid` | `fly.toml` was edited (or `fly launch` rewrote it) | `fly config validate -c fly.toml` names the field; do not deploy until it prints `Configuration is valid` |
| Writes 500 with `EACCES … relay.json.tmp`, `/stats` still 200 | the volume is root-owned and the image's entrypoint was bypassed | confirm the machine runs `ENTRYPOINT /usr/local/bin/relay-entrypoint.sh`; `fly ssh console -a confit-relay -C 'ls -ldn /data'` should show uid 1000 |
| `pass seed`: `internal error: … relay: POST /seed failed with 500` | the relay could not write its snapshot — the same EACCES, seen from the CLI | fix the volume ownership above, then `pass seed` again; re-seeding is idempotent (keyed by `read_id`, `count` stays 220) |

Recover the pool after an accidental `pass reset`:

```bash
node dist/src/cli/main.js pass seed
node dist/src/cli/main.js pass census    # must exit 0
```
Seeded reads come back exactly. Live confessions do not.

---

## Known limits — accurate answers if asked on stage

1. **`confit forget`** deletes from the relay and, where a handle was recorded (M10), from
   XTrace. A read with no recorded handle is reported `skipped` rather than dressed up as
   deleted.
2. **The settle window is an estimate.** Gate zero passes all three D-7 claims, but none
   of them measures settle time. `480` is a guess. If induction looks cold, seed earlier —
   do not shrink the number.
3. **Cards are L1 template copy, not model copy**, by choice. Say so if asked; the copy is
   deterministic and rehearsable, which is why it was chosen for a scripted run.
4. **A live poller watching the relay** still sees arrivals as they happen ([E26], accepted
   for the slice). Not reachable here anyway — the relay has no public address.
