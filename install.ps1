# astramem-local installer (Windows / PowerShell 5.1+ and 7+)
#
# What this does:
#   1. Checks for Node.js >= 20 (astramem-local's `engines` requirement).
#   2. Installs astramem-local globally from npm.
#   3. Runs the `init` setup wizard (writes config.yaml + secrets.env, runs
#      migrations, provisions the OS service, runs doctor).
#
# Usage:
#   irm https://raw.githubusercontent.com/astragenie/astramemory-local/main/install.ps1 | iex
#   .\install.ps1                      # run locally, same effect
#   .\install.ps1 -InitArgs '--no-hook'  # extra args are passed through to `init`
#
# Idempotent: re-running this script (e.g. to upgrade) just reinstalls the
# npm package at whatever version is current and re-runs `init`, which is
# itself safe to re-run against an existing config.
#
# Native deps: astramem-local depends on better-sqlite3-multiple-ciphers and
# @napi-rs/keyring. npm will use prebuilt binaries when available for your
# platform/arch, falling back to a from-source compile (needs Visual Studio
# Build Tools + python3) when no prebuild matches.

param(
    [string]$InitArgs = ''
)

$ErrorActionPreference = 'Stop'
$Pkg = 'astramem-local'
$MinNodeMajor = 20

# --- 1. Node.js version check -------------------------------------------------
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    Write-Host "error: node was not found on PATH." -ForegroundColor Red
    Write-Host "astramem-local requires Node.js >= $MinNodeMajor."
    Write-Host "  Install with winget:  winget install OpenJS.NodeJS.LTS"
    Write-Host "  Or download from:     https://nodejs.org/en/download"
    exit 1
}

$nodeVersionRaw = (& node -p 'process.versions.node').Trim()
$nodeMajor = [int]($nodeVersionRaw.Split('.')[0])
if ($nodeMajor -lt $MinNodeMajor) {
    Write-Host "error: found Node.js v$nodeVersionRaw, but astramem-local requires >= $MinNodeMajor." -ForegroundColor Red
    Write-Host "  Upgrade with winget:  winget upgrade OpenJS.NodeJS.LTS"
    Write-Host "  Or download from:     https://nodejs.org/en/download"
    exit 1
}
Write-Host "Node.js v$nodeVersionRaw OK (>= $MinNodeMajor required)."

# --- 2. npm dependency check ---------------------------------------------------
$npmCmd = Get-Command npm -ErrorAction SilentlyContinue
if (-not $npmCmd) {
    Write-Host "error: npm was not found on PATH (usually ships with Node.js)." -ForegroundColor Red
    exit 1
}

# --- 3. Install / upgrade the package globally --------------------------------
Write-Host "Installing $Pkg@latest globally..."
& npm install -g $Pkg
if ($LASTEXITCODE -ne 0) {
    Write-Host "error: npm install -g $Pkg failed (exit $LASTEXITCODE)." -ForegroundColor Red
    exit $LASTEXITCODE
}

$astramemCmd = Get-Command astramem-local -ErrorAction SilentlyContinue
if (-not $astramemCmd) {
    Write-Host "error: install completed but 'astramem-local' is not on PATH." -ForegroundColor Red
    Write-Host "  Check npm's global bin dir (npm config get prefix) is on PATH, then open a new shell."
    exit 1
}
$version = & astramem-local --version 2>$null
Write-Host "Installed: $version"

# --- 4. Run the setup wizard ---------------------------------------------------
# `init` is interactive (it prompts for provider choice, etc.). When this
# script is piped in via `irm ... | iex` with stdin redirected (e.g. a CI
# runner or a non-interactive terminal), the wizard would break mid-prompt
# with no way to answer -- detect that and tell the user to run it themselves
# afterward instead of launching it blind.
if ([Console]::IsInputRedirected) {
    Write-Host ""
    Write-Host "Install complete. This session's input is redirected, so the interactive"
    Write-Host "setup wizard can't run here. Finish setup with:"
    Write-Host ""
    Write-Host "    astramem-local init"
    Write-Host ""
} else {
    Write-Host "Running 'astramem-local init' $InitArgs ..."
    if ($InitArgs) {
        & astramem-local init $InitArgs.Split(' ')
    } else {
        & astramem-local init
    }
}
