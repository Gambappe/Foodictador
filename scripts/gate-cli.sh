#!/usr/bin/env bash
#
# The CLI acceptance gate (G5).
#
# Runs everything that can be verified without credentials, then checks the one thing that
# cannot: whether gate zero has actually been run (DAG §4 D-3).
#
# Exit codes are deliberately distinct, because "you broke something" and "the architecture
# is still unverified" need different reactions:
#
#   0  everything green, including a recorded gate-zero PASS
#   1  a code check failed — typecheck, lint, tests or build
#   3  code is green, gate zero is NOT recorded as passing
#
# There is no way to wave gate zero through. A gate you can skip is not a gate, and D-3 is
# explicit that nothing may assume the sole-store architecture holds until the real protocol
# has run. If you need to ship before then, the answer is design v0.8 §2's contingency
# (flags.pool = 'relay-only'), not a green light here.
#
# `--gate0-only` runs ONLY the gate-zero record check, skipping the code checks. CI calls it
# so the PASS pattern is defined here once rather than copied into the workflow. It is a
# subset, not an escape: it can report the blocker and never clear it.
#
# `GATE0_RECORD` overrides the record path. It exists so the check itself can be tested
# against a fixture — with `--gate0-only` there is no recursion, because that path never
# runs `npm test`. Do NOT invoke this script without `--gate0-only` from a test: the full
# gate runs the suite, and a test that shells into it recurses.
#
# No network and no ANTHROPIC_API_KEY are required, by design: P0.3 makes the model key
# optional and P0.6's fixtureGraph needs no config at all.

set -uo pipefail

GATE0_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --gate0-only) GATE0_ONLY=1 ;;
    *) printf 'unknown option: %s\n' "$arg" >&2; exit 2 ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

GATE0_RECORD="${GATE0_RECORD:-docs/gate0-results.md}"
failed=()

step() {
  local name="$1"
  shift
  printf '\n── %s ──\n' "$name"
  if "$@"; then
    printf '   PASS  %s\n' "$name"
  else
    printf '   FAIL  %s\n' "$name"
    failed+=("$name")
  fi
}

if [ "$GATE0_ONLY" -eq 0 ]; then
  printf 'Confit CLI acceptance gate\n'

  step 'typecheck' npm run --silent typecheck
  step 'lint'      npm run --silent lint
  step 'tests'     npm run --silent test
  step 'build'     npm run --silent build
  rm -rf dist

  if [ ${#failed[@]} -gt 0 ]; then
    printf '\n=====================================================================\n'
    printf 'GATE FAILED — %d check(s) red: %s\n' "${#failed[@]}" "${failed[*]}"
    printf '=====================================================================\n'
    exit 1
  fi
fi

printf '\n── gate zero (DAG §4 D-3) ──\n'
if [ ! -f "$GATE0_RECORD" ]; then
  printf '   BLOCKED  %s is missing entirely.\n' "$GATE0_RECORD"
elif grep -qE '^\*\*Status:[[:space:]]*PASS' "$GATE0_RECORD"; then
  printf '   PASS  gate zero recorded in %s\n' "$GATE0_RECORD"
  printf '\n=====================================================================\n'
  printf 'GATE GREEN — code verified and gate zero recorded.\n'
  printf '=====================================================================\n'
  exit 0
else
  printf '   BLOCKED  %s does not record a PASS.\n' "$GATE0_RECORD"
fi

printf '\n=====================================================================\n'
printf 'CODE IS GREEN. GATE IS BLOCKED ON GATE ZERO.\n'
printf '\n'
printf 'Every code check passed. What is missing is what this repo cannot\n'
printf 'verify for itself: that the substrate holding every read behaves the\n'
printf 'way the architecture assumes.\n'
printf '\n'
printf 'Gate zero already ran once and reopened [E9] by evidence: XTrace\n'
printf 'extracts payloads rather than storing them, so the pool cannot hand a\n'
printf 'read back. DAG D-7 made the relay the durable store in response.\n'
printf '\n'
printf 'That changed the question. `npm run gate0` still asks the OLD one --\n'
printf 'can a dropped read be recovered -- which nothing does any more, and\n'
printf 'it defines "retrievable" as the round-trip gate zero disproved. It\n'
printf 'cannot pass, and passing would not mean anything. Do not run it\n'
printf 'expecting to clear this.\n'
printf '\n'
printf 'To clear it, in order:\n'
printf '  P0.8  give the relay real durability (it is an in-memory Map today)\n'
printf '  G7    rewrite gate zero for D-7: relay survives restart losing\n'
printf '        nothing, deletion deletes by handle, induction yields a claim\n'
printf '\n'
printf 'Until then this exit 3 is correct. See DAG section 4, D-3 and D-7.\n'
printf '=====================================================================\n'
exit 3
