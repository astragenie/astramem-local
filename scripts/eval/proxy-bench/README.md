# proxy-bench

FEAT-458 Wave 1 track W1a (S1-AC-3). Measures the LLM proxy's ADDED latency
versus talking to an upstream directly — the evidence S2-AC-4 ("p50 proxy
overhead < 10ms") needs, and which was previously unmeasurable (the S2
review returned `incomplete_wip` for exactly this gap).

## What it measures

1. Starts a synthetic local upstream (`lib/upstream-stub.ts`) — a trivial
   `node:http` server on an ephemeral loopback port returning a canned body
   of configurable size, with an optional artificial delay. Never a real LLM
   provider, never network egress.
2. Drives N requests **direct to the stub** → baseline latency distribution.
3. Spawns the proxy under test pointed at the stub as its upstream, drives
   the same N requests **through the proxy** → proxied latency distribution.
4. Reports p50/p95/p99/mean for both, plus the delta (`proxied - direct`)
   — the number S2-AC-4 asserts is `< 10ms` at p50.

## The proxy under test lives on a different branch

The proxy (`src/proxy/server.ts` + `src/cli/proxy.ts`, ADR-013) is being
built on `feat/feat-458-s2-proxy-core-v2` (worktree `w458core`), not this
branch. This harness never imports proxy source — `--proxy-entry` takes the
**built CLI path** (`dist/cli/index.js` after `bun run build` on that
branch) as a parameter. Until that branch merges here:

- `bench.mts` **degrades to a baseline-only run** (measures + reports the
  direct distribution, `proxied`/`overhead` are `null`, exit code 0) unless
  `--require-proxy` is passed, in which case a missing entrypoint is exit 1.
- The harness's own tests (`lib/proxy-driver.test.ts`, `bench.test.ts`) run
  the FULL direct+proxied flow against `lib/__fixtures__/fake-proxy-cli.mjs`
  — a minimal stand-in that speaks the same argv contract (`proxy serve
  --port N --upstream <url> --host H`) and prints the same boot-log line
  format as the real CLI, so the harness's spawn/measure/teardown mechanics
  are fully covered without depending on the other branch. It is NOT a
  substitute for the real proxy's ADR-013 guarantees (byte-transparency,
  hop-header stripping, loopback enforcement) — only for exercising this
  harness's own plumbing.
- `bench.test.ts`'s last `describe` block runs one true end-to-end case
  against the real built CLI, but only `describe.skipIf`'s in when
  `dist/cli/index.js` actually exists — it never fails when the other
  branch hasn't merged yet.

Once Wave 2 merges the two branches and `bun run build` produces a real
`dist/cli/index.js` with `proxy serve` support, no flags are needed —
`resolveProxyEntry` finds it automatically.

## Usage

```
bun scripts/eval/proxy-bench/bench.mts \
  [--proxy-entry <path to dist/cli/index.js>] [--require-proxy] \
  [--requests 200] [--warmup 20] [--concurrency 1] \
  [--body-size 1024] [--upstream-delay-ms 0] \
  [--threshold-ms 10] [--gate] [--capture] \
  [--out <path>]
```

- `--requests` / `--warmup`: iterations measured / discarded warmup
  iterations, per distribution.
- `--concurrency`: requests in flight at once (default 1, strictly
  sequential — the canonical S1-AC-3 measurement wants per-request latency,
  not queueing delay under concurrent load).
- `--body-size` / `--upstream-delay-ms`: shape of the synthetic upstream's
  canned response.
