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
# Idempotent: re-running this script skips the npm reinstall when the
# installed global version already matches what npm resolves as latest
# (set FORCE=1 to always reinstall), then re-runs `init`, which is itself
# safe to re-run against an existing config.
#
# Root/sudo: running as root refuses to proceed (same FORCE=1 override) since
# it would install/start the service AS ROOT. Under `sudo` specifically,
# config/data written while running as root get chowned back to $SUDO_USER
# afterward.
#
# Native deps: astramem-local depends on better-sqlite3-multiple-ciphers and
# @napi-rs/keyring. npm will use prebuilt binaries when available for your
# platform/arch, falling back to a from-source compile (needs a C/C++
# toolchain + python3) when no prebuild matches.

# Re-exec under bash when invoked via `sh install.sh` / `curl | sh`. `set -o
# pipefail` below is a bash-only option; dash (the default /bin/sh on
# Debian/Ubuntu/Alpine) aborts on it with "Illegal option -o pipefail" before
# any install logic runs (FEAT-474, found during SLICE-425 — predates this
# FEAT, verified with `dash install.sh`). The shebang has always said bash;
# this makes `sh`/piped-into-`sh` invocations actually honor that instead of
# dying on line 1 of real logic.
if [ -z "${BASH_VERSION:-}" ]; then
  exec bash "$0" "$@"
fi

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
# Idempotent skip: if a global install already exists and its version matches
# what npm currently resolves as latest, skip the reinstall. FORCE=1 always
# reinstalls. If either version can't be determined (no existing install, or
# `npm view` fails, e.g. offline), fall through to installing so a real
# upgrade never false-positives as "already current".
installed_version=""
if command -v astramem-local >/dev/null 2>&1; then
  installed_version="$(astramem-local --version 2>/dev/null || true)"
fi
latest_version="$(npm view "${PKG}" version 2>/dev/null || true)"

if [ -n "${FORCE:-}" ]; then
  echo "FORCE is set — installing ${PKG}@latest globally..."
  npm install -g "${PKG}"
elif [ -n "$installed_version" ] && [ "$installed_version" = "$latest_version" ]; then
  echo "${PKG} ${installed_version} is already the latest version — skipping reinstall (set FORCE=1 to force)."
else
  echo "Installing ${PKG}@latest globally..."
  npm install -g "${PKG}"
fi

if ! command -v astramem-local >/dev/null 2>&1; then
  echo "error: install completed but 'astramem-local' is not on PATH." >&2
  echo "  Check npm's global bin dir is on PATH: npm config get prefix" >&2
  # AC-9: also print a copy-pasteable line instead of making the user derive
  # it themselves, targeted at the detected login shell's rc file.
  npm_bin_dir="$(npm config get prefix 2>/dev/null)/bin"
  case "${SHELL:-}" in
    */fish)
      rc_file="\$HOME/.config/fish/config.fish"
      echo "  Add it to PATH by pasting this (fish detected):" >&2
      echo "    echo 'set -gx PATH \"${npm_bin_dir}\" \$PATH' >> ${rc_file}" >&2
      ;;
    */zsh)
      echo "  Add it to PATH by pasting this (zsh detected):" >&2
      echo "    echo 'export PATH=\"${npm_bin_dir}:\$PATH\"' >> \$HOME/.zshrc" >&2
      ;;
    *)
      rc_file="\$HOME/.bashrc"
      [ -n "${SHELL:-}" ] || rc_file="\$HOME/.profile"
      echo "  Add it to PATH by pasting this:" >&2
      echo "    echo 'export PATH=\"${npm_bin_dir}:\$PATH\"' >> ${rc_file}" >&2
      ;;
  esac
  exit 1
fi
echo "Installed: $(astramem-local --version 2>/dev/null || echo "(version check unavailable)")"

