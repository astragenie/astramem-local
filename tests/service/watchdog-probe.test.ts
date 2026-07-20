/**
 * tests/service/watchdog-probe.test.ts (FEAT-443 SLICE-2 + issue #206 +
 * 2026-07-20 boot-grace crash-loop fix)
 *
 * runWatchdogProbe never touches a real daemon, PID, or disk — the health
 * check, the recovery kill, the persisted watchdog state, and the
 * daemon.lock reader are all injectable seams (fetchImpl, stopLockHolderImpl,
 * readStateImpl/writeStateImpl, readLockInfoImpl), and the "restart" step is
 * a mock ServiceAdapter. hasWatchdogTimer is exercised against both a
 * real-shaped adapter and the plain-object mocks used elsewhere in this
 * suite (e.g. tests/service/install-flow.test.ts) to confirm the duck-typing
 * guard degrades safely instead of throwing when the two extra methods are
 * absent.
 *
 * Most tests below don't inject `readLockInfoImpl` at all — the default
 * `readLockInfo` then tries (and fails, ENOENT) to read a real
 * `daemon.lock` under the fake `/tmp/astra-data` dataDir, which harmlessly
 * resolves to `null` (no lock => no instance-change reset). Tests that
 * exercise the boot-grace / instance-identity logic directly inject a
 * `LockInfo` via `makeLock` instead.
 */
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runWatchdogProbe,
  hasWatchdogTimer,
  WATCHDOG_PROBE_INTERVAL_SEC,
  DEFAULT_PROBE_TIMEOUT_MS,
  DEFAULT_FAILURE_THRESHOLD,
  BOOT_HARD_CAP_SEC,
  type WatchdogState,
} from '../../src/service/watchdog-probe.js';
import type { ServiceAdapter } from '../../src/service/types.js';
import type { LockInfo } from '../../src/service/instance-lock.js';

function makePlainAdapter(overrides: Partial<ServiceAdapter> = {}): ServiceAdapter {
  return {
    platform: 'linux',
    install: vi.fn(async () => ({ kind: 'task' as const })),
    uninstall: vi.fn(async () => {}),
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    status: vi.fn(async () => ({ installed: true, running: true })),
    installBackupTimer: vi.fn(async () => {}),
    uninstallBackupTimer: vi.fn(async () => {}),
    ...overrides,
  };
}

/** In-memory watchdog-state store standing in for the on-disk JSON state
 *  file — lets tests exercise the consecutive-failure counter AND the
 *  per-instance identity/boot-grace fields across multiple runWatchdogProbe
 *  calls (simulating multiple scheduler ticks) without touching a real
 *  dataDir. `everHealthyThisInstance: true` by default — most of the tests
 *  below pre-date the boot-grace fix and model a daemon that was already
 *  confirmed healthy at some point, so this keeps their "kills after
 *  threshold" behavior preserved; boot-grace-specific tests override it. */
function makeState(initial: Partial<WatchdogState> = {}) {
  let state: WatchdogState = {
    consecutiveFailures: 0,
    instanceKey: null,
    everHealthyThisInstance: true,
    ...initial,
  };
  return {
    readStateImpl: vi.fn(() => state),
    writeStateImpl: vi.fn((_dataDir: string, next: WatchdogState) => { state = next; }),
    get value() { return state.consecutiveFailures; },
    get state() { return state; },
  };
}

/** Fixed `daemon.lock` stand-in for tests exercising instance identity /
 *  boot-grace — `readLockInfoImpl` returns this on every call unless the
 *  test swaps it out mid-sequence. */
function makeLock(overrides: Partial<LockInfo> = {}): LockInfo {
  return { pid: 4242, startedAt: '2026-07-20T00:00:00.000Z', port: 7777, version: '1.0.0', ...overrides };
}

