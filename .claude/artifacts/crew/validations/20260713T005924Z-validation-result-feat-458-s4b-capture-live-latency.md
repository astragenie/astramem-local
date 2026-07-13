---
status: PASS
---

# Validation Result — FEAT-458 S4b (capture-live latency bench, p50 < 10ms)

Worktree: `C:\work\mega\astramemory-local-worktrees\w458s4b`, branch
`feat/feat-458-s4b-capture-bench` off `main` (main already has relay, capture fork, Anthropic
wire, timeout handling, doctor rows, and the S1 bench harness merged).

## Scope of this run

1. **Fixed a real defect in `computeOverhead`** (`scripts/eval/proxy-bench/lib/latency.ts`)
   flagged by the S2 review: it subtracted two independently-computed aggregate p50s
   (`proxied.p50 - direct.p50`) instead of the per-request-pair delta
   `docs/specs/FEAT-458-S1-design.md` §3.2 pins by name. Fixed before producing any new
   evidence, since the fix could change the number.
2. **Benched the proxy with `proxy.capture.enabled=true`** — the last unproven FEAT-458 AC.

## Job 1 — `computeOverhead` fix

**Before:** `p50: proxied.p50 - direct.p50` (and same for p95/p99/mean) — two series sorted
and percentiled independently, then subtracted.

**After:** builds the per-index delta array `proxied.raw[i] - direct.raw[i]` (both legs run
the same `iterations`/`warmup` config, so index `i` is the same logical request slot on each
leg — the "pair" the design doc means), sorts *that* array, and takes nearest-rank
percentiles of the deltas themselves. Throws if the two sample counts differ (per-pair delta
is undefined otherwise).

**Regression test added** (`latency.test.ts`) demonstrating a case where the two methods
disagree: `direct=[1,2,3,4,5]`, `proxied=[100,2,3,4,5]` (one outlier at index 0, everything
else identical). The old aggregate-subtraction method reports p50 overhead = **1ms**
(`direct` sorted median 3 vs. `proxied` sorted median 4) even though only one request out of
five actually saw any overhead at all. The correct per-pair delta series is
`[99, 0, 0, 0, 0]`, whose p50 is **0ms** — the outlier surfaces at p95/p99 (both 99), which is
the point of measuring per-pair rather than per-aggregate.

**Did this change the S2-era verdict?** No — re-confirmed by re-running the existing
`bench.test.ts`/`latency.test.ts` suite (all pass) and by reasoning about the fixture: the S2
validation's 0.346ms number
(`.claude/artifacts/crew/validations/20260712T233416Z-validation-result-feat-458-s2-ac-4-proxy-latency.md`)
was produced with the buggy formula and was never re-run against raw samples here (that
JSON's raw arrays weren't retained for reprocessing), so it isn't literally recomputed in this
artifact — but the margin was ~29x (0.35ms vs. 10ms), and per-pair vs. aggregate percentiles
only diverge meaningfully when the two distributions are poorly rank-correlated with outliers
concentrated at different indices, which two near-identical low-variance sequential loopback
distributions are not. The fix matters going forward (this run) more than retroactively.

## Job 2 — capture-live bench

### How capture was enabled without touching the shipped default

`src/cli/proxy.ts` reads `proxy.capture.enabled` from config.yaml only — there is no
`--capture` CLI flag (ADR-013 §5, "no one-click toggle" is deliberate). New file
`scripts/eval/proxy-bench/lib/capture-sandbox.ts` (`makeProxySandbox(prefix, captureEnabled)`)
builds a throwaway `mkdtempSync` root, redirects `APPDATA`/`LOCALAPPDATA`/`HOME`/
`XDG_CONFIG_HOME`/`XDG_DATA_HOME`/`ASTRA_MEMORY_DATADIR` into it (same technique
`../shared/spawn-daemon.ts`'s `makeIsolatedEvalEnv` already uses for the daemon spawn
helpers, independently authored here since that module is owned by other eval harnesses),
and writes a config.yaml with exactly one line that differs from `defaultConfig()`:
`proxy.capture.enabled: <true|false>`. `bench.mts` now routes **every** proxy spawn (capture
on or off) through this sandbox via a new `--capture` flag.

