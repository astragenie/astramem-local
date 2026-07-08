#!/usr/bin/env bash
# astramem-local installer (Linux/macOS)
#
# What this does:
#   1. Checks for Node.js >= 20 (astramem-local's `engines` requirement).
#   2. Installs astramem-local globally from npm.
#   3. Runs the `init` setup wizard (writes config.yaml + secrets.env, runs
#      migrations, provisions the OS service, runs doctor).
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/astragenie/astramemory-local/main/install.sh | bash
#   ./install.sh                      # run locally, same effect
#   ./install.sh --no-hook            # extra args are passed through to `init`
#
# Idempotent: re-running this script (e.g. to upgrade) just reinstalls the
# npm package at whatever version is current and re-runs `init`, which is
# itself safe to re-run against an existing config.
#
# Native deps: astramem-local depends on better-sqlite3-multiple-ciphers and
# @napi-rs/keyring. npm will use prebuilt binaries when available for your
# platform/arch, falling back to a from-source compile (needs a C/C++
# toolchain + python3) when no prebuild matches.
set -euo pipefail

PKG="astramem-local"
MIN_NODE_MAJOR=20

# --- 1. Node.js version check -------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  echo "error: node was not found on PATH." >&2
  echo "astramem-local requires Node.js >= ${MIN_NODE_MAJOR}." >&2
  case "$(uname -s)" in
    Darwin) echo "  Install with Homebrew:  brew install node@20" >&2 ;;
    Linux)  echo "  Install via nvm:        curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash && nvm install 20" >&2
            echo "  Or via NodeSource:      see https://github.com/nodesource/distributions" >&2 ;;
    *)      echo "  See https://nodejs.org/en/download for your platform." >&2 ;;
  esac
  exit 1
fi

node_major="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$node_major" -lt "$MIN_NODE_MAJOR" ]; then
  echo "error: found Node.js v$(node -p 'process.versions.node'), but astramem-local requires >= ${MIN_NODE_MAJOR}." >&2
  echo "  Upgrade with nvm:  nvm install 20 && nvm use 20" >&2
  echo "  Or download from:  https://nodejs.org/en/download" >&2
  exit 1
fi
echo "Node.js v$(node -p 'process.versions.node') OK (>= ${MIN_NODE_MAJOR} required)."

# --- 2. npm dependency check ---------------------------------------------------
if ! command -v npm >/dev/null 2>&1; then
  echo "error: npm was not found on PATH (usually ships with Node.js)." >&2
  exit 1
fi

# --- 3. Install / upgrade the package globally --------------------------------
echo "Installing ${PKG}@latest globally..."
npm install -g "${PKG}"

if ! command -v astramem-local >/dev/null 2>&1; then
  echo "error: install completed but 'astramem-local' is not on PATH." >&2
  echo "  Check npm's global bin dir is on PATH: npm config get prefix" >&2
  exit 1
fi
echo "Installed: $(astramem-local --version 2>/dev/null || echo "(version check unavailable)")"

# --- 4. Run the setup wizard ---------------------------------------------------
# `init` is interactive (it prompts for provider choice, etc.). When this
# script itself is being piped from curl (stdin is not a real terminal), the
# wizard would break mid-prompt with no way to answer — detect that and tell
# the user to run it themselves afterward instead of launching it blind.
if [ -t 0 ]; then
  echo "Running 'astramem-local init' ${*:+with args: $*} ..."
  exec astramem-local init "$@"
else
  echo
  echo "Install complete. Stdin isn't a terminal (this script was likely piped in),"
  echo "so the interactive setup wizard can't run here. Finish setup with:"
  echo
  echo "    astramem-local init"
  echo
fi