describe('hasWatchdogTimer', () => {
  it('returns false for a plain ServiceAdapter mock without the extra methods', () => {
    expect(hasWatchdogTimer(makePlainAdapter())).toBe(false);
  });

  it('returns true once both installWatchdogTimer and uninstallWatchdogTimer are present', () => {
    const adapter = makePlainAdapter({
      installWatchdogTimer: vi.fn(async () => {}),
      uninstallWatchdogTimer: vi.fn(async () => {}),
    } as Partial<ServiceAdapter>);
    expect(hasWatchdogTimer(adapter)).toBe(true);
  });

  it('returns false when only one of the two methods is present', () => {
    const adapter = makePlainAdapter({
      installWatchdogTimer: vi.fn(async () => {}),
    } as Partial<ServiceAdapter>);
    expect(hasWatchdogTimer(adapter)).toBe(false);
  });
});

describe('runWatchdogProbe', () => {
  const dataDir = '/tmp/astra-data';
  const port = 7777;

  it('reports healthy and takes no action when /health responds ok', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch;
    const stopLockHolderImpl = vi.fn(async () => ({ ok: true, detail: 'should not be called' }));
    const adapter = makePlainAdapter();
    const state = makeState({ everHealthyThisInstance: false });

    const result = await runWatchdogProbe({ port, dataDir, adapter, fetchImpl, stopLockHolderImpl, ...state });

    expect(result.healthy).toBe(true);
    expect(result.action).toBe('none');
    expect(stopLockHolderImpl).not.toHaveBeenCalled();
    expect(adapter.start).not.toHaveBeenCalled();
    expect(state.value).toBe(0);
    // A healthy answer marks this instance as having been healthy at least
    // once — the boot-grace gate for any FUTURE hang on this same instance.
    expect(state.state.everHealthyThisInstance).toBe(true);
  });

  it('a single failure stays below DEFAULT_FAILURE_THRESHOLD and takes no action (AC-4 / AC-3)', async () => {
    // One anomalous probe (GC pause, transient network hiccup, a request
    // that straddles the timeout boundary) must not kill a healthy daemon.
    const fetchImpl = vi.fn(async () => { throw new Error('timeout'); }) as unknown as typeof fetch;
    const stopLockHolderImpl = vi.fn(async () => ({ ok: true, detail: 'stopped pid 42' }));
    const adapter = makePlainAdapter();
    const state = makeState();

    const result = await runWatchdogProbe({ port, dataDir, adapter, fetchImpl, stopLockHolderImpl, ...state });

    expect(result.healthy).toBe(false);
    expect(result.action).toBe('below-threshold');
    expect(result.detail).toContain('1/2');
    expect(stopLockHolderImpl).not.toHaveBeenCalled();
    expect(adapter.start).not.toHaveBeenCalled();
    expect(state.value).toBe(1);
  });

  it('a single healthy probe resets an in-progress failure streak back to 0', async () => {
    const state = makeState({ consecutiveFailures: 1 }); // one prior failure already recorded
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch;

    const result = await runWatchdogProbe({ port, dataDir, adapter: makePlainAdapter(), fetchImpl, ...state });

    expect(result.healthy).toBe(true);
    expect(state.value).toBe(0);
  });

  it('was-healthy-then-hung kills the lock holder and restarts via the adapter once DEFAULT_FAILURE_THRESHOLD consecutive failures are reached (preserve existing behavior)', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('AbortError: timeout'); }) as unknown as typeof fetch;
    const stopLockHolderImpl = vi.fn(async () => ({ ok: true, detail: 'stopped pid 42' }));
    const adapter = makePlainAdapter();
    // everHealthyThisInstance: true — this instance already answered /health
    // at some point before this test's probe sequence begins (the boot-grace
    // gate's precondition for ever treating consecutive failures as a hang).
    const state = makeState({ everHealthyThisInstance: true });

    const first = await runWatchdogProbe({ port, dataDir, adapter, fetchImpl, stopLockHolderImpl, ...state });
    expect(first.action).toBe('below-threshold');
    expect(stopLockHolderImpl).not.toHaveBeenCalled();

    const second = await runWatchdogProbe({ port, dataDir, adapter, fetchImpl, stopLockHolderImpl, ...state });
    expect(second.healthy).toBe(false);
    expect(second.action).toBe('restarted');
    expect(second.detail).toContain('stopped pid 42');
    expect(second.detail).toContain('linux');
    expect(stopLockHolderImpl).toHaveBeenCalledWith(dataDir, port);
    expect(adapter.start).toHaveBeenCalledOnce();
    // A successful restart resets the streak — a fresh problem starts a
    // fresh count instead of acting again on the very next healthy tick.
    expect(state.value).toBe(0);
  });

  it('acts immediately (no extra below-threshold wait) on a wedged win32 daemon once threshold is met', async () => {
    // Regression coverage for issue #206 AC-6: alive, lock-holding, /health
    // unresponsive — must be detected and killed on the win32 adapter same
    // as linux/darwin.
    const fetchImpl = vi.fn(async () => { throw new Error('AbortError: timeout'); }) as unknown as typeof fetch;
    const stopLockHolderImpl = vi.fn(async () => ({ ok: true, detail: 'stopped pid 39236' }));
    const adapter = makePlainAdapter({ platform: 'win32' });
    // already one short of threshold, and already confirmed healthy once
    const state = makeState({ consecutiveFailures: DEFAULT_FAILURE_THRESHOLD - 1, everHealthyThisInstance: true });

    const result = await runWatchdogProbe({ port, dataDir, adapter, fetchImpl, stopLockHolderImpl, ...state });

    expect(result.healthy).toBe(false);
    expect(result.action).toBe('restarted');
    expect(result.detail).toContain('stopped pid 39236');
    expect(result.detail).toContain('win32');
    expect(stopLockHolderImpl).toHaveBeenCalledWith(dataDir, port);
    expect(adapter.start).toHaveBeenCalledOnce();
  });

  it('never kills a healthy win32 daemon, even one that is merely slow (AC-3 negative case)', async () => {
    // /dashboard cold-renders in ~7.9s on a box with 15k+ memories because
    // better-sqlite3 is synchronous and blocks the event loop; DEFAULT_PROBE_TIMEOUT_MS
    // (10s) must comfortably outlast that so a busy-but-healthy daemon is
    // never mistaken for a hang.
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch;
    const stopLockHolderImpl = vi.fn(async () => ({ ok: true, detail: 'should not be called' }));
    const adapter = makePlainAdapter({ platform: 'win32' });
    const state = makeState();

    const result = await runWatchdogProbe({ port, dataDir, adapter, fetchImpl, stopLockHolderImpl, ...state });

    expect(result.healthy).toBe(true);
    expect(result.action).toBe('none');
    expect(stopLockHolderImpl).not.toHaveBeenCalled();
    expect(adapter.start).not.toHaveBeenCalled();
  });

  it('reports healthy=false with action=restarted (after threshold) when /health responds non-2xx', async () => {
    // A non-ok status still counts as "no answer" for recovery purposes —
    // confirm it actually triggers the restart path rather than being
    // silently treated as healthy.
    const fetchImpl = vi.fn(async () => new Response(null, { status: 503 })) as unknown as typeof fetch;
    const stopLockHolderImpl = vi.fn(async () => ({ ok: true, detail: 'stopped pid 123' }));
    const adapter = makePlainAdapter();
    const state = makeState({ consecutiveFailures: DEFAULT_FAILURE_THRESHOLD - 1, everHealthyThisInstance: true });

    const result = await runWatchdogProbe({ port, dataDir, adapter, fetchImpl, stopLockHolderImpl, ...state });

    expect(result.healthy).toBe(false);
    expect(result.action).toBe('restarted');
    expect(stopLockHolderImpl).toHaveBeenCalledWith(dataDir, port);
    expect(adapter.start).toHaveBeenCalledOnce();
  });

  it('respects a custom failureThreshold', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('timeout'); }) as unknown as typeof fetch;
    const stopLockHolderImpl = vi.fn(async () => ({ ok: true, detail: 'stopped pid 1' }));
    const adapter = makePlainAdapter();
    const state = makeState({ everHealthyThisInstance: true });

    const r1 = await runWatchdogProbe({ port, dataDir, adapter, fetchImpl, stopLockHolderImpl, failureThreshold: 3, ...state });
    expect(r1.action).toBe('below-threshold');
    const r2 = await runWatchdogProbe({ port, dataDir, adapter, fetchImpl, stopLockHolderImpl, failureThreshold: 3, ...state });
    expect(r2.action).toBe('below-threshold');
    const r3 = await runWatchdogProbe({ port, dataDir, adapter, fetchImpl, stopLockHolderImpl, failureThreshold: 3, ...state });
    expect(r3.action).toBe('restarted');
  });

  it('reports restart-failed and does NOT call adapter.start() when stopLockHolder fails to stop the hung process', async () => {
    // stopLockHolder never throws on failure (instance-lock.ts) — it returns
    // ok:false when the SIGTERM'd PID is still serving after its wait budget
    // (e.g. the daemon's own event loop is too wedged to process the
    // signal). Regression coverage for a real bug caught in review: the
    // probe used to ignore stopResult.ok entirely and unconditionally call
    // adapter.start(), which on systemd is a silent no-op against an
    // already-"active" unit — reporting a false 'restarted' while the daemon
    // stayed hung.
    const fetchImpl = vi.fn(async () => { throw new Error('timeout'); }) as unknown as typeof fetch;
    const stopLockHolderImpl = vi.fn(async () => ({ ok: false, detail: 'pid 42 still serving after 5000ms' }));
    const adapter = makePlainAdapter();
    const state = makeState({ consecutiveFailures: DEFAULT_FAILURE_THRESHOLD - 1, everHealthyThisInstance: true });

    const result = await runWatchdogProbe({ port, dataDir, adapter, fetchImpl, stopLockHolderImpl, ...state });

    expect(result.healthy).toBe(false);
    expect(result.action).toBe('restart-failed');
    expect(result.detail).toContain('pid 42 still serving after 5000ms');
    expect(result.detail).toContain('NOT restarted');
    expect(adapter.start).not.toHaveBeenCalled();
    // Still wedged — stays at/above threshold so the very next tick retries
    // immediately instead of waiting through another below-threshold run.
    expect(state.value).toBeGreaterThanOrEqual(DEFAULT_FAILURE_THRESHOLD);
  });

  it('reports restart-failed (never throws) when adapter.start() itself fails after a successful stop', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('timeout'); }) as unknown as typeof fetch;
    const stopLockHolderImpl = vi.fn(async () => ({ ok: true, detail: 'stopped pid 42' }));
    const adapter = makePlainAdapter({
      start: vi.fn(async () => { throw new Error('systemctl start failed: unit not found'); }),
    });
    const state = makeState({ consecutiveFailures: DEFAULT_FAILURE_THRESHOLD - 1, everHealthyThisInstance: true });

    const result = await runWatchdogProbe({ port, dataDir, adapter, fetchImpl, stopLockHolderImpl, ...state });

    expect(result.healthy).toBe(false);
    expect(result.action).toBe('restart-failed');
    expect(result.detail).toContain('systemctl start failed');
    expect(adapter.start).toHaveBeenCalledOnce();
  });

  it('respects a custom timeoutMs and passes it to fetchImpl as an AbortSignal', async () => {
    let capturedSignal: AbortSignal | undefined;
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedSignal = init?.signal as AbortSignal;
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;

    await runWatchdogProbe({ port, dataDir, adapter: makePlainAdapter(), fetchImpl, timeoutMs: 5000 });

    expect(capturedSignal).toBeInstanceOf(AbortSignal);
  });

  it('defaults to DEFAULT_PROBE_TIMEOUT_MS when timeoutMs is omitted', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch;
    const result = await runWatchdogProbe({ port, dataDir, adapter: makePlainAdapter(), fetchImpl });
    expect(result.detail).toContain(String(DEFAULT_PROBE_TIMEOUT_MS));
  });

  it('falls back to a fresh (0) failure count when the state store is unreadable/corrupt', async () => {
    // No injected state at all — exercises the real on-disk
    // readWatchdogState/writeWatchdogState against a dataDir that doesn't
    // exist. A corrupt/absent state file must read as a fresh start, never
    // throw, and never be treated as "already at threshold".
    const fetchImpl = vi.fn(async () => { throw new Error('timeout'); }) as unknown as typeof fetch;
    const stopLockHolderImpl = vi.fn(async () => ({ ok: true, detail: 'stopped pid 1' }));
    const result = await runWatchdogProbe({
      port,
      dataDir: '/nonexistent/astra-data-dir-for-test',
      adapter: makePlainAdapter(),
      fetchImpl,
      stopLockHolderImpl,
    });
    expect(result.action).toBe('below-threshold');
    expect(stopLockHolderImpl).not.toHaveBeenCalled();
  });
});