This also closes a **pre-existing safety gap**: before this change, `bench.mts` spawned the
proxy with the harness's own inherited `process.env` unmodified, so on a box with a real
`%APPDATA%\Astramem\config.yaml` (this box has one, paired to a live production tenant per
`../shared/spawn-daemon.ts`'s own header comment) the proxy under test would have read that
real config. Harmless while capture was never exercised by this harness; not once a
`--capture` run could have written captured atoms into the operator's real dataDir.
Confirmed via `capture-sandbox.test.ts`'s "never mutates process.env beyond the call" test
and an end-to-end test asserting the real proxy CLI's boot log says `capture is ON` /
does NOT say it, gated on the correct sandboxed config.

**A second gap found and fixed while producing evidence:** the harness's default request
body (`'{}'`) and the upstream stub's default raw-byte response body are not valid chat-
completion shapes. `src/capture/proxy.ts`'s `extractRequestTurns`/`extractResponseTurn`
produce **zero turns** for both, so `finishCapture()` returns before ever calling the real
synchronous `writeToSpool` — meaning a capture-on bench run against the unmodified harness
would never have exercised the exact code path (suspect (a) in the dispatch brief: the
`setImmediate` spool deferral / synchronous `writeFileSync`+`renameSync`) that matters most.
Verified this empirically: a manual throwaway script (deleted after use, not committed)
spawned a capture-on proxy via `makeProxySandbox`, sent 3 requests with the OLD `'{}'` body,
and found **zero** files under `<dataDir>/ingest-spool`. Fixed by adding `chatShape` to
`upstream-stub.ts` (real `{choices:[{message:{role:'assistant',content:...}}]}` JSON,
padded to `bodySize`) and switching `bench.mts`'s request bodies to a real
`{model, messages:[{role:'user', content:...}]}` shape. Re-ran the same manual check with the
fixed bodies: **1 file** written under `<dataDir>/ingest-spool` after 3 identical requests
(collapsed to 1 by the idempotency-key dedup — content-identical requests hash to the same
key and overwrite the same path, which is correct designed behavior per
`proxyIdempotencyKey`'s doc comment, not a bug; each of the 3 requests still performed the
full synchronous write). All new/changed code is test-only (`scripts/eval/proxy-bench/**`);
`src/**` was not touched.

### Build

```
bun install    # 255 packages, fresh worktree
bun run build  # tsc -p . — clean
```

### Commands

```
bun scripts/eval/proxy-bench/bench.mts --requests 500 --warmup 30 --threshold-ms 10 \
  --out .eval-data/proxy-bench/runs/s4b-direct-capture-off.json

bun scripts/eval/proxy-bench/bench.mts --capture --requests 500 --warmup 30 --threshold-ms 10 \
  --out .eval-data/proxy-bench/runs/s4b-capture-on-real.json

# repeat, independent process, to rule out a fluke
bun scripts/eval/proxy-bench/bench.mts --capture --requests 500 --warmup 30 --threshold-ms 10 \
  --out .eval-data/proxy-bench/runs/s4b-capture-on-repeat.json
```
500 measured requests + 30 discarded warmup iterations per distribution, concurrency=1
(sequential, per-request latency not queueing delay). `--proxy-entry` not needed —
`resolveProxyEntry` auto-detects `dist/cli/index.js`. Synthetic loopback upstream stub only,
`chatShape: true`, 1024-byte target body — no real LLM provider, no network egress, no
Ollama/GPU load.

### Results — three distributions

| Leg | n | p50 (ms) | p95 (ms) | p99 (ms) | mean (ms) |
|---|---|---|---|---|---|
| direct → stub (capture-off run's baseline) | 500 | 0.164 | 0.283 | 1.228 | 0.188 |
| proxy, capture OFF | 500 | 0.342 | 0.597 | 1.368 | 0.384 |
| direct → stub (capture-on run's baseline) | 500 | 0.170 | 0.320 | 1.809 | 0.221 |
| **proxy, capture ON** (run 1) | 500 | **0.550** | 1.658 | 4.521 | 0.754 |
| direct → stub (capture-on repeat's baseline) | 500 | 0.177 | 0.310 | 1.975 | 0.243 |
| **proxy, capture ON** (run 2, repeat) | 500 | **0.578** | 1.477 | 2.253 | 0.684 |

Each row's own `direct` baseline is measured immediately before that row's `proxied` leg in
the same process invocation (bench.mts always measures both back-to-back) — not a shared
baseline across runs, so per-pair overhead below is computed leg-to-its-own-baseline.

### Per-request-pair overhead (fixed `computeOverhead`, `proxied - direct`)

| Run | p50 overhead (ms) | p95 overhead (ms) | p99 overhead (ms) | mean overhead (ms) | threshold | verdict |
|---|---|---|---|---|---|---|
| capture OFF | 0.174 | 0.443 | 1.243 | 0.195 | <10ms | PASS |
| **capture ON (run 1)** | **0.392** | 1.365 | 4.440 | 0.533 | <10ms | **PASS** |
| **capture ON (run 2, repeat)** | **0.404** | 1.265 | 2.048 | 0.442 | <10ms | **PASS** |

Full JSON (including raw per-request samples) for all three runs:
`.eval-data/proxy-bench/runs/s4b-direct-capture-off.json`,
`.eval-data/proxy-bench/runs/s4b-capture-on-real.json`,
`.eval-data/proxy-bench/runs/s4b-capture-on-repeat.json` (gitignored, not committed).

## PASS/FAIL against S4-AC-2 (p50 < 10ms with capture live)

**PASS.** p50 overhead with capture ON measured 0.392ms and 0.404ms across two independent
process runs — roughly **25x margin** under the 10ms threshold, and the capture-ON minus
capture-OFF delta (≈0.22ms) is itself small relative to the threshold, meaning the added cost
of capture specifically (tee buffering + JSON parse + relevance gate + synchronous spool
write, all deferred via `setImmediate`) is not the dominant contributor to proxy overhead at
p50. Tail latency (p95/p99) is more visibly affected by capture (1.27-1.66ms p95, 2.05-4.44ms
p99 vs. 0.44-1.24ms/1.24-1.37ms for capture-off) — expected, since the synchronous spool write
is real disk I/O that capture-off never performs, but still nowhere near the p50 threshold
this AC gates on, and ADR-013 Decision 2's actual requirement (capture must never
backpressure the *forward path*) is about the client-facing response completing before the
spool write starts, which `setImmediate` deferral does — not about tail latency being zero.

## Honest note on concurrent box load

This box was running other work during these benches: at minimum an active astramem-local
daemon process, and other agents/sessions in sibling worktrees per this task's dispatch
brief. No attempt was made to quiesce the box before measuring. Load of this kind can only
**inflate** measured latency (competing for CPU/disk I/O), never deflate it — so a PASS
measured under load is a **conservative** PASS: a quieter box would show equal or lower
overhead, not higher. The two independent capture-ON runs (0.392ms, 0.404ms) landed within
3% of each other despite this, which is a reasonable stability signal given the shared-box
caveat.

## Test suite

```
bunx vitest run scripts/eval/proxy-bench
```
**45 passed (45)**, 5 test files (`latency.test.ts`, `upstream-stub.test.ts`,
`proxy-driver.test.ts`, `capture-sandbox.test.ts` [new], `bench.test.ts`) — up from 33 at the
start of this task (+2 `computeOverhead` regression tests, +3 `chatShape` tests, +7
`capture-sandbox.ts` tests including two end-to-end cases against the real built proxy CLI
confirming the "capture is ON"/absent boot line under the sandboxed config).

`bun run build` (`tsc -p .`) — clean, no errors.

## Files changed (this task's scope only — `scripts/eval/proxy-bench/**` + this artifact)

- `scripts/eval/proxy-bench/lib/latency.ts` — `computeOverhead` fix (per-pair delta)
- `scripts/eval/proxy-bench/lib/latency.test.ts` — regression + mismatched-length tests
- `scripts/eval/proxy-bench/lib/capture-sandbox.ts` — NEW, capture-enable sandbox
- `scripts/eval/proxy-bench/lib/capture-sandbox.test.ts` — NEW
- `scripts/eval/proxy-bench/lib/upstream-stub.ts` — `chatShape` option
- `scripts/eval/proxy-bench/lib/upstream-stub.test.ts` — `chatShape` tests
- `scripts/eval/proxy-bench/bench.mts` — `--capture` flag, sandboxed spawn (always), realistic
  chat-shaped request bodies, `capture_enabled` in output config, capture-boot-line check
- `scripts/eval/proxy-bench/README.md` — documents `--capture`, new files
- `.claude/artifacts/crew/validations/20260713T005924Z-validation-result-feat-458-s4b-capture-live-latency.md` (this file)

`src/**` was NOT touched — capture-enable is entirely test-only plumbing on top of the
existing config-driven `proxy.capture.enabled` surface.

## Commits (branch `feat/feat-458-s4b-capture-bench`, local only, not pushed)

1. `fix(proxy-bench): computeOverhead uses per-request-pair delta, not aggregate-percentile diff`
2. (this validation's commit — capture-sandbox + chatShape + bench --capture wiring + this artifact)
