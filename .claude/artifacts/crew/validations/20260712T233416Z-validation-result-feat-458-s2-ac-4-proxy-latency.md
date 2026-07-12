---
status: PASS
---

# Validation Result — FEAT-458 S2-AC-4 (proxy overhead p50 < 10ms)

Worktree: `C:\work\mega\astramemory-local-worktrees\w458core`, branch
`feat/feat-458-s2-proxy-core-v2`. This is the Wave 2 join: `feat/feat-458-s1-proxy-bench`
(the latency harness, `scripts/eval/proxy-bench/**`) was merged into this branch (merge
commit, disjoint files, no conflicts), producing the first commit where both the proxy under
test (`src/proxy/server.ts` + `src/cli/proxy.ts`) and the bench harness that measures it
coexist. Prior review (`.claude/artifacts/crew/reviews/20260712T-review-result-feat-458-s2.md`)
flagged S2-AC-4 as **structurally unmeetable** at that time because S1 hadn't produced a bench
harness yet — no latency evidence existed anywhere. This artifact closes that gap.

## Assertion under test

S2-AC-4: proxy-added latency, p50, must be **< 10ms** versus talking to the upstream directly.

## Build

```
bun install    # 256 installs across 302 packages, no changes (already current)
bun run build  # tsc -p . — clean, dist/cli/index.js produced with proxy serve support
```

## Command

```
bun scripts/eval/proxy-bench/bench.mts --requests 500 --warmup 50 \
  --out .eval-data/proxy-bench/runs/feat-458-s2-ac-4.json
```
500 measured requests + 50 discarded warmup iterations per distribution, concurrency=1
(sequential — the harness's README notes this is intentional: S1-AC-3/S2-AC-4 wants
per-request latency, not queueing delay under concurrent load). `--proxy-entry` was not
needed — `resolveProxyEntry` auto-detected `dist/cli/index.js` now that both branches are on
one branch, exactly as the harness's own README predicted for post-merge Wave 2. Synthetic
loopback upstream stub only (`node:http`, canned 1024-byte body, no delay) — no real LLM
provider, no network egress, per the HARD CONSTRAINTS on this task.

## Run 1 — raw results

```
Upstream stub: bodySize=1024 delayMs=0
Requests: 500 (+50 warmup), concurrency=1
Proxy entry: C:\work\mega\astramemory-local-worktrees\w458core\dist\cli\index.js

  direct:  p50=0.105ms p95=0.201ms p99=0.314ms mean=0.125ms (n=500)
  proxied: p50=0.451ms p95=0.744ms p99=1.694ms mean=0.493ms (n=500)
  overhead (proxied - direct): p50=0.346ms p95=0.544ms p99=1.380ms mean=0.369ms

assessment: { "threshold_ms": 10, "p50_overhead_ms": 0.34609999999997854, "pass": true }
```
Full JSON (including raw per-request samples): `.eval-data/proxy-bench/runs/feat-458-s2-ac-4.json`

## Run 2 — independent repeat, to rule out a fluke

Ran a second time end-to-end (fresh proxy process, fresh port) rather than trusting one
sample:
```
  direct:  p50=0.166ms p95=0.255ms p99=1.301ms mean=0.193ms (n=500)
  proxied: p50=0.502ms p95=1.142ms p99=2.490ms mean=0.590ms (n=500)
  overhead (proxied - direct): p50=0.337ms p95=0.888ms p99=1.189ms mean=0.397ms
```
Full JSON: `.eval-data/proxy-bench/runs/feat-458-s2-ac-4-run2.json`

p50 overhead across both runs: **0.346ms and 0.337ms** — consistent to within 0.01ms, ~29x
margin under the 10ms threshold. Not a 10-request fluke; two independent 500-request runs
agree.

## Machine load — honesty check

This box was **not idle** during either run. `tasklist` immediately before the bench showed
Ollama (`ollama app.exe` + `ollama.exe`) running plus ~30 `node.exe` processes, including a
~1.29GB-resident process consistent with the operator's live daemon and several other
sizeable ones (likely sibling agent sessions / eval tooling). No processes were touched or
killed to produce a cleaner number — per this task's HARD CONSTRAINTS, only PIDs this task
itself spawned (the bench's own upstream-stub server and the proxy-under-test subprocess)
were ever managed, and both were torn down cleanly by the harness after each run. Any
scheduler contention from that concurrent load can only **inflate** the measured overhead,
never deflate it — so a PASS measured under real contention is a conservative PASS, not an
optimistic one measured on an artificially quiet machine.

## Verdict

**PASS.** p50 proxy overhead is 0.34–0.35ms against a 10ms threshold, reproduced across two
independent 500-request runs, measured under genuine concurrent machine load (conservative
direction). S2-AC-4 is satisfied.

## Test suites (full relevant set, post-merge)

```
bunx vitest run tests/proxy tests/config tests/doctor
  Test Files  29 passed (29)
  Tests       227 passed (227)

bunx vitest run scripts/eval/proxy-bench
  Test Files  4 passed (4)
  Tests       33 passed (33)
```
The bench harness's own `bench.test.ts` end-to-end `describe` block (previously `skipIf`'d
because `dist/cli/index.js` didn't exist pre-merge) now runs for real against the built CLI
and passes — the harness's README explicitly flagged this as the signal that Wave 2 had
landed correctly.

`tsc -p tsconfig.tests.json` was not run as a gate — per this task's brief, it carries ~40
pre-existing errors unrelated to FEAT-458 and is documented as not a gate for this work.

## What remains before this can merge to main

Per FEAT-471's rule, a conversational "PASS" from this validation pass does not clear the
review gate by itself. Outstanding before `feat/feat-458-s2-proxy-core-v2` merges to main:

1. A **fresh reviewer pass** on the joined branch (both halves together), with its own
   artifact written to `.claude/artifacts/crew/reviews/` — the existing S2 review
   (`20260712T-review-result-feat-458-s2.md`) predates this merge and explicitly named the
   AC-4 gap this artifact now closes, plus other findings (S1-AC-2 placement, disable→purge
   parity) that were out of this task's scope and need the reviewer's own re-check against
   the merged tree.
2. This validation artifact itself should be cited by that reviewer pass as closing AC-4
   specifically — it does not stand in for full-diff review.
3. No merge to main was performed by this task (explicitly out of scope per the HARD
   CONSTRAINTS) — `feat/feat-458-s2-proxy-core-v2` currently holds only local commits.
