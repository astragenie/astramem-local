/**
 * tests/service/watchdog-probe.test.ts (FEAT-443 SLICE-2 + issue #206)
 *
 * runWatchdogProbe never touches a real daemon, PID, or disk — the health
 * check, the recovery kill, and the consecutive-failure counter are all
 * injectable seams (fetchImpl, stopLockHolderImpl, readFailureCountImpl /
 * writeFailureCountImpl), and the "restart" step is a mock ServiceAdapter.
 * hasWatchdogTimer is exercised against both a real-shaped adapter and the
 * plain-object mocks used elsewhere in this suite (e.g.
 * tests/service/install-flow.test.ts) to confirm the duck-typing guard
 * degrades safely instead of throwing when the two extra methods are absent.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  runWatchdogProbe,
  hasWatchdogTimer,
  WATCHDOG_PROBE_INTERVAL_SEC,
  DEFAULT_PROBE_TIMEOUT_MS,
  DEFAULT_FAILURE_THRESHOLD,
} from '../../src/service/watchdog-probe.js';
import type { ServiceAdapter } from '../../src/service/types.js';

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

/** In-memory failure-count store standing in for the on-disk JSON state
 *  file — lets tests exercise the consecutive-failure counter across
 *  multiple runWatchdogProbe calls (simulating multiple scheduler ticks)
 *  without touching a real dataDir. */