# --- 3b. Root / sudo guard -----------------------------------------------------
# AC-6: refuse to silently auto-start a root-owned daemon. `init` can install
# and start the OS service (systemd/launchd) — doing that as root is unusual
# for a per-user daemon and easy to do by accident via `curl | sudo bash`.
# Require the same FORCE=1 override already used for the reinstall skip above.
if [ "$(id -u)" -eq 0 ] && [ -z "${FORCE:-}" ]; then
  echo >&2
  echo "error: this installer is running as root." >&2
  echo "  Running 'astramem-local init' as root will install and start the" >&2
  echo "  astramem-local service AS ROOT, which is unusual for a per-user" >&2
  echo "  daemon and is not recommended." >&2
  echo "  Re-run as a normal user, or set FORCE=1 to proceed anyway." >&2
  exit 1
fi
if [ "$(id -u)" -eq 0 ]; then
  echo "warning: FORCE is set — proceeding to run 'astramem-local init' as root." >&2
fi

# AC-7: under `sudo` (root with $SUDO_USER set), config.yaml/secrets.env and
# the data dir get written while running as root — hand them back to the
# invoking user afterward so they can manage their own config without sudo.
# Mirrors defaultConfigDir()/defaultDataDir() (src/config/datadir.ts) for the
# macOS/Linux targets this script covers (Windows is out of scope).
chown_config_and_data_to_sudo_user() {
  config_dir="${XDG_CONFIG_HOME:-$HOME/.config}/astra-memory"
  data_dir="${XDG_DATA_HOME:-$HOME/.local/share}/astra-memory"
  if [ "$(uname -s)" = "Darwin" ]; then
    config_dir="$HOME/Library/Application Support/astra-memory"
    data_dir="$config_dir"
  fi
  echo "Restoring ownership of astramem-local config/data to ${SUDO_USER}..."
  for dir in "$config_dir" "$data_dir"; do
    if [ -e "$dir" ]; then
      chown -R "${SUDO_USER}" "$dir" 2>/dev/null || echo "warning: could not chown $dir back to ${SUDO_USER}" >&2
    fi
  done
}

# Dispatches to `astramem-local init`. Normally this replaces the shell via
# `exec` (today's behavior, unchanged — AC-10). Under sudo it runs in the
# foreground instead so AC-7's chown-back can run afterward; `exec` would
# replace this process and nothing after it would ever execute.
run_init() {
  if [ -n "${SUDO_USER:-}" ] && [ "$(id -u)" -eq 0 ]; then
    astramem_init_status=0
    astramem-local init "$@" || astramem_init_status=$?
    chown_config_and_data_to_sudo_user
    exit "$astramem_init_status"
  else
    exec astramem-local init "$@"
  fi
}

# --- 4. Run the setup wizard ---------------------------------------------------
# `init` is interactive (it prompts for provider choice, etc.). When this
# script itself is being piped from curl (stdin is not a real terminal), the
# wizard would otherwise break mid-prompt with no way to answer. Re-attach
# /dev/tty when one exists so the prompts still work; if there's no
# controlling terminal at all (CI, containers), fall back to telling the
# user to run it themselves afterward instead of hanging or erroring out.
#
# The reattach probe below deliberately runs `exec < /dev/tty` inside a
# subshell rather than bare in the `if` condition. `exec` is a POSIX special
# builtin, and dash (unlike bash) terminates the whole shell on a special
# builtin's redirection error even inside an `if` test — so a bare
# `exec < /dev/tty` here would kill `sh install.sh` outright on a no-tty host
# (CI, containers) instead of falling back. Wrapping it in `( )` confines
# that failure to the subshell; only the real `exec < /dev/tty` below (run
# once the subshell proved it's safe) touches this shell's own stdin.
if [ -t 0 ]; then
  echo "Running 'astramem-local init' ${*:+with args: $*} ..."
  run_init "$@"
fi

echo
echo "Stdin isn't a terminal (this script was likely piped in, e.g. curl | bash)."

if [ -e /dev/tty ] && (exec < /dev/tty) 2>/dev/null; then
  exec < /dev/tty
  echo "Re-attached to /dev/tty — running 'astramem-local init' ${*:+with args: $*} ..."
  run_init "$@"
fi

echo "No controlling terminal (/dev/tty) is available (e.g. CI or a container),"
echo "so the interactive setup wizard can't run here. Finish setup with:"
echo
echo "    astramem-local init"
echo
