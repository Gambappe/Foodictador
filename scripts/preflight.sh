#!/usr/bin/env bash
#
# Demo pre-flight (DEPLOY.1). Run this at T-1h. Every check must pass.
#
#   bash scripts/preflight.sh
#
# Exits non-zero on the FIRST hard failure, so a red run cannot be mistaken for a green
# one by scrolling past it. Soft findings are printed as WARN and do not stop the demo,
# but they change what you can honestly claim on stage — each says how.
#
# This exists because the failures that ruin this demo are all silent ones: a cohort that
# counted below its manifest ([E22]) still prints a card, and a near-tie that has drifted
# still prints a pick. You only find out when the audience sees the wrong thing.

set -uo pipefail

CONFIT="${CONFIT:-node dist/src/cli/main.js}"
fail=0
warn=0

red()   { printf '\033[31m%s\033[0m\n' "$1"; }
green() { printf '\033[32m%s\033[0m\n' "$1"; }
amber() { printf '\033[33m%s\033[0m\n' "$1"; }

hard() { red   "  FAIL  $1"; fail=$((fail + 1)); }
soft() { amber "  WARN  $1"; warn=$((warn + 1)); }
ok()   { green "  ok    $1"; }
# Continuation lines for a multi-line finding — printed, never counted, so the tally at
# the bottom is a count of PROBLEMS rather than a count of sentences about them.
cont() { amber "        $1"; }

echo
echo "── Confit demo pre-flight ─────────────────────────────────────────"

# ---------------------------------------------------------------- toolchain
echo
echo "Toolchain"
if ! command -v node >/dev/null 2>&1; then
  hard "node is not on PATH"
else
  major=$(node -p 'process.versions.node.split(".")[0]')
  if [ "$major" -lt 20 ]; then
    hard "node $(node -v) — the CLI needs >= 20 (package.json engines)"
  else
    ok "node $(node -v)"
  fi
fi

if [ ! -f dist/src/cli/main.js ]; then
  hard "dist/ is missing — run 'npm run build'"
else
  ok "dist/ present"
fi

# ---------------------------------------------------------------- credentials
echo
echo "Credentials"
for v in RELAY_URL RELAY_TOKEN; do
  if [ -z "${!v:-}" ]; then hard "$v is unset — the relay is the store of record; nothing works without it"
  else ok "$v set"; fi
done

if [ -z "${XTRACE_BASE_URL:-}" ] || [ -z "${XTRACE_API_KEY:-}" ]; then
  # Not hard: reads are countable from the relay alone (D-7). But the confessor's own
  # memory tier is half of what [E27]'s consent copy promises, and it needs XTrace.
  soft "XTRACE_* unset — reads still pool and cards still cite, but the confessor's OWN"
  cont "memory tier will not be written. The consent copy promises it. Do not claim"
  cont "the personal-memory half on stage from this machine."
else
  ok "XTRACE_BASE_URL / XTRACE_API_KEY set"
fi

if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  soft "ANTHROPIC_API_KEY unset — extraction degrades to 'seeded' and the narrator to"
  cont "'template'. Cards are L1 copy, not model copy. Fine for a diner laptop,"
  cont "wrong for the operator laptop."
else
  ok "ANTHROPIC_API_KEY set"
fi

echo "  note  settle window = ${SETTLE_WINDOW_SECONDS:-480}s (default 480 is an ESTIMATE;"
echo "        gate zero was meant to measure it and is void — see G7)"

# ---------------------------------------------------------------- relay
echo
echo "Relay"
if [ -n "${RELAY_URL:-}" ]; then
  if stats=$(curl -sf --max-time 10 "${RELAY_URL}/stats" 2>/dev/null); then
    ok "reachable — $stats"
    count=$(printf '%s' "$stats" | sed -n 's/.*"count":\([0-9]*\).*/\1/p')
    if [ "${count:-0}" -eq 0 ]; then
      hard "the pool is EMPTY. Run 'confit pass seed' — cohorts cannot reach the k>=5"
      cont "floor on live confessions alone, so nothing will be citable."
    else
      ok "pool holds ${count} read(s)"
    fi
  else
    hard "cannot reach ${RELAY_URL}/stats — check the network and that the relay is up"
  fi
fi

# ---------------------------------------------------------------- the demo itself
echo
echo "Demo invariants"
if [ "$fail" -eq 0 ]; then
  # census: [E22]. A driver counted below its manifest means the seed did not fully land.
  if $CONFIT pass census >/tmp/confit-census.$$ 2>&1; then
    ok "pass census — cross-check clean"
  else
    hard "pass census FAILED — a driver counted below its manifest. Do not start."
    sed 's/^/        /' /tmp/confit-census.$$ | tail -6
  fi
  rm -f /tmp/confit-census.$$

  # neartie: the peak beat. Spread and judge-shift are what the climax stands on.
  if $CONFIT pass neartie >/tmp/confit-neartie.$$ 2>&1; then
    ok "pass neartie — near-tie invariant holds"
  else
    hard "pass neartie FAILED — the peak beat will not land. Do not start."
    sed 's/^/        /' /tmp/confit-neartie.$$ | tail -6
  fi
  rm -f /tmp/confit-neartie.$$
else
  amber "  skipped — fix the failures above first"
fi

# ---------------------------------------------------------------- verdict
echo
echo "───────────────────────────────────────────────────────────────────"
if [ "$fail" -gt 0 ]; then
  red "NOT READY — $fail hard failure(s), $warn warning(s)."
  echo "Every hard failure above is something the demo will not recover from on stage."
  exit 1
fi
if [ "$warn" -gt 0 ]; then
  amber "READY, with $warn warning(s) — read them; they change what you can claim."
else
  green "READY."
fi
echo
