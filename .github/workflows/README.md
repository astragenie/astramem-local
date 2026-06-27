# CI Workflows

## test.yml

Matrix: **ubuntu-latest × macos-latest × windows-latest** × **Node 20 × Node 22** = 6 cells.

Triggers: push/PR to `main`, `workflow_dispatch` (manual).

Steps per cell:
1. `actions/checkout@v4`
2. `actions/setup-node@v4` with `cache: npm`
3. `npm ci` — installs + rebuilds native modules (`better-sqlite3`, `sqlite-vec`)
4. `npm run build` — TypeScript compile
5. `npm test -- --testTimeout=60000` — vitest with 60 s per-test timeout

### Native module notes

`better-sqlite3` compiles a native `.node` addon via node-gyp during `npm ci`.
GitHub-hosted runners have the required build toolchain on all three OS images.

`sqlite-vec` ships prebuilt binaries for:
- `linux-x64` (ubuntu-latest)
- `darwin-arm64` / `darwin-x64` (macos-latest, arm runner)
- `win32-x64` (windows-latest)

If a prebuilt binary is missing or fails to load, the `openDb()` call in
`src/storage/db.ts` throws immediately and all tests that open a database will
fail with a descriptive error. This is intentional — we do **not** silently mark
cells green when the vector extension is unavailable.

### Expected failures

At time of writing (wave-4-B-ci tag), the 6-cell matrix is expected to be fully
green. If `sqlite-vec` releases a version without a Windows prebuilt, the
`windows-latest` cells will fail with `Error: Could not load sqlite-vec`. The fix
is to pin `sqlite-vec` to the last known good version in `package.json`.

### Live integration tests

Tests gated with `INTEGRATION_LIVE=1` are **not** run in CI. They require a
running Ollama or Azure endpoint and are run manually before releases.

### Timeout rationale

The default vitest timeout is 5 s. Spawn-based tests (`serve.test.ts`,
`ingest-e2e.test.ts`) start a child process and wait ~1.5 s for it to bind.
On Windows CI runners this can reach 10-20 s. `--testTimeout=60000` gives
ample headroom without being indefinite.

## lint.yml

Runs `tsc --noEmit` on ubuntu-latest + Node 22.

TypeScript is the only lint in this repo. The job is intentionally single-cell
for speed; the full build (`npm run build`) runs on all 6 cells in test.yml and
would catch the same errors.

Triggers: push/PR to `main`, `workflow_dispatch`.

## dependabot.yml

Weekly Dependabot PRs for:
- npm packages (grouped: production vs dev), up to 5 open PRs
- GitHub Actions (ungrouped, infrequent)
