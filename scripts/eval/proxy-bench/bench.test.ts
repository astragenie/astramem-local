/**
 * CLI-level integration tests for bench.mts. Spawns `bun bench.mts` as a
 * real subprocess (same precedent as ../longmemeval/judge.mts spawning
 * `bun ... metrics.mts`) with small --requests/--warmup so the suite stays
 * fast, and always via --out pointed at a throwaway tmp dir — never the
 * real .eval-data/proxy-bench/runs/ location.
 *
 * The "against the fake proxy CLI fixture" tests exercise the FULL
 * direct+proxied flow without depending on feat/feat-458-s2-proxy-core-v2
 * (not on this branch). The final describe block is the one place this
 * suite talks to the REAL built proxy CLI, and skips cleanly when it isn't
 * present — exactly the "tests skip cleanly when the proxy module is
 * absent" requirement.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveProxyEntry } from './lib/proxy-driver.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const BENCH_SCRIPT = join(HERE, 'bench.mts');
const FAKE_PROXY_CLI = join(HERE, 'lib', '__fixtures__', 'fake-proxy-cli.mjs');

interface BenchResultShape {
  proxy_entry: string | null;
  direct: { n: number; p50: number };
  proxied: { n: number; p50: number } | null;
  overhead: { p50: number } | null;
  assessment: { threshold_ms: number; p50_overhead_ms: number | null; pass: boolean | null };
  note: string | null;
}

function runBench(args: string[], opts: { timeoutMs?: number } = {}): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync('bun', [BENCH_SCRIPT, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: opts.timeoutMs ?? 60_000,
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

describe('bench.mts — baseline-only mode (no --proxy-entry, none resolvable)', () => {
  let dir: string;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it('measures the direct distribution and writes a baseline-only JSON result', () => {
    dir = mkdtempSync(join(tmpdir(), 'proxy-bench-baseline-'));
    const outPath = join(dir, 'result.json');
    // Point --proxy-entry at a path that never exists, so this passes
    // regardless of whether dist/cli/index.js happens to be built locally.
    const { status, stdout } = runBench([
      '--proxy-entry', join(dir, 'definitely-not-built', 'index.js'),
      '--requests', '20', '--warmup', '5', '--out', outPath,
    ]);
    expect(status).toBe(0);
    expect(stdout).toContain('baseline-only');

    const result = JSON.parse(readFileSync(outPath, 'utf8')) as BenchResultShape;
    expect(result.proxy_entry).toBeNull();
    expect(result.proxied).toBeNull();
    expect(result.overhead).toBeNull();
    expect(result.direct.n).toBe(20);
    expect(result.note).toMatch(/proxy entrypoint not found/);
    expect(result.assessment.pass).toBeNull();
  });

  it('--require-proxy with no resolvable entry exits non-zero and writes no result', () => {
    dir = mkdtempSync(join(tmpdir(), 'proxy-bench-require-'));
    const outPath = join(dir, 'result.json');
    const { status, stderr } = runBench([
      '--require-proxy',
      '--proxy-entry', join(dir, 'still-not-built', 'index.js'),
      '--requests', '5', '--warmup', '1', '--out', outPath,
    ]);
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/--require-proxy/);
    expect(existsSync(outPath)).toBe(false);
  });
});

describe('bench.mts — full direct+proxied flow against the fake proxy CLI fixture', () => {
  let dir: string;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it('reports direct, proxied, overhead, and an assessment against --threshold-ms', () => {
    dir = mkdtempSync(join(tmpdir(), 'proxy-bench-fixture-'));
    const outPath = join(dir, 'result.json');
    const { status, stdout } = runBench([
      '--proxy-entry', FAKE_PROXY_CLI,
      '--requests', '20', '--warmup', '5', '--out', outPath,
    ]);
    expect(status).toBe(0);
    expect(stdout).toContain('overhead(p50)=');

    const result = JSON.parse(readFileSync(outPath, 'utf8')) as BenchResultShape;
    expect(result.proxy_entry).toBe(FAKE_PROXY_CLI);
    expect(result.direct.n).toBe(20);
    expect(result.proxied?.n).toBe(20);
    expect(result.overhead).not.toBeNull();
    expect(result.assessment.p50_overhead_ms).toBe(result.overhead!.p50);
    expect(typeof result.assessment.pass).toBe('boolean');
  }, 20_000);

  it('--gate exits non-zero when p50 overhead exceeds an impossible-to-clear threshold', () => {
    dir = mkdtempSync(join(tmpdir(), 'proxy-bench-gate-fail-'));
    const outPath = join(dir, 'result.json');
    const { status } = runBench([
      '--proxy-entry', FAKE_PROXY_CLI,
      '--requests', '10', '--warmup', '2',
      '--threshold-ms', '-100000', // effectively impossible to clear
      '--gate', '--out', outPath,
    ]);
    expect(status).not.toBe(0);
    const result = JSON.parse(readFileSync(outPath, 'utf8')) as BenchResultShape;
    expect(result.assessment.pass).toBe(false);
  }, 20_000);

  it('--gate exits zero when the threshold is trivially generous', () => {
    dir = mkdtempSync(join(tmpdir(), 'proxy-bench-gate-pass-'));
    const outPath = join(dir, 'result.json');
    const { status } = runBench([
      '--proxy-entry', FAKE_PROXY_CLI,
      '--requests', '10', '--warmup', '2',
      '--threshold-ms', '100000',
      '--gate', '--out', outPath,
    ]);
    expect(status).toBe(0);
  }, 20_000);
});

// The one place this suite depends on the REAL proxy CLI
// (feat/feat-458-s2-proxy-core-v2, not on this branch yet). Skips cleanly —
// never fails the suite — when nothing is built at dist/cli/index.js.
const realProxyEntry = resolveProxyEntry(undefined, REPO_ROOT);
describe.skipIf(!realProxyEntry)('bench.mts — end-to-end against the real built proxy CLI', () => {
  it('produces S2-AC-4 evidence: p50 overhead measured against the actual proxy', () => {
    const dir = mkdtempSync(join(tmpdir(), 'proxy-bench-real-'));
    try {
      const outPath = join(dir, 'result.json');
      const { status } = runBench(['--requests', '50', '--warmup', '10', '--out', outPath], { timeoutMs: 120_000 });
      expect(status).toBe(0);
      const result = JSON.parse(readFileSync(outPath, 'utf8')) as BenchResultShape;
      expect(result.proxy_entry).not.toBeNull();
      expect(result.overhead).not.toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 130_000);
});