function makeCounter(initial = 0) {
  let count = initial;
  return {
    readFailureCountImpl: vi.fn(() => count),
    writeFailureCountImpl: vi.fn((_dataDir: string, next: number) => { count = next; }),
    get value() { return count; },
  };
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
    const counter = makeCounter();

    const result = await runWatchdogProbe({ port, dataDir, adapter, fetchImpl, stopLockHolderImpl, ...counter });

    expect(result.healthy).toBe(true);
    expect(result.action).toBe('none');
    expect(stopLockHolderImpl).not.toHaveBeenCalled();
    expect(adapter.start).not.toHaveBeenCalled();
    expect(counter.value).toBe(0);
  });

  it('a single failure stays below DEFAULT_FAILURE_THRESHOLD and takes no action (AC-4 / AC-3)', async () => {
    // One anomalous probe (GC pause, transient network hiccup, a request
    // that straddles the timeout boundary) must not kill a healthy daemon.
    const fetchImpl = vi.fn(async () => { throw new Error('timeout'); }) as unknown as typeof fetch;
    const stopLockHolderImpl = vi.fn(async () => ({ ok: true, detail: 'stopped pid 42' }));
    const adapter = makePlainAdapter();
    const counter = makeCounter();

    const result = await runWatchdogProbe({ port, dataDir, adapter, fetchImpl, stopLockHolderImpl, ...counter });

    expect(result.healthy).toBe(false);
    expect(result.action).toBe('below-threshold');
    expect(result.detail).toContain('1/2');
    expect(stopLockHolderImpl).not.toHaveBeenCalled();
    expect(adapter.start).not.toHaveBeenCalled();
    expect(counter.value).toBe(1);
  });

  it('a single healthy probe resets an in-progress failure streak back to 0', async () => {
    const counter = makeCounter(1); // one prior failure already recorded
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch;

    const result = await runWatchdogProbe({ port, dataDir, adapter: makePlainAdapter(), fetchImpl, ...counter });

    expect(result.healthy).toBe(true);
    expect(counter.value).toBe(0);
  });

  it('kills the lock holder and restarts via the adapter once DEFAULT_FAILURE_THRESHOLD consecutive failures are reached', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('AbortError: timeout'); }) as unknown as typeof fetch;
    const stopLockHolderImpl = vi.fn(async () => ({ ok: true, detail: 'stopped pid 42' }));
    const adapter = makePlainAdapter();
    const counter = makeCounter();

    const first = await runWatchdogProbe({ port, dataDir, adapter, fetchImpl, stopLockHolderImpl, ...counter });
    expect(first.action).toBe('below-threshold');
    expect(stopLockHolderImpl).not.toHaveBeenCalled();

    const second = await runWatchdogProbe({ port, dataDir, adapter, fetchImpl, stopLockHolderImpl, ...counter });
    expect(second.healthy).toBe(false);
    expect(second.action).toBe('restarted');
    expect(second.detail).toContain('stopped pid 42');
    expect(second.detail).toContain('linux');
    expect(stopLockHolderImpl).toHaveBeenCalledWith(dataDir, port);
    expect(adapter.start).toHaveBeenCalledOnce();
    // A successful restart resets the streak — a fresh problem starts a
    // fresh count instead of acting again on the very next healthy tick.
    expect(counter.value).toBe(0);
  });

  it('acts immediately (no extra below-threshold wait) on a wedged win32 daemon once threshold is met', async () => {
    // Regression coverage for issue #206 AC-6: alive, lock-holding, /health
    // unresponsive — must be detected and killed on the win32 adapter same
    // as linux/darwin.
    const fetchImpl = vi.fn(async () => { throw new Error('AbortError: timeout'); }) as unknown as typeof fetch;
    const stopLockHolderImpl = vi.fn(async () => ({ ok: true, detail: 'stopped pid 39236' }));
    const adapter = makePlainAdapter({ platform: 'win32' });
    const counter = makeCounter(DEFAULT_FAILURE_THRESHOLD - 1); // already one short of threshold

    const result = await runWatchdogProbe({ port, dataDir, adapter, fetchImpl, stopLockHolderImpl, ...counter });

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
    const counter = makeCounter();

    const result = await runWatchdogProbe({ port, dataDir, adapter, fetchImpl, stopLockHolderImpl, ...counter });

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
    const counter = makeCounter(DEFAULT_FAILURE_THRESHOLD - 1);

    const result = await runWatchdogProbe({ port, dataDir, adapter, fetchImpl, stopLockHolderImpl, ...counter });

    expect(result.healthy).toBe(false);
    expect(result.action).toBe('restarted');
    expect(stopLockHolderImpl).toHaveBeenCalledWith(dataDir, port);
    expect(adapter.start).toHaveBeenCalledOnce();
  });

  it('respects a custom failureThreshold', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('timeout'); }) as unknown as typeof fetch;
    const stopLockHolderImpl = vi.fn(async () => ({ ok: true, detail: 'stopped pid 1' }));
    const adapter = makePlainAdapter();
    const counter = makeCounter();

    const r1 = await runWatchdogProbe({ port, dataDir, adapter, fetchImpl, stopLockHolderImpl, failureThreshold: 3, ...counter });
    expect(r1.action).toBe('below-threshold');
    const r2 = await runWatchdogProbe({ port, dataDir, adapter, fetchImpl, stopLockHolderImpl, failureThreshold: 3, ...counter });
    expect(r2.action).toBe('below-threshold');
    const r3 = await runWatchdogProbe({ port, dataDir, adapter, fetchImpl, stopLockHolderImpl, failureThreshold: 3, ...counter });
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
    const counter = makeCounter(DEFAULT_FAILURE_THRESHOLD - 1);

    const result = await runWatchdogProbe({ port, dataDir, adapter, fetchImpl, stopLockHolderImpl, ...counter });

    expect(result.healthy).toBe(false);
    expect(result.action).toBe('restart-failed');
    expect(result.detail).toContain('pid 42 still serving after 5000ms');
    expect(result.detail).toContain('NOT restarted');
    expect(adapter.start).not.toHaveBeenCalled();
    // Still wedged — stays at/above threshold so the very next tick retries
    // immediately instead of waiting through another below-threshold run.
    expect(counter.value).toBeGreaterThanOrEqual(DEFAULT_FAILURE_THRESHOLD);
  });

  it('reports restart-failed (never throws) when adapter.start() itself fails after a successful stop', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('timeout'); }) as unknown as typeof fetch;
    const stopLockHolderImpl = vi.fn(async () => ({ ok: true, detail: 'stopped pid 42' }));
    const adapter = makePlainAdapter({
      start: vi.fn(async () => { throw new Error('systemctl start failed: unit not found'); }),
    });
    const counter = makeCounter(DEFAULT_FAILURE_THRESHOLD - 1);

    const result = await runWatchdogProbe({ port, dataDir, adapter, fetchImpl, stopLockHolderImpl, ...counter });

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
    // No injected counter at all — exercises the real on-disk
    // readFailureCount/writeFailureCount against a dataDir that doesn't
    // exist. A corrupt/absent state file must read as 0, never throw, and
    // never be treated as "already at threshold".
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
