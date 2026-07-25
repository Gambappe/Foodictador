# Demo laptop install, Windows (DEPLOY.1).
#
#   powershell -ExecutionPolicy Bypass -File scripts\install.ps1 [-Operator]
#
# Installs dependencies, builds, links `confit`, and writes an env template.
# Pass -Operator on the ONE laptop that gets the Anthropic key.
#
# Deliberately writes no secret — a template with blanks, so no key lands in shell
# history on a machine you are about to hand to someone else.

param([switch]$Operator)

$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')
$root = (Get-Location).Path

Write-Host "-- Confit demo laptop install ------------------------------------"
Write-Host "   $root"
Write-Host ""

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "node is not installed. Install Node 20 or newer, then re-run:"
  Write-Host "  winget install OpenJS.NodeJS.LTS"
  exit 1
}
$major = [int](node -p 'process.versions.node.split(".")[0]')
if ($major -lt 20) {
  Write-Host "node $(node -v) is too old -- this needs >= 20 (package.json engines)."
  exit 1
}
Write-Host "node $(node -v)"

Write-Host ""
Write-Host "Installing dependencies..."
npm ci
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host ""
Write-Host "Building..."
npm run build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host ""
Write-Host "Linking 'confit'..."
npm link 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) {
  Write-Host "  npm link failed. Fallback, no install required:"
  Write-Host "    function confit { node `"$root\dist\src\cli\main.js`" @args }"
} else {
  Write-Host "  confit linked (restart your shell if it is not on PATH yet)"
}

# A .ps1 you dot-source, because PowerShell has no `source` for shell syntax.
$envFile = Join-Path $root '.confit.env.ps1'
if (Test-Path $envFile) {
  Write-Host ""
  Write-Host "$envFile already exists -- leaving it alone."
} else {
  $lines = @(
    '# Confit demo environment. Fill in the blanks, then:  . .\.confit.env.ps1'
    '# Never commit this file.'
    ''
    '$env:RELAY_URL = ""'
    '$env:RELAY_TOKEN = ""'
    ''
    '# Both needed, on EVERY laptop. Without them a confession still pools and cohorts'
    '# still cite, but the confessor''s own memory tier is not written -- and the consent'
    '# copy promises it. See docs/demo-runbook.md.'
    '$env:XTRACE_BASE_URL = "https://api.production.xtrace.ai"'
    '$env:XTRACE_API_KEY = ""'
    ''
    '$env:SETTLE_WINDOW_SECONDS = "480"'
  )
  if ($Operator) {
    $lines += @(
      ''
      '# Operator laptop only. Without this the narrator degrades to L1 template copy'
      '# and extraction to canned chips -- fine on a diner laptop, wrong here.'
      '$env:ANTHROPIC_API_KEY = ""'
    )
  }
  $lines | Set-Content -Path $envFile -Encoding UTF8
  Write-Host ""
  $tag = if ($Operator) { " -- OPERATOR laptop" } else { "" }
  Write-Host "Wrote $envFile$tag."
}

Write-Host ""
Write-Host "------------------------------------------------------------------"
Write-Host "Next:"
Write-Host "  1. Fill in the blanks in .confit.env.ps1"
Write-Host "  2. . .\.confit.env.ps1"
Write-Host "  3. npm run preflight              # must exit 0"
Write-Host ""
Write-Host "Read docs/demo-runbook.md before demo day, not on it."
