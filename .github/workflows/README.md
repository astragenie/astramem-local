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
(`tests/providers/ollama-llm.test.ts`, `tests/providers/ollama-embed.test.ts`)
into an automatic run against a real Ollama, so provider drift (model
renames, API changes, embed-dim changes — see the nomic-embed-text-v2-moe
768-dim vs mxbai-embed-large 1024-dim incident behind hotfix v0.2.1) is
caught before release instead of by a user. Wiring only — no new tests were
authored for this lane.

`tests/e2e/plugin-flow.test.ts` also runs every nightly, but in **mock
mode** (no `INTEGRATION_LIVE`), as a separate step — see "2026-07-14: took
live generation off this lane" below for why.

**Triggers**: `schedule` (nightly, `17 9 * * *` UTC) + `workflow_dispatch`
only. Deliberately never `push` or `pull_request` — merges to `main` must
never depend on Ollama availability on the runner.

**Runner**: self-hosted fleet (`[self-hosted, astragenie, aws, docker]`),
same fleet as every other workflow in this repo. The "5 runners" org-level
inventory is actually 5 job slots on **one** shared, persistent Linux EC2
host — there is no `ollama` label, so the workflow probes `127.0.0.1:11434`
first and reuses a host-level Ollama singleton if one is already answering
(possibly shared with another concurrent job on the same box) rather than
starting a second instance and fighting over the port. Only if nothing
answers does it start its own container (`ollama/ollama:latest`); it never
installs anything system-wide, matching this host's documented aversion to
concurrent global-tooling installs (the `setup-bun` ETXTBSY flake noted
above in this same README).

**Models pulled**: listed once in the `OLLAMA_MODELS` env var at the top of
the workflow (single source of truth — also drives the cache key, so bumping
a model tag there automatically busts the cache):
- `mxbai-embed-large` — current production embed default. The embed live
  block still constructs its provider against this production default, so
  this half of the lane exercises what users actually run.
- `qwen2.5:0.5b` — **not** a production default, pinned deliberately (see
  "2026-07-14: took live generation off this lane" below). The LLM live
  block only calls `.health()` (GET `/api/tags`, no inference), which just
  needs some model present in the tags list, not the real (much heavier)
  production LLM default.

A stale pin on the embed side is worse than useless: the lane would burn CI
pulling a model no user has, while real embed-dim drift in the actual
default — the thing this half of the lane exists to catch — goes unnoticed.

**2026-07-14: took live generation off this lane (Option A / CPU-runner
fix).** The self-hosted runner this lane executes on has no GPU/VRAM, so
real Ollama generation runs CPU-only. `tests/e2e/plugin-flow.test.ts`'s live
mode drives the full ingest→distill→search pipeline through several real LLM
calls (compaction + extraction) — slow on CPU, and it timed out here (see
"Known risks" #2 below, which this resolves). That test was removed from the
`INTEGRATION_LIVE=ollama` subset and now runs as its own nightly step in
**mock mode** instead (deterministic, ~4s) — the pipeline wiring is still
exercised every night, just not through real generation. The production LLM
default's pin was correspondingly shrunk from `qwen3:8b` (4.7 GB, needed only
because the removed live pipeline test used to drive real generation with it)
down to `qwen2.5:0.5b`, since the one remaining LLM live test never runs
inference. Real-model generation-quality drift is the extraction-bench's job
on a GPU box now, not this lane's — this lane keeps the cheap drift checks
(API/tags shape, embed-dim) live and moves generation off the CPU runner.

**Caching**: `actions/cache` keyed on
`ollama-models-${OLLAMA_CACHE_VERSION}-${OLLAMA_MODELS}`, restoring into
`.ollama-models/` in the workspace, which is bind-mounted into the container
as `/root/.ollama`. Because the key is a direct function of the model list
and a manual version bump, any model-tag change or forced invalidation is
grep-verifiable in the workflow diff — no stale silent cache hits.

**Timing (measured, first-ever run, cold cache, pre-2026-07-14)**: 3m58s
total — checkout/install/build/cache-restore/probe ~30s, Docker image pull +
container start 68s, pulling all three models (~6 GB, back when `qwen3:8b`
was pinned) 92s, live test subset 36s, smoke suite 9s, issue automation +
cleanup ~3s. Predates both the model-pin shrink (`qwen3:8b` → `qwen2.5:0.5b`,
far less to pull) and the plugin-flow.test.ts move to mock mode covered
below — numbers will be lower post-fix but haven't been re-measured on a
real dispatched run yet. Comfortably under the ≤15 min target even at the
old, heavier weight.

**Known risks (documented, not fixed by this slice unless noted — confirmed
via a real dispatched run, not speculation)**:

1. ~~The live block in `tests/providers/ollama-embed.test.ts` hardcoded model
   name `nomic-embed-text-v2-moe`, natively 768-dim against a 1024-dim
   provider~~ — resolved; the live block now uses `mxbai-embed-large` (see
   `tests/providers/ollama-embed.test.ts` live integration block).
2. ~~`tests/e2e/plugin-flow.test.ts`'s live-mode pipeline test failed with a
   search-poll timeout: real LLM distillation across several pipeline
   stages, running on a CPU-only self-hosted runner (no GPU/VRAM), exceeded
   the poll window~~ — resolved 2026-07-14 (Option A / CPU-runner fix, see
   above): the test no longer runs in live mode on this lane at all. It runs
   in mock mode as its own nightly step instead, so pipeline wiring is still
   exercised nightly without depending on CPU-only generation speed.

A red run should now point at a genuine regression rather than a known,
CPU-inference-timing limitation — check the pinned issue body for the
specific failing test names before assuming otherwise.

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
