/**
 * tests/service/release-timeout-observability.test.ts
 *
 * B3 review (2026-07-13): release.ts's runCaptured() has a branch meant to
 * make a spawnSync timeout-kill observable — distinguishable from "the
 * command ran and printed nothing". The first version of that branch
 * checked `res.signal && !res.error`, which is DEAD CODE on this runtime:
 * empirically verified (see release.ts's own comment on runCaptured) that a
 * real spawnSync timeout-kill ALWAYS sets `res.error` (message contains
 * 'ETIMEDOUT') together with `res.signal` — never signal alone. Caught in
 * review because tests/service/release.test.ts (which exercises real
 * spawnSync against fixture repos) never actually triggers a timeout — a
 * 15s+ real sleep was never worth the cost, so the branch shipped unverified.
 *
 * This file mocks `node:child_process`'s spawnSync to deterministically
 * and instantly reproduce that exact timeout shape (no real waiting) and
 * pins the fix: materializeRelease's thrown error must name the timeout
 * explicitly, not just carry the raw (easy-to-miss) 'ETIMEDOUT' substring.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const spawnSyncMock = vi.fn();
vi.mock('node:child_process', () => ({ spawnSync: spawnSyncMock }));

const { materializeRelease } = await import('../../src/service/release.js');

/** Shaped exactly like a real spawnSync timeout-kill on this runtime
 *  (verified empirically — see release.ts's runCaptured comment): res.error
 *  AND res.signal both set, status null, no output. */
function timeoutKillResult() {
  return {
    status: null,
    signal: 'SIGTERM' as NodeJS.Signals,
    stdout: '',
    stderr: '',
    error: Object.assign(new Error('spawnSync bun ETIMEDOUT'), { code: 'ETIMEDOUT' }),
    pid: 4242,
    output: [null, '', ''],
  };
}

describe('release.ts runCaptured — timeout observability (B3 review fix)', () => {
  let checkoutDir: string;
  let releasesRoot: string;

  beforeEach(() => {
    vi.clearAllMocks();
    checkoutDir = mkdtempSync(join(tmpdir(), 'release-timeout-checkout-'));
    releasesRoot = mkdtempSync(join(tmpdir(), 'release-timeout-releases-'));
    mkdirSync(join(checkoutDir, 'dist', 'cli'), { recursive: true });
    mkdirSync(join(checkoutDir, 'migrations'), { recursive: true });
    writeFileSync(join(checkoutDir, 'dist', 'cli', 'index.js'), 'console.log("9.9.9");\n', 'utf8');
    writeFileSync(join(checkoutDir, 'migrations', '001-init.sql'), 'CREATE TABLE t (id INTEGER);\n', 'utf8');
    writeFileSync(
      join(checkoutDir, 'package.json'),
      JSON.stringify({ name: 'release-timeout-fixture', version: '9.9.9', private: true }),
      'utf8',
    );
    writeFileSync(join(checkoutDir, 'bun.lock'), '{}\n', 'utf8');
  });

  afterEach(() => {
    rmSync(checkoutDir, { recursive: true, force: true });
    rmSync(releasesRoot, { recursive: true, force: true });
  });

  it('a bun-install timeout-kill throws a DISTINGUISHABLE error naming both ETIMEDOUT and the timeout, not a bare/silent failure', () => {
    spawnSyncMock.mockReturnValue(timeoutKillResult());

    let caught: Error | undefined;
    try {
      materializeRelease({ checkoutDir, releasesRoot });
    } catch (err) {
      caught = err as Error;
    }

    expect(caught).toBeDefined();
    const msg = caught!.message;
    // Must never be a bare "failed (exit 1)" with empty stdout/stderr — that
    // would be indistinguishable from bun genuinely rejecting the install
    // for a real dependency reason. The distinguishing note must be present.
    expect(msg).toMatch(/ETIMEDOUT/);
    expect(msg).toMatch(/signal SIGTERM/);
    expect(msg).toMatch(/timeout/i);
  });

  it('spawnSync is actually invoked with the bun-install timeout, not left at a default', () => {
    spawnSyncMock.mockReturnValue(timeoutKillResult());

    expect(() => materializeRelease({ checkoutDir, releasesRoot })).toThrow();

    expect(spawnSyncMock).toHaveBeenCalled();
    const [cmd, args, opts] = spawnSyncMock.mock.calls[0]! as [string, string[], { timeout?: number }];
    expect(cmd).toBe('bun');
    expect(args).toContain('install');
    // bun install is I/O-bound (network/cache), not the cold-shell class —
    // it gets minutes, not the 15s git/boot-verify bound.
    expect(opts.timeout).toBeGreaterThanOrEqual(60_000);
  });
});
