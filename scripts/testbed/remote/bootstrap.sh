#!/usr/bin/env bash
# Runs ON the testbed box via SSM (as root). Installs node 20, bun, git,
# build tools. Idempotent-ish; safe to re-run.
#
# macOS note: SSM runs as root, and Homebrew refuses to run as root, so on
# Darwin we install node from the official arm64 tarball instead of brew.
set -uo pipefail
NODE_VER="20.18.1"
# SSM runs as root without HOME set; the bun installer writes to $HOME/.bun and
# set -u would abort on an unbound HOME. Resolve it from passwd.
export HOME="${HOME:-$(eval echo "~$(id -un)")}"
uname_s="$(uname -s)"
echo "[bootstrap] OS=$uname_s"

if [ "$uname_s" = "Linux" ]; then
  export DEBIAN_FRONTEND=noninteractive
  sudo apt-get update -y
  sudo apt-get install -y curl git build-essential python3 ca-certificates unzip
  major="$(node -e 'process.stdout.write(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)"
  if [ "${major:-0}" -lt 20 ]; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
  fi

elif [ "$uname_s" = "Darwin" ]; then
  # Xcode CLT (git, compilers) ships with the Amazon macOS AMI.
  if ! command -v node >/dev/null 2>&1; then
    curl -fsSL "https://nodejs.org/dist/v$NODE_VER/node-v$NODE_VER-darwin-arm64.tar.gz" -o /tmp/node.tgz
    sudo mkdir -p /usr/local/node20
    sudo tar -xzf /tmp/node.tgz -C /usr/local/node20 --strip-components=1
    sudo ln -sf /usr/local/node20/bin/node /usr/local/bin/node
    sudo ln -sf /usr/local/node20/bin/npm  /usr/local/bin/npm
    sudo ln -sf /usr/local/node20/bin/npx  /usr/local/bin/npx
  fi
else
  echo "[bootstrap] unsupported OS $uname_s"; exit 1
fi

# Bun (both OSes) via the official installer; symlink into /usr/local/bin so
# later SSM steps (which also run as root) find it regardless of $HOME.
if ! command -v bun >/dev/null 2>&1; then
  curl -fsSL https://bun.sh/install | bash
fi
BUN_BIN=""
for c in "$HOME/.bun/bin/bun" /var/root/.bun/bin/bun /root/.bun/bin/bun; do
  [ -x "$c" ] && BUN_BIN="$c" && break
done
[ -n "$BUN_BIN" ] && sudo ln -sf "$BUN_BIN" /usr/local/bin/bun

export PATH="/usr/local/node20/bin:/usr/local/bin:$HOME/.bun/bin:$PATH"
echo "[bootstrap] versions:"
node --version 2>&1 || echo "node MISSING"
bun --version  2>&1 || echo "bun MISSING"
git --version  2>&1 || echo "git MISSING"
echo "[bootstrap] OK"
