# CI Workflows

All jobs run on the self-hosted fleet (`[self-hosted, astragenie, aws]`) — fleet
policy is **no GitHub-hosted runners**. Bun is baked into the runner image at
`/usr/local/bin` (see astragenie/devops#64); workflows do **not** use
`oven-sh/setup-bun` — its cache-restore/exec race caused intermittent
`spawn ETXTBSY` failures on the shared runner host.

## test.yml

Single-cell: self-hosted linux × Bun 1.3.

Triggers: push/PR to `main`, `workflow_dispatch` (manual).

Steps:
1. `actions/checkout@v4`
2. `bun install --frozen-lockfile` — installs + rebuilds native modules
   (`better-sqlite3` via node-gyp, `sqlite-vec` prebuilt `linux-x64`)
3. `bun run build` — TypeScript compile
4. `bun run test` — vitest with 60 s per-test timeout

### Native module notes

If a prebuilt binary is missing or fails to load, the `openDb()` call in
`src/storage/db.ts` throws immediately and all tests that open a database will
fail with a descriptive error. This is intentional — we do **not** silently mark
cells green when the vector extension is unavailable.

### Live integration tests

Tests gated with `INTEGRATION_LIVE=1` are **not** run in CI. They require a
running Ollama or Azure endpoint and are run manually before releases.

### Timeout rationale

The default vitest timeout is 5 s. Spawn-based tests (`serve.test.ts`,
`ingest-e2e.test.ts`) start a child process and wait ~1.5 s for it to bind.
`--testTimeout=60000` gives ample headroom without being indefinite.

## lint.yml

Runs `bunx tsc --noEmit` plus `node contracts/validate.mjs` on the self-hosted
runner. TypeScript is the only lint in this repo; the job is intentionally
single-cell for speed.

Triggers: push/PR to `main`, `workflow_dispatch`.

## audit.yml

`bun audit --audit-level=high` on push/PR to `main`.

## publish.yml

npm publish with provenance on `v*` tag push. Verifies tag matches
`package.json` version first (same gate as version-tag-parity.yml).

## version-tag-parity.yml

Guards that release tags match `package.json`.

## cross-repo-roundtrip.yml (FEAT-411)

Checks out this repo, builds it, then checks out the PUBLIC astramem-plugin
repo (no token needed) and runs its
`tests/e2e/plugin-daemon-roundtrip.test.ts` against the freshly built daemon
via `ASTRAMEM_LOCAL_DIST_PATH=<daemon checkout>`. This is the primary CI gate
for the plugin<->daemon wire contract. Lands with PR #43; required check on
`main`.

Triggers: push/PR to `main`, `workflow_dispatch`.

## cross-repo-roundtrip.yml (FEAT-411)

Checks out this repo, builds it, then checks out the PUBLIC astramem-plugin
repo (no token needed) and runs its
`tests/e2e/plugin-daemon-roundtrip.test.ts` against the freshly built daemon
via `ASTRAMEM_LOCAL_DIST_PATH=<daemon checkout>`. This is the primary CI gate
for the plugin<->daemon wire contract — a regression here (e.g. the
fused-score-over-1 bug fixed in cedc8a9) fails the job red and blocks merge.

Job name `cross-repo-roundtrip` is the candidate for a required branch
protection check on this repo.

The mirror job in astramem-plugin's own workflows checks out this (private)
repo instead and is secret-gated (`ASTRAMEM_LOCAL_TOKEN`) — see that repo's
workflow file for operator setup steps. It is a secondary/best-effort check;
this repo's job is the one that should be required.

Triggers: push/PR to `main`, `workflow_dispatch`.

## dependabot.yml

Weekly Dependabot PRs for:
- npm packages (grouped: production vs dev), up to 5 open PRs
- GitHub Actions (ungrouped, infrequent)