describe('boot-grace (2026-07-20 crash-loop fix)', () => {
  const dataDir = '/tmp/astra-data';
  const port = 7777;

  it('never-healthy slow boot (below hard cap) does NOT kill, even past the failure threshold', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    const stopLockHolderImpl = vi.fn(async () => ({ ok: true, detail: 'should never be called' }));
    const adapter = makePlainAdapter();
    const state = makeState({ everHealthyThisInstance: false });
    // Lock recorded 6 minutes ago — a plausible slow boot on a large DB
    // (573MB SQLCipher observed ~6-8min to bind), comfortably below the
    // 20-minute hard cap.
    const nowMs = Date.parse('2026-07-20T00:06:00.000Z');
    const lock = makeLock({ startedAt: '2026-07-20T00:00:00.000Z' });
    const readLockInfoImpl = vi.fn(() => lock);

    const first = await runWatchdogProbe({ port, dataDir, adapter, fetchImpl, stopLockHolderImpl, readLockInfoImpl, nowMs, ...state });
    expect(first.action).toBe('below-threshold');

    const second = await runWatchdogProbe({ port, dataDir, adapter, fetchImpl, stopLockHolderImpl, readLockInfoImpl, nowMs, ...state });
    expect(second.healthy).toBe(false);
    expect(second.action).toBe('still-booting');
    expect(second.detail).toContain('still booting');
    expect(stopLockHolderImpl).not.toHaveBeenCalled();
    expect(adapter.start).not.toHaveBeenCalled();
  });

  it('never-healthy past the hard cap kills once (safety valve)', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    const stopLockHolderImpl = vi.fn(async () => ({ ok: true, detail: 'stopped pid 9001' }));
    const adapter = makePlainAdapter();
    // Lock recorded well past BOOT_HARD_CAP_SEC ago — genuinely stuck, not
    // merely slow.
    const startedAt = '2026-07-20T00:00:00.000Z';
    const lock = makeLock({ startedAt });
    const nowMs = Date.parse(startedAt) + (BOOT_HARD_CAP_SEC + 60) * 1000;
    const readLockInfoImpl = vi.fn(() => lock);
    // Already at threshold-1 failures, never healthy, already recorded
    // against THIS instance (matching instanceKey) — no instance-change
    // reset should fire on this tick.
    const state = makeState({
      consecutiveFailures: DEFAULT_FAILURE_THRESHOLD - 1,
      instanceKey: `${lock.pid}:${lock.startedAt}`,
      everHealthyThisInstance: false,
    });

    const result = await runWatchdogProbe({ port, dataDir, adapter, fetchImpl, stopLockHolderImpl, readLockInfoImpl, nowMs, ...state });

    expect(result.healthy).toBe(false);
    expect(result.action).toBe('restarted');
    expect(result.detail).toContain('stopped pid 9001');
    expect(result.detail).toContain('boot hard-cap exceeded');
    expect(stopLockHolderImpl).toHaveBeenCalledWith(dataDir, port);
    expect(adapter.start).toHaveBeenCalledOnce();
  });

  it('a fresh lock (below hard cap) does not trip the safety valve even with a custom bootHardCapMs', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    const stopLockHolderImpl = vi.fn(async () => ({ ok: true, detail: 'should never be called' }));
    const adapter = makePlainAdapter();
    const startedAt = '2026-07-20T00:00:00.000Z';
    const lock = makeLock({ startedAt });
    const nowMs = Date.parse(startedAt) + 1000; // 1s alive
    const readLockInfoImpl = vi.fn(() => lock);
    const state = makeState({
      consecutiveFailures: DEFAULT_FAILURE_THRESHOLD - 1,
      instanceKey: `${lock.pid}:${lock.startedAt}`,
      everHealthyThisInstance: false,
    });

    const result = await runWatchdogProbe({
      port, dataDir, adapter, fetchImpl, stopLockHolderImpl, readLockInfoImpl, nowMs,
      bootHardCapMs: 5000, // tiny override — still not exceeded at 1s alive
      ...state,
    });

    expect(result.action).toBe('still-booting');
    expect(stopLockHolderImpl).not.toHaveBeenCalled();
  });

  it('new instance detected (lock pid/startedAt changed) resets everHealthy + failure count', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    const stopLockHolderImpl = vi.fn(async () => ({ ok: true, detail: 'should never be called' }));
    const adapter = makePlainAdapter();
    const oldLock = makeLock({ pid: 111, startedAt: '2026-07-19T00:00:00.000Z' });
    // Pre-existing state: was healthy, one failure shy of the kill threshold
    // — WITHOUT the reset below, the very next failing probe would reach
    // threshold and kill.
    const state = makeState({
      consecutiveFailures: DEFAULT_FAILURE_THRESHOLD - 1,
      instanceKey: `${oldLock.pid}:${oldLock.startedAt}`,
      everHealthyThisInstance: true,
    });
    // This tick observes a DIFFERENT pid/startedAt — the watchdog (or
    // schtasks/systemd) already restarted the daemon since the last tick.
    const newLock = makeLock({ pid: 222, startedAt: '2026-07-20T00:00:00.000Z' });
    const nowMs = Date.parse(newLock.startedAt) + 1000; // 1s into the new instance's life
    const readLockInfoImpl = vi.fn(() => newLock);

    const result = await runWatchdogProbe({ port, dataDir, adapter, fetchImpl, stopLockHolderImpl, readLockInfoImpl, nowMs, ...state });

    // Reset happened: consecutiveFailures went 0 -> 1 this tick (below the
    // threshold of 2), not the pre-reset value of 2 which would have killed.
    expect(result.action).toBe('below-threshold');
    expect(stopLockHolderImpl).not.toHaveBeenCalled();
    expect(adapter.start).not.toHaveBeenCalled();
    expect(state.state.everHealthyThisInstance).toBe(false);
    expect(state.state.instanceKey).toBe(`${newLock.pid}:${newLock.startedAt}`);
    expect(state.value).toBe(1);
  });

  it('upgrades a legacy on-disk state file (pre-boot-grace shape, real file IO) without an immediate kill', async () => {
    // Exercises the REAL readWatchdogState/writeWatchdogState against an
    // actual watchdog-probe-state.json on disk — every other test in this
    // file injects readStateImpl/writeStateImpl and never touches the parser
    // at all. This is the exact file every real prod upgrade hits on its
    // first post-upgrade tick: a state file written by the PRE-2026-07-20
    // binary, containing only `{consecutiveFailures}`, no `instanceKey`, no
    // `everHealthyThisInstance`.
    const dir = mkdtempSync(join(tmpdir(), 'astramem-watchdog-legacy-state-'));
    try {
      const statePath = join(dir, 'watchdog-probe-state.json');
      // Legacy shape — a real prior boot had already reached the old
      // failure threshold (2) right before the binary was upgraded.
      writeFileSync(statePath, JSON.stringify({ consecutiveFailures: 2 }));

      const fetchImpl = vi.fn(async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
      const stopLockHolderImpl = vi.fn(async () => ({ ok: true, detail: 'should never be called' }));
      const adapter = makePlainAdapter();
      // A live lock for the CURRENT (post-upgrade) daemon instance, just
      // started — not yet proven healthy.
      const lock = makeLock({ pid: 5150, startedAt: new Date().toISOString() });
      const readLockInfoImpl = vi.fn(() => lock);

      // failureThreshold: 1 forces this tick's single failure to reach
      // threshold immediately, so the run either kills (bug) or hits the
      // boot-grace still-booting gate (fix) — no second tick needed to prove
      // which one happened.
      const result = await runWatchdogProbe({
        port, dataDir: dir, adapter, fetchImpl, stopLockHolderImpl, readLockInfoImpl,
        failureThreshold: 1,
      });

      // 1. readWatchdogState parsed the legacy shape without throwing (the
      //    call above would have rejected/thrown otherwise) and defaulted
      //    the missing fields (instanceKey -> null, everHealthyThisInstance
      //    -> false).
      // 2. The legacy consecutiveFailures:2 did NOT cause an immediate kill
      //    of the current, not-yet-proven-healthy instance: the missing
      //    instanceKey (null) differs from the live lock's key, so the
      //    instance-change branch reset the streak to 0 before this tick's
      //    failure incremented it to 1 — and even having reached threshold,
      //    the defaulted everHealthyThisInstance:false routes it through the
      //    boot-grace gate instead of the kill path.
      expect(result.healthy).toBe(false);
      expect(result.action).toBe('still-booting');
      expect(stopLockHolderImpl).not.toHaveBeenCalled();
      expect(adapter.start).not.toHaveBeenCalled();

      // 3. The persisted file was rewritten to the new shape, keyed to the
      //    CURRENT instance.
      const persisted = JSON.parse(readFileSync(statePath, 'utf8')) as Partial<WatchdogState>;
      expect(persisted.instanceKey).toBe(`${lock.pid}:${lock.startedAt}`);
      expect(persisted.everHealthyThisInstance).toBe(false);
      expect(persisted.consecutiveFailures).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('WATCHDOG_PROBE_INTERVAL_SEC', () => {
  it('stays comfortably under the 5-minute Windows PT5M keepalive bound this mirrors', () => {
    expect(WATCHDOG_PROBE_INTERVAL_SEC).toBeLessThan(300);
    expect(WATCHDOG_PROBE_INTERVAL_SEC).toBeGreaterThan(0);
  });
});

describe('DEFAULT_FAILURE_THRESHOLD', () => {
  it('requires more than one failure before acting (AC-4)', () => {
    expect(DEFAULT_FAILURE_THRESHOLD).toBeGreaterThan(1);
  });
});

describe('BOOT_HARD_CAP_SEC', () => {
  it('is generous enough to cover a several-minute slow boot on a large DB', () => {
    // Observed worst-case: ~6-8min for a 573MB SQLCipher DB under disk
    // contention. The cap must sit comfortably above that.
    expect(BOOT_HARD_CAP_SEC).toBeGreaterThanOrEqual(15 * 60);
  });
});

describe('restart-storm circuit breaker (P1.1)', () => {
  const dataDir = '/tmp/astra-data';
  const port = 7777;
  const failingFetch = vi.fn(async () => { throw new Error('timeout'); }) as unknown as typeof fetch;

  /** In-memory kill log standing in for watchdog-kills.jsonl. */
  function makeKillLog(initial: number[] = []) {
    const kills = [...initial];
    return {
      // Optional params mirror readKillsInWindow's real signature — the
      // probe always passes both, so the defaults are never exercised here.
      readKillsInWindowImpl: vi.fn((_dataDir: string, nowMs: number = NOW, windowMs: number = 6 * HOUR) =>
        kills.filter(ms => nowMs - ms <= windowMs && ms <= nowMs)),
      appendKillEventImpl: vi.fn(() => { kills.push(NOW); }),
      kills,
    };
  }
  const NOW = 1_784_000_000_000;
  const HOUR = 3_600_000;

  it('skips the kill and reports breaker-tripped when the window already holds threshold kills', async () => {
    const killLog = makeKillLog([NOW - 5 * HOUR, NOW - 3 * HOUR, NOW - 1 * HOUR]);
    const stopLockHolderImpl = vi.fn(async () => ({ ok: true, detail: 'should never be called' }));
    const adapter = makePlainAdapter();
    const state = makeState({ consecutiveFailures: 1, everHealthyThisInstance: true }); // one prior failure — this tick reaches threshold

    const result = await runWatchdogProbe({
      port, dataDir, adapter, fetchImpl: failingFetch, stopLockHolderImpl,
      ...state, ...killLog, nowMs: NOW,
    });

    expect(result.healthy).toBe(false);
    expect(result.action).toBe('breaker-tripped');
    expect(result.detail).toContain('3 watchdog kill(s)');
    expect(stopLockHolderImpl).not.toHaveBeenCalled();
    expect(adapter.start).not.toHaveBeenCalled();
    // Failure count is retained, not reset — /health is still failing and
    // the breaker must not mask that.
    expect(state.value).toBe(2);
  });

  it('kills that aged out of the 6h window do not count — the breaker self-clears', async () => {
    const killLog = makeKillLog([NOW - 7 * HOUR, NOW - 6.5 * HOUR, NOW - 1 * HOUR]); // only 1 in window
    const stopLockHolderImpl = vi.fn(async () => ({ ok: true, detail: 'stopped pid 42' }));
    const adapter = makePlainAdapter();
    const state = makeState({ consecutiveFailures: 1, everHealthyThisInstance: true });

    const result = await runWatchdogProbe({
      port, dataDir, adapter, fetchImpl: failingFetch, stopLockHolderImpl,
      ...state, ...killLog, nowMs: NOW,
    });

    expect(result.action).toBe('restarted');
    expect(stopLockHolderImpl).toHaveBeenCalledOnce();
  });

  it('records a kill event exactly when the stop succeeds, so successive storms trip the breaker', async () => {
    const killLog = makeKillLog([NOW - 4 * HOUR, NOW - 2 * HOUR]); // 2 kills — one below trip
    const stopLockHolderImpl = vi.fn(async () => ({ ok: true, detail: 'stopped pid 42' }));
    const adapter = makePlainAdapter();
    const state = makeState({ consecutiveFailures: 1, everHealthyThisInstance: true });

    const third = await runWatchdogProbe({
      port, dataDir, adapter, fetchImpl: failingFetch, stopLockHolderImpl,
      ...state, ...killLog, nowMs: NOW,
    });
    expect(third.action).toBe('restarted');
    expect(killLog.appendKillEventImpl).toHaveBeenCalledOnce();

    // Daemon fails again after that third kill: breaker must now be open.
    const state2 = makeState({ consecutiveFailures: 1, everHealthyThisInstance: true });
    const fourth = await runWatchdogProbe({
      port, dataDir, adapter, fetchImpl: failingFetch, stopLockHolderImpl,
      ...state2, ...killLog, nowMs: NOW,
    });
    expect(fourth.action).toBe('breaker-tripped');
    expect(stopLockHolderImpl).toHaveBeenCalledOnce(); // still just the one real kill
  });

  it('does NOT record a kill event when the stop fails (nothing died)', async () => {
    const killLog = makeKillLog([]);
    const stopLockHolderImpl = vi.fn(async () => ({ ok: false, detail: 'could not verify lock holder' }));
    const state = makeState({ consecutiveFailures: 1, everHealthyThisInstance: true });

    const result = await runWatchdogProbe({
      port, dataDir, adapter: makePlainAdapter(), fetchImpl: failingFetch, stopLockHolderImpl,
      ...state, ...killLog, nowMs: NOW,
    });

    expect(result.action).toBe('restart-failed');
    expect(killLog.appendKillEventImpl).not.toHaveBeenCalled();
  });

  it('breaker never engages below the failure threshold (a first failure is not consulted against the kill log)', async () => {
    const killLog = makeKillLog([NOW - 1 * HOUR, NOW - 2 * HOUR, NOW - 3 * HOUR]);
    const state = makeState({ consecutiveFailures: 0 });

    const result = await runWatchdogProbe({
      port, dataDir, adapter: makePlainAdapter(), fetchImpl: failingFetch,
      stopLockHolderImpl: vi.fn(async () => ({ ok: true, detail: 'x' })),
      ...state, ...killLog, nowMs: NOW,
    });

    expect(result.action).toBe('below-threshold');
  });
});
