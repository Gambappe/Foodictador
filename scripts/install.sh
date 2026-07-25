#!/usr/bin/env bash
#
# Demo laptop install, macOS/Linux (DEPLOY.1).
#
#   bash scripts/install.sh [--operator]
#
# Installs dependencies, builds, links `confit` onto PATH, and writes an env template.
# Pass --operator on the ONE laptop that gets the Anthropic key.
#
# Deliberately does not write any secret. It writes a template with blanks and tells you
# what to fill in — an installer that takes keys as arguments puts them in shell history
# on a machine you are about to hand to someone else.

set -euo pipefail

operator=0
[ "${1:-}" = "--operator" ] && operator=1

cd "$(dirname "$0")/.."
root=$(pwd)

echo "── Confit demo laptop install ──────────────────────────────────────"
echo "   $root"
echo

if ! command -v node >/dev/null 2>&1; then
  echo "node is not installed. Install Node 20 or newer, then re-run:"
  echo "  macOS:  brew install node"
  exit 1
fi
major=$(node -p 'process.versions.node.split(".")[0]')
if [ "$major" -lt 20 ]; then
  echo "node $(node -v) is too old — this needs >= 20 (package.json engines)."
  exit 1
fi
echo "node $(node -v)"

echo
echo "Installing dependencies…"
npm ci

echo
echo "Building…"
npm run build

echo
echo "Linking 'confit' onto PATH…"
if npm link >/dev/null 2>&1; then
  echo "  confit -> $(command -v confit 2>/dev/null || echo '(restart your shell)')"
else
  echo "  npm link failed (needs sudo on some setups). Fallback, no install required:"
  echo "    alias confit='node $root/dist/src/cli/main.js'"
fi

env_file="$root/.confit.env"
if [ -f "$env_file" ]; then
  echo
  echo "$env_file already exists — leaving it alone."
else
  cat > "$env_file" <<EOF
# Confit demo environment. Fill in the blanks, then:  source .confit.env
# Never commit this file.

export RELAY_URL=
export RELAY_TOKEN=

# Both needed, on EVERY laptop. Without them a confession still pools and cohorts still
# cite, but the confessor's own memory tier is not written — and the consent copy
# promises it. See docs/demo-runbook.md.
export XTRACE_BASE_URL=https://api.production.xtrace.ai
export XTRACE_API_KEY=

export SETTLE_WINDOW_SECONDS=480
EOF
  if [ "$operator" -eq 1 ]; then
    cat >> "$env_file" <<'EOF'

# Operator laptop only. Without this the narrator degrades to L1 template copy and
# extraction to canned chips — fine on a diner laptop, wrong here.
export ANTHROPIC_API_KEY=
EOF
  fi
  chmod 600 "$env_file"
  echo
  echo "Wrote $env_file (mode 600)$([ "$operator" -eq 1 ] && echo ' — OPERATOR laptop')."
fi

echo
echo "────────────────────────────────────────────────────────────────────"
echo "Next:"
echo "  1. Fill in the blanks in .confit.env"
echo "  2. source .confit.env"
echo "  3. bash scripts/preflight.sh      # must exit 0"
echo
echo "Read docs/demo-runbook.md before demo day, not on it."
