# astramem-local AWS testbed

On-demand, throwaway Linux + macOS boxes on AWS to verify **installation** and
**performance** of `astramem-local`, then destroy. Built for the flow: spin →
test → destroy.

## What it checks

**install-smoke** (`remote/install-smoke.sh`) — for both `npm -g` and `bun -g`:
1. Both native addons (`better-sqlite3-multiple-ciphers`, `sqlite-vec`) **load
   under node** — the exact failure mode of the stale-global-install trap and
   devops#75.
2. Daemon serves `/health` against a persisted datadir, then **reopens** it.

`npm -g` is authoritative (must pass). `bun -g` is informational — bun skips
install scripts, so a failure there just documents "don't `bun -g`".

**perf** (`remote/perf.sh`) — builds the tree and runs `perf:baseline` (seed →
`bench.mts`, p50/p95/max per endpoint) with `ASTRA_MEMORY_MOCK_PROVIDERS=1` so
numbers reflect the DB/engine, not network.

## Prerequisites

- `aws` CLI authenticated to account `869719105703`, region `us-east-2` (creds
  with EC2 + SSM + S3 rights). `base64`, `curl`, `git` on your machine.
- No SSH needed — all box access is via **SSM Run Command** (the boxes inherit
  `profile-runner-aws`, same as the runner fleet).

## Quickstart

```bash
cd scripts/testbed

# --- Linux (cheap, ephemeral) ---
iid=$(./spin.sh linux | tail -1)     # launch + wait SSM + toolchain
./run-tests.sh "$iid" all            # install-smoke + perf
./destroy.sh --tag                   # terminate

# --- macOS (arm64) — 24h MINIMUM billing, see below ---
iid=$(./spin.sh mac | tail -1)       # allocates a mac2.metal Dedicated Host
./run-tests.sh "$iid" all
./destroy.sh --tag                   # terminate instance + release host
```

Suites: `./run-tests.sh <iid> install|perf|all [pkg-version] [git-ref]`
(defaults: `all latest origin/main`).

## ⚠ macOS cost + lifecycle

- macOS on AWS = **EC2 Mac**, which requires a **Dedicated Host** billed for a
  **24-hour minimum** (~**$15.60** for `mac2.metal` arm64). Releasing sooner is
  not refunded, and AWS **blocks host release until 24h** have elapsed — if
  `destroy.sh` can't release, it warns; re-run it after 24h to release the host.
- One arm64 VM covers ~all real users (native addons must match CPU arch; every
  Mac since 2020 is Apple Silicon). For Intel add `AWS_TESTBED_MAC_TYPE=mac1.metal`.
- Boot + SSM registration takes ~5–10 min on Mac. `spin.sh` waits up to ~12 min.

## Config overrides (env)

| Var | Default | Meaning |
|---|---|---|
| `AWS_TESTBED_REGION` | `us-east-2` | region |
| `AWS_TESTBED_AZ` | `us-east-2c` | AZ (mac host) |
| `AWS_TESTBED_SUBNET` / `_SG` | runner's | networking |
| `AWS_TESTBED_IAM_PROFILE` | `profile-runner-aws` | must grant SSM |
| `AWS_TESTBED_KEY` | `kp-runner-aws` | EC2 key pair |
| `AWS_TESTBED_LINUX_TYPE` | `c6a.2xlarge` | linux instance type |
| `AWS_TESTBED_MAC_TYPE` | `mac2.metal` | mac instance type |

All boxes + hosts are tagged `Project=astramem-testbed`; `destroy.sh --tag`
sweeps everything by that tag.

## Known limitations / follow-ups

- **Perf source delivery**: `astramem-local` is private and the box has no git
  creds, so `run-tests.sh` ships the tree as a `git archive` tarball to a private
  S3 bucket (`astramem-testbed-<acct>-<region>`, created if missing) and hands
  the box a 1-hour presigned URL. The ref must exist in your **local** repo.
- **Encryption path not exercised headless**: the smoke runs with encryption
  disabled to avoid the OS keychain (`getOrCreateKey`) on a headless box. The
  addon-load check still proves the SQLCipher driver resolves. A keychain-backed
  encrypted-reopen test is a follow-up.
- **Perf on hosted/shared hardware is noisy** — EC2 Mac bare-metal is dedicated
  (good for perf); linux `c6a` is shared (fine, but pin the type for comparisons).
- No CI wiring yet — this is manual/on-demand. Wiring `install-smoke.yml`
  (self-hosted linux, post-release + weekly) is the planned P1.
