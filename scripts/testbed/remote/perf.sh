#!/usr/bin/env bash
# Runs ON the box via SSM. Fetches the astramem-local tree (presigned S3 tarball
# passed by run-tests.sh), builds it, and runs the perf:baseline harness with
# mock providers so numbers reflect the DB/engine, not network latency.
#
# Arg1: presigned URL of a gzip tarball of the repo tree (git archive output).
set -uo pipefail
URL="${1:?perf.sh needs a presigned tarball URL}"
# SSM runs as root without HOME set; resolve it from passwd so set -u is safe.
export HOME="${HOME:-$(eval echo "~$(id -un)")}"
export PATH="/usr/local/node20/bin:/usr/local/bin:/var/root/.bun/bin:/root/.bun/bin:$HOME/.bun/bin:$PATH"
echo "== perf baseline on $(uname -s) ($(node -e 'process.stdout.write(process.arch)')) =="

work="$(mktemp -d)"; cd "$work" || exit 1
echo "[perf] downloading source tarball ..."
curl -fsSL "$URL" -o src.tgz
mkdir repo && tar -xzf src.tgz -C repo && cd repo || exit 1

echo "[perf] bun install + build ..."
NODE_ENV=development bun install --frozen-lockfile
bun run build

echo "[perf] seeding (sizes 1000,10000; mock providers) ..."
ASTRA_MEMORY_MOCK_PROVIDERS=1 bun scripts/perf/seed.mts --sizes 1000,10000

echo "[perf] benchmarking (100 iters, 5 warmup) ..."
ASTRA_MEMORY_MOCK_PROVIDERS=1 bun scripts/perf/bench.mts --sizes 1000,10000 --iterations 100 --warmup 5

echo "== perf done — p50/p95/max per endpoint above =="
