#!/usr/bin/env bash
# Runs ON the box via SSM. Verifies a FRESH GLOBAL install of astramem-local
# actually works end-to-end, for both npm-global and bun-global:
#   1) both native addons (better-sqlite3-multiple-ciphers, sqlite-vec) LOAD
#      under node -- the exact failure mode of the stale-global-install trap
#      and devops#75.
#   2) the daemon serves /health against a persisted datadir, then REOPENS the
#      same datadir on a second start (catches driver/reopen regressions).
#
# npm-global is AUTHORITATIVE (its install script fetches the prebuilt, so it
# must pass -> non-zero exit on failure). bun-global is INFORMATIONAL: bun skips
# install scripts, so a failure here documents the "don't bun -g" trap without
# failing the run.
#
# Arg1: package version (default: latest).
set -uo pipefail
VER="${1:-latest}"
export PATH="/usr/local/node20/bin:/usr/local/bin:/var/root/.bun/bin:/root/.bun/bin:$HOME/.bun/bin:$PATH"
echo "== install-smoke astramem-local@$VER on $(uname -s) =="
node --version >/dev/null 2>&1 || { echo "FATAL: node missing"; exit 1; }

start_health() {  # $1=bin $2=port ; echoes daemon pid
  local bin="$1" port="$2" cfg data
  cfg="$(mktemp -d)"; data="$(mktemp -d)"; mkdir -p "$cfg/astra-memory"
  printf 'security:\n  encryption:\n    enabled: false\n' > "$cfg/astra-memory/config.yaml"
  XDG_CONFIG_HOME="$cfg" XDG_DATA_HOME="$data" ASTRA_MEMORY_DATADIR="$DATADIR" \
    ASTRA_MEMORY_TOKEN="smoke-tok" ASTRA_MEMORY_MOCK_PROVIDERS=1 \
    node "$bin" serve --port "$port" >"$DLOG" 2>&1 &
  echo $!
}

wait_health() {  # $1=pid $2=port ; returns 0 if /health 200 before pid dies
  local pid="$1" port="$2" i
  for i in $(seq 1 60); do
    curl -fsS "http://127.0.0.1:$port/health" >/dev/null 2>&1 && return 0
    kill -0 "$pid" 2>/dev/null || return 1
    sleep 0.5
  done
  return 1
}

smoke_one() {  # $1 = npm|bun ; returns 0 on pass
  local mgr="$1" pfx root bin rc=0 pid
  echo; echo "### install path: $mgr global ###"
  pfx="$(mktemp -d)"
  if [ "$mgr" = npm ]; then
    if ! npm install -g --prefix "$pfx" "astramem-local@$VER" >/tmp/${mgr}-inst.log 2>&1; then
      echo "[$mgr] INSTALL FAILED"; tail -30 /tmp/${mgr}-inst.log; return 1
    fi
    root="$pfx/lib/node_modules"; bin="$pfx/bin/astramem-local"
  else
    if ! BUN_INSTALL="$pfx" bun add -g "astramem-local@$VER" >/tmp/${mgr}-inst.log 2>&1; then
      echo "[$mgr] INSTALL FAILED"; tail -30 /tmp/${mgr}-inst.log; return 1
    fi
    root="$pfx/install/global/node_modules"; bin="$pfx/bin/astramem-local"
  fi
  echo "[$mgr] installed (root=$root)"

  # 1) addon load under node
  if node -e "for(const m of ['better-sqlite3-multiple-ciphers','sqlite-vec']){require(require.resolve(m,{paths:['$root/astramem-local','$root']}))} console.log('[$mgr] native addons load OK')"; then :; else
    echo "[$mgr] ADDON LOAD FAILED — native binaries missing/broken in the global install"; rc=1
  fi

  # 2) daemon /health, fresh datadir then reopen
  DATADIR="$(mktemp -d)/dd"; DLOG="/tmp/${mgr}-daemon.log"
  pid=$(start_health "$bin" 19191)
  if wait_health "$pid" 19191; then echo "[$mgr] daemon /health OK (fresh datadir)"; else echo "[$mgr] daemon /health FAILED (fresh)"; tail -25 "$DLOG"; rc=1; fi
  kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null
  pid=$(start_health "$bin" 19191)
  if wait_health "$pid" 19191; then echo "[$mgr] daemon /health OK (reopened datadir)"; else echo "[$mgr] daemon /health FAILED (reopen)"; tail -25 "$DLOG"; rc=1; fi
  kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null

  [ "$rc" = 0 ] && echo "[$mgr] SMOKE PASS" || echo "[$mgr] SMOKE FAIL"
  return $rc
}

overall=0
smoke_one npm || overall=1          # authoritative
smoke_one bun || echo "(bun-global failure is expected/known — informational, not failing the run)"

echo
[ "$overall" = 0 ] && echo "INSTALL-SMOKE: PASS (npm-global authoritative)" \
                    || echo "INSTALL-SMOKE: FAIL (npm-global broke)"
exit $overall
