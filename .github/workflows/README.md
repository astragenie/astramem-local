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

## nightly-live.yml (FEAT-421 / SLICE-415)

Wires the EXISTING `INTEGRATION_LIVE=ollama` gated tests
(`tests/providers/ollama-llm.test.ts`, `tests/providers/ollama-embed.test.ts`,
`tests/e2e/plugin-flow.test.ts`) into an automatic run against a real Ollama,
so provider drift (model renames, API changes, embed-dim changes — see the
nomic-embed-text-v2-moe 768-dim vs mxbai-embed-large 1024-dim incident behind
hotfix v0.2.1) is caught before release instead of by a user. Wiring only —
no new tests were authored for this lane.

**Triggers**: `schedule` (nightly, `17 9 * * *` UTC) + `workflow_dispatch`
only. Deliberately never `push` or `pull_request` — merges to `main` must
never depend on Ollama availability on the runner.

**Runner**: self-hosted fleet (`[self-hosted, astragenie, aws, docker]`),
same fleet as every other workflow in this repo. Ollama runs inside a
container (`ollama/ollama:latest`) rather than a system-wide install, since
the runners are shared, persistent hosts.

**Models pulled**: listed once in the `OLLAMA_MODELS` env var at the top of
the workflow (single source of truth — also drives the cache key, so bumping
a model tag there automatically busts the cache):
- `mxbai-embed-large` — current production embed default
- `qwen2.5-coder:7b` — current production LLM default (compaction/extraction)
- `nomic-embed-text-v2-moe` — referenced explicitly by the live block in
  `ollama-embed.test.ts`; see the known-risk note below

**Caching**: `actions/cache` keyed on
`ollama-models-${OLLAMA_CACHE_VERSION}-${OLLAMA_MODELS}`, restoring into
`.ollama-models/` in the workspace, which is bind-mounted into the container
as `/root/.ollama`. Because the key is a direct function of the model list
and a manual version bump, any model-tag change or forced invalidation is
grep-verifiable in the workflow diff — no stale silent cache hits.

**Timing**: target ≤15 min warm (cache hit — model pull steps become no-ops
since `ollama pull` on an already-present blob just verifies the manifest).
Cold-start (first run, empty cache) pulls the `ollama/ollama` image plus
~6 GB of model blobs across the three models above; see the run-brief
artifact for this slice for the actual first-run timing measured on this
branch.

**Known risk (documented, not fixed by this slice)**: the live block in
`tests/providers/ollama-embed.test.ts` still hardcodes model name
`nomic-embed-text-v2-moe` from before the v0.2.1 hotfix. That model is
natively 768-dim; `OllamaEmbedProvider` expects 1024 regardless of the model
string passed in, so a real run of that specific test is expected to fail
with a dimension-mismatch error until someone updates the test's model
reference to `mxbai-embed-large`. This is a follow-up FEAT candidate, not
this slice's scope (touches test code, not CI wiring). A red run from
exactly this test is expected on the first several nightly runs — check the
pinned issue body for the specific failing test name before assuming a new
regression.

**Failure path**: a red run opens or updates a single pinned issue titled
`nightly-live: red` with the failing test names (via
`actions/github-script`, using the default `GITHUB_TOKEN` with the
`issues: write` permission declared in the workflow — no extra secret
needed). A green run closes it with a comment linking the passing run. The
job also exits non-zero on red (after the issue is updated) so the run
itself shows red in the Actions UI, not just green-with-a-side-issue.

**Triage owner**: whoever owns FEAT-421 / the `nightly-live` label area —
currently the daemon maintainer on rotation. Treat a red pinned issue as a
pre-release blocker investigation, not an ignorable nightly flake, per the
prior-incident evidence (hotfix v0.2.1) that motivated this lane.

## dependabot.yml

Weekly Dependabot PRs for:
- npm packages (grouped: production vs dev), up to 5 open PRs
- GitHub Actions (ungrouped, infrequent)