- `--threshold-ms` (default 10): the S2-AC-4 threshold used to compute
  `assessment.pass` in the JSON output. Reporting only, unless `--gate` is
  also passed, in which case a `pass: false` p50 assessment exits the
  process non-zero (useful for a future CI gate; off by default since this
  harness's primary job in Wave 1 is producing evidence, not enforcing a
  gate on a proxy that doesn't exist here yet).
- `--out`: JSON result path. Defaults under
  `.eval-data/proxy-bench/runs/<timestamp>.json`.
- `--capture` (FEAT-458 S4b, S4-AC-2): bench the proxy with
  `proxy.capture.enabled=true` instead of the capture-free forward path.
  `src/cli/proxy.ts` has no `--capture` CLI flag itself (config-driven only,
  ADR-013 §5) — this harness's flag drives `lib/capture-sandbox.ts` to spawn
  the proxy against a throwaway config/data dir carrying that setting for
  one run only; the shipped default (`false`) is never touched. Every proxy
  spawn (capture on OR off) now goes through that sandbox, which also closes
  a latent hazard: an unsandboxed spawn previously inherited whatever real
  `%APPDATA%\Astramem\config.yaml` exists on the box running the bench. The
  harness's request/response bodies are also real OpenAI chat-completion
  shapes (not an empty `{}`/raw byte blob) specifically so
  `src/capture/proxy.ts`'s turn extraction recognizes them and the real
  synchronous spool write (`writeToSpool`) actually fires on every proxied
  request when `--capture` is set — a capture-on bench that never exercises
  that write would be a false PASS against ADR-013 Decision 2 (capture must
  never backpressure the forward path).

### Sample output

```
Upstream stub: bodySize=1024 delayMs=0
Requests: 200 (+20 warmup), concurrency=1
Proxy entry: C:\work\mega\astramemory-local\dist\cli\index.js

Measuring baseline (direct to synthetic upstream)...
  direct: p50=0.412ms p95=0.891ms p99=1.203ms mean=0.455ms (n=200)

Spawning proxy under test...
  proxy up at http://127.0.0.1:54231 -> http://127.0.0.1:54118 (pid 41823)
Measuring proxied (through the proxy under test)...
  proxied: p50=1.877ms p95=3.102ms p99=4.550ms mean=2.011ms (n=200)
  overhead (proxied - direct): p50=1.465ms p95=2.211ms p99=3.347ms mean=1.556ms

Result -> .eval-data/proxy-bench/runs/2026-07-12T18-04-11-000Z.json
proxy-bench: baseline p50=0.41ms | proxied p50=1.88ms | overhead(p50)=1.47ms (threshold <10ms: PASS)
```

(Numbers above are illustrative — Wave 1 has no real proxy to measure yet.)

## JSON output shape

```jsonc
{
  "measured_at": "2026-07-12T18:04:11.000Z",
  "config": { "requests": 200, "warmup": 20, "concurrency": 1, "body_size": 1024, "upstream_delay_ms": 0, "threshold_ms": 10 },
  "proxy_entry": "C:\\...\\dist\\cli\\index.js", // or null in baseline-only mode
  "direct": { "n": 200, "min": ..., "p50": ..., "p95": ..., "p99": ..., "max": ..., "mean": ..., "raw": [...] },
  "proxied": { /* same shape */ } , // or null
  "overhead": { "p50": ..., "p95": ..., "p99": ..., "mean": ... }, // or null
  "assessment": { "threshold_ms": 10, "p50_overhead_ms": 1.465, "pass": true }, // pass is null in baseline-only mode
  "note": null // or an explanation when running baseline-only
}
```

A validation artifact can cite `overhead.p50` / `assessment.pass` directly
as S2-AC-4 evidence once run against the real proxy.

## Layout

```
scripts/eval/proxy-bench/
  bench.mts                    CLI entrypoint (this is what you run)
  bench.test.ts                CLI-level integration tests
  lib/
    upstream-stub.ts           synthetic node:http upstream (canned body, optional delay,
                                optional chatShape for real chat-completion JSON)
    upstream-stub.test.ts
    proxy-driver.ts            spawn/boot-wait/kill for the proxy CLI under test
    proxy-driver.test.ts
    capture-sandbox.ts         throwaway config/data sandbox driving proxy.capture.enabled
                                for one spawn (FEAT-458 S4b) — never the real OS dirs
    capture-sandbox.test.ts
    latency.ts                 warmup-aware sample collection + percentile summary +
                                PER-REQUEST-PAIR overhead delta
    latency.test.ts
    __fixtures__/
      fake-proxy-cli.mjs       test-only stand-in for the real proxy CLI
```

## Reuse

Built on top of `../shared/`:
- `../shared/concurrency.ts` (`mapWithConcurrency`) drives the
  warmup+iterations request loop.
- `lib/latency.ts`'s percentile math reuses `../../perf/lib/stats.ts`'s
  `summarize()` (the repo's one nearest-rank percentile implementation, also
  used by `scripts/perf/bench.mts`) for n/p50/p95/max/mean, adding only p99
  and min via the identical formula — not a second percentile
  implementation.
- `proxy-driver.test.ts` reuses `../shared/daemon-manifest.ts`'s
  `checkPortOwner` to verify teardown actually released the port (the
  "zero orphan PIDs" check) rather than re-implementing OS process/port
  inspection.

Does **not** import `../shared/spawn-daemon.ts` directly — the proxy CLI's
argv shape and boot-log line differ from the eval daemon's, so
`lib/proxy-driver.ts` mirrors that module's spawn/wait/kill discipline
independently rather than forcing a shared abstraction across two
genuinely different subprocess contracts. See that file's header comment
for the full rationale.
