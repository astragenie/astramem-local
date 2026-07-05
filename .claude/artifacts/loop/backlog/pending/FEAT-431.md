---
id: FEAT-431
status: pending
priority: null
category: platform
target_release: null
created: 2026-07-05
depends_on: []
slices: []
derived_from: null
tags: [concern:ci, concern:testing]
autonomous_safe: null
triage_notes: "CI/test flake hardening (test-automator dispatch, worktree wt-ciflake, branch feat/HARD-ci-flake). Two recurring flake classes root-caused and fixed in test/harness code only — no product src changed. See commit(s) on feat/HARD-ci-flake."
---

# FEAT-431: CI flake hardening — ingest-e2e health-poll budget + native cold-import timeouts

## Problem — two recurring flake classes on the self-hosted runner

**(A) `tests/integration/ingest-e2e.test.ts` intermittent failure (~1 file/7
tests, ~4x recently, passes on re-run).**

Root cause: the file's own `waitForHealth()` poll helper hardcoded
`maxMs = 5_000`, called from a `beforeAll` hook whose own vitest
`hookTimeout` was `20_000ms` — wasting 15s of already-declared headroom.
Under a full-suite run (every spawned-daemon test file — e2e/plugin-flow,
smoke/*, integration/embed-dim-e2e, this file — scheduled across the vitest
worker pool concurrently), `spawn()` + port-bind latency for this daemon
occasionally exceeded 5s even though the daemon itself boots fine and port
19100 is not shared with any other suite. Every other spawned-daemon test in
the repo already budgets far more headroom for this exact contention
(`tests/cli/serve.test.ts`: 25_000ms poll / 30_000ms hook;
`tests/smoke/helpers/daemon.ts` `pollUntil`: 8_000-30_000ms) — this file was
the one outlier with an internal deadline far tighter than its own hook
budget. Confirmed NOT a product bug: the CI workflow's `--testTimeout=60000`
flag does not touch this hardcoded internal `maxMs` argument, which is why
the flake persisted despite that global bump.

Reproduced locally: `bunx vitest run` (full suite, no file filter) failed
with `Daemon at http://127.0.0.1:19100 did not respond to /health within
5000ms`.

Fix: bumped the hardcoded internal poll budget (default 18_000ms; call site
passes 20_000ms) and the hook timeout (20_000ms -> 25_000ms, 5s margin for
spawn overhead) so the poll actually uses the headroom the hook already
declared. Verified stable: 3x isolated reruns green, plus 3x full-suite
(`bunx vitest run`, 131 files / 1288 tests) back-to-back green, plus 4x
combined `tests/integration/ + tests/e2e/ + tests/smoke/` stress runs green.

**(B) cold-import timeout flakes** — `tests/config/migrate-dirs.test.ts`,
`tests/security/cipher-spike.test.ts`, `tests/capture/codex.test.ts`
(session-scan + e2e cases), and (discovered during full-suite repeated-run
verification of this same class) `tests/pipeline/handlers/distill-events.test.ts`'s
e2e-ish case.

Root cause: two distinct cold-start costs, both landing inside a default
5000ms `testTimeout` with no per-file override:

1. Native-addon cold load — `openDb()` (`src/storage/db.ts`) does
   `new Database(path)` via `better-sqlite3-multiple-ciphers` (a native
   addon distinct from vanilla better-sqlite3) then `sqliteVec.load(db)`.
   The FIRST such call in a process pays real, disk/AV-contention-sensitive
   dlopen/page-fault cost. `cipher-spike.test.ts` drives this directly;
   `codex.test.ts`'s e2e case and `distill-events.test.ts`'s e2e-ish case
   call `openDb()` + `buildApp()` inside the timed `it()` body.
2. Vite/esbuild transform-cache cold spike — `migrate-dirs.test.ts` calls
   `vi.resetModules()` in `beforeEach` then dynamically re-`import()`s the
   module under test per test. `resetModules()` clears Vitest's module-
   INSTANCE registry but not Vite's transform cache; the FIRST transform of
   a file in a worker can spike unpredictably. Reproduced locally: an
   isolated 5-run loop of just this file saw one run balloon to 13.38s
   wall-clock ("transform 12.09s") against ~1.5-2.2s for the other four.

Fix (three-part, deliberately NOT a global testTimeout bump):
- `tests/setup/native-warmup.globalsetup.ts` (wired via
  `vitest.config.ts` `test.globalSetup`) — opens+closes an in-memory DB once,
  up front, in vitest's untimed global-setup phase, pre-warming the OS page
  cache for the native addons before any test/hook timeout starts ticking.
- A hoisted, untimed, collection-time warm import of the real (unmocked)
  `migrate-dirs.js` module in `migrate-dirs.test.ts`, pre-populating the
  transform cache before the per-test `resetModules()` cycle begins.
- A per-FILE `vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 })` in
  each of the four affected files, as belt-and-suspenders for residual
  environmental jitter (e.g. antivirus/EDR scanning) neither of the above can
  fully absorb — scoped to just these files, the global vitest config and CI
  `--testTimeout` flag are untouched.

Verified stable: 3x isolated reruns of each affected file green, plus the
same 3x full-suite + 4x combined-stress runs above (which exercise all four
files) green throughout.

## Acceptance
- Both flake classes reproduced with evidence before the fix (see PR/commit
  description for pasted runner output).
- `bun run build` clean.
- Full suite green; previously-flaky files green on 3x isolated reruns AND
  the full suite green on 3x back-to-back runs post-fix.
- No product `src/` files changed — test/harness/config only.

## Refs
- Branch: `feat/HARD-ci-flake`, worktree `wt-ciflake`.
- Files: `tests/integration/ingest-e2e.test.ts`,
  `tests/config/migrate-dirs.test.ts`, `tests/security/cipher-spike.test.ts`,
  `tests/capture/codex.test.ts`, `tests/pipeline/handlers/distill-events.test.ts`,
  `tests/setup/native-warmup.globalsetup.ts` (new), `vitest.config.ts`.
