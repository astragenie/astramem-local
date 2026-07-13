/**
 * Proxy latency bench (FEAT-458 Wave 1 track W1a, S1-AC-3). Measures the
 * proxy's ADDED latency versus talking to an upstream directly — this is
 * the harness S2-AC-4 ("p50 proxy overhead < 10ms") needs to produce
 * evidence from. Drives N requests direct-to-a-synthetic-stub for a
 * baseline distribution, then N requests through the proxy under test for a
 * proxied distribution, and reports p50/p95/p99/mean for both plus the
 * delta.
 *
 * The proxy under test lives on a DIFFERENT branch
 * (feat/feat-458-s2-proxy-core-v2, worktree w458core) that has not merged
 * into this one yet — see ./lib/proxy-driver.ts's header for the full
 * rationale. Until it has (and `bun run build` has produced
 * dist/cli/index.js there), this harness degrades to a baseline-only run: it
 * still measures and reports the direct-to-stub distribution, and says so
 * plainly, rather than failing. Pass --require-proxy to make a missing
 * proxy entrypoint a hard error instead (useful once Wave 2 wires this into
 * CI).
 *
 * Usage:
 *   bun scripts/eval/proxy-bench/bench.mts
 *     [--proxy-entry <path to dist/cli/index.js>] [--require-proxy]
 *     [--requests 200] [--warmup 20] [--concurrency 1]
 *     [--body-size 1024] [--upstream-delay-ms 0]
 *     [--threshold-ms 10] [--gate] [--capture]
 *     [--out <path>]
 *
 * No GPU, no Ollama, no network egress — the "upstream" is always the
 * synthetic in-process stub in ./lib/upstream-stub.ts, loopback-only.
 *
 * `--capture` (FEAT-458 S4b, S4-AC-2): benches the proxy with
 * `proxy.capture.enabled=true` instead of the S2-era capture-free forward
 * path. `src/cli/proxy.ts` reads that flag from config.yaml only — there is
 * no `--capture` CLI flag on the real proxy CLI, by design (ADR-013 §5, "no
 * one-click toggle"). This harness's own `--capture` flag never touches the
 * shipped default (`defaultConfig().proxy.capture.enabled === false`); it
 * drives ./lib/capture-sandbox.ts to spawn the proxy under test against a
 * throwaway config/data dir carrying `proxy.capture.enabled: true` for this
 * one run only. EVERY proxy spawn (capture on or off) now goes through that
 * same sandbox, which also closes a pre-existing hazard: previously this
 * harness spawned the proxy with its own inherited env unmodified, so on a
 * box with a real `%APPDATA%\Astramem\config.yaml` (paired to a live
 * production tenant, see ../shared/spawn-daemon.ts's header) the proxy under
 * test would have read that real config — harmless while capture was never
 * exercised, but not once a `--capture` run could write captured atoms into
 * the operator's real dataDir.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startUpstreamStub } from './lib/upstream-stub.js';
import { spawnProxy, killProxy, resolveProxyEntry, type ProxyHandle } from './lib/proxy-driver.js';
import { collectLatencies, summarizeExtended, computeOverhead, type ExtendedLatencyStats, type OverheadDelta } from './lib/latency.js';
import { makeProxySandbox, type ProxySandbox } from './lib/capture-sandbox.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const args = process.argv.slice(2);
const get = (flag: string): string | undefined => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (flag: string): boolean => args.includes(flag);

const proxyEntryArg = get('--proxy-entry');
const requireProxy = has('--require-proxy');
const requests = Number(get('--requests') ?? '200');
const warmup = Number(get('--warmup') ?? '20');
const concurrency = Number(get('--concurrency') ?? '1');
const bodySize = Number(get('--body-size') ?? '1024');
const upstreamDelayMs = Number(get('--upstream-delay-ms') ?? '0');
const thresholdMs = Number(get('--threshold-ms') ?? '10');
const gate = has('--gate');
const captureEnabled = has('--capture');
const outPath = get('--out') ?? join(
  REPO_ROOT, '.eval-data', 'proxy-bench', 'runs',
  `${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
);

interface BenchResult {
  measured_at: string;
  config: {
    requests: number;
    warmup: number;
    concurrency: number;
    body_size: number;
    upstream_delay_ms: number;
    threshold_ms: number;
    capture_enabled: boolean;
  };
  proxy_entry: string | null;
  direct: ExtendedLatencyStats;
  proxied: ExtendedLatencyStats | null;
  overhead: OverheadDelta | null;
  assessment: { threshold_ms: number; p50_overhead_ms: number | null; pass: boolean | null };
  note: string | null;
}

async function main(): Promise<void> {
  const proxyEntry = resolveProxyEntry(proxyEntryArg, REPO_ROOT);

  if (!proxyEntry && requireProxy) {
    console.error(
      `--require-proxy set but no proxy entrypoint found (looked at ${proxyEntryArg ?? join(REPO_ROOT, 'dist', 'cli', 'index.js')}). ` +
      `Build feat/feat-458-s2-proxy-core-v2's dist/cli/index.js first, or pass --proxy-entry <path>.`,
    );
    process.exitCode = 1;
    return;
  }

  console.log(`Upstream stub: bodySize=${bodySize} delayMs=${upstreamDelayMs}`);
  console.log(`Requests: ${requests} (+${warmup} warmup), concurrency=${concurrency}`);
  console.log(proxyEntry ? `Proxy entry: ${proxyEntry}` : 'Proxy entry: NOT FOUND — running baseline-only (direct-to-stub) measurement');
  if (proxyEntry) console.log(`Capture: ${captureEnabled ? 'ON (proxy.capture.enabled=true, sandboxed config)' : 'OFF (default)'}`);

  // FEAT-458 S4b: real chat-completion shapes on BOTH legs of the wire, not
  // an empty `{}` request against a raw-byte response. `src/capture/proxy.ts`
  // (`extractRequestTurns`/`extractResponseTurn`) only recognizes an actual
  // `messages[].content` / `choices[0].message.content` shape as a turn — an
  // empty body or a raw byte blob produces ZERO turns, so `finishCapture`
  // returns before ever calling the real synchronous `writeToSpool` path.
  // A capture-ON bench that never exercises that write is a false PASS: it
  // wouldn't have caught a regression in the prime suspect ADR-013 flags
  // (the setImmediate spool deferral not actually keeping writeFileSync/
  // renameSync off the client-facing pipe). This affects only the request
  // BODY sent by this harness and the upstream stub's response shape — the
  // direct and capture-off-proxied legs pay the identical JSON-parse cost
  // either way, so the comparison stays apples-to-apples.
  const chatRequestBody = JSON.stringify({
    model: 'proxy-bench-stub',
    messages: [{ role: 'user', content: 'FEAT-458 S4b capture-live latency bench request payload. '.repeat(4) }],
  });

  const stub = await startUpstreamStub({ bodySize, delayMs: upstreamDelayMs, chatShape: true });
  let proxy: ProxyHandle | undefined;
  let sandbox: ProxySandbox | undefined;
  let result: BenchResult;

  try {
    console.log('\nMeasuring baseline (direct to synthetic upstream)...');
    const directSamples = await collectLatencies(
      () => fetch(`${stub.baseUrl}/v1/chat/completions`, { method: 'POST', body: chatRequestBody }).then(r => r.arrayBuffer()),
      { iterations: requests, warmup, concurrency },
    );
    const direct = summarizeExtended(directSamples);
    console.log(`  direct: p50=${direct.p50.toFixed(3)}ms p95=${direct.p95.toFixed(3)}ms p99=${direct.p99.toFixed(3)}ms mean=${direct.mean.toFixed(3)}ms (n=${direct.n})`);

    let proxied: ExtendedLatencyStats | null = null;
    let overhead: OverheadDelta | null = null;

    if (proxyEntry) {
      console.log('\nSpawning proxy under test...');
      // Every spawn goes through a throwaway config/data sandbox — never the
      // operator's real APPDATA/dataDir (see this file's header). `captureEnabled`
      // controls the ONE line in the sandboxed config.yaml that differs from
      // the real shipped default.
      sandbox = makeProxySandbox('proxy-bench-run', captureEnabled);
      proxy = await spawnProxy({ entry: proxyEntry, upstream: stub.baseUrl, env: sandbox.env });
      console.log(`  proxy up at ${proxy.baseUrl} -> ${stub.baseUrl} (pid ${proxy.pid})`);
      if (captureEnabled && !proxy.stdout().includes('capture is ON')) {
        console.log('  (waiting briefly for the capture boot line...)');
        await new Promise(r => setTimeout(r, 200));
      }
      if (captureEnabled) {
        console.log(`  capture: ${proxy.stdout().includes('capture is ON') ? 'CONFIRMED ON' : 'WARNING — expected "capture is ON" boot line, not seen'}`);
      }

      console.log('Measuring proxied (through the proxy under test)...');
      const proxiedSamples = await collectLatencies(
        () => fetch(`${proxy!.baseUrl}/v1/chat/completions`, { method: 'POST', body: chatRequestBody }).then(r => r.arrayBuffer()),
        { iterations: requests, warmup, concurrency },
      );
      proxied = summarizeExtended(proxiedSamples);
      overhead = computeOverhead(direct, proxied);
      console.log(`  proxied: p50=${proxied.p50.toFixed(3)}ms p95=${proxied.p95.toFixed(3)}ms p99=${proxied.p99.toFixed(3)}ms mean=${proxied.mean.toFixed(3)}ms (n=${proxied.n})`);
      console.log(`  overhead (proxied - direct): p50=${overhead.p50.toFixed(3)}ms p95=${overhead.p95.toFixed(3)}ms p99=${overhead.p99.toFixed(3)}ms mean=${overhead.mean.toFixed(3)}ms`);
    }

    const p50OverheadMs = overhead ? overhead.p50 : null;
    const pass = p50OverheadMs === null ? null : p50OverheadMs < thresholdMs;

    result = {
      measured_at: new Date().toISOString(),
      config: { requests, warmup, concurrency, body_size: bodySize, upstream_delay_ms: upstreamDelayMs, threshold_ms: thresholdMs, capture_enabled: captureEnabled },
      proxy_entry: proxyEntry ?? null,
      direct,
      proxied,
      overhead,
      assessment: { threshold_ms: thresholdMs, p50_overhead_ms: p50OverheadMs, pass },
      note: proxyEntry ? null : 'proxy entrypoint not found — baseline-only run; re-run with --proxy-entry once feat/feat-458-s2-proxy-core-v2 is built, or after Wave 2 merges it here.',
    };
  } finally {
    if (proxy) await killProxy(proxy);
    sandbox?.cleanup();
    await stub.close();
  }

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(result, null, 2), 'utf8');

  console.log(`\nResult -> ${outPath}`);
  if (result.proxied && result.overhead) {
    const verdict = result.assessment.pass ? 'PASS' : 'FAIL';
    console.log(
      `proxy-bench: baseline p50=${result.direct.p50.toFixed(2)}ms | proxied p50=${result.proxied.p50.toFixed(2)}ms | ` +
      `overhead(p50)=${result.overhead.p50.toFixed(2)}ms (threshold <${thresholdMs}ms: ${verdict})`,
    );
  } else {
    console.log(`proxy-bench: baseline-only, direct p50=${result.direct.p50.toFixed(2)}ms p95=${result.direct.p95.toFixed(2)}ms (no proxy entrypoint available)`);
  }

  if (requireProxy && !result.proxied) {
    process.exitCode = 1; // unreachable given the early-return above, kept for defense in depth
  } else if (gate && result.assessment.pass === false) {
    process.exitCode = 1;
  }
}

await main();
