/**
 * tests/service/watchdog-probe.test.ts (FEAT-443 SLICE-2)
 *
 * runWatchdogProbe never touches a real daemon or PID — both the health
 * check and the recovery kill are injectable seams (fetchImpl,
 * stopLockHolderImpl), and the "restart" step is a mock ServiceAdapter.
 * hasWatchdogTimer is exercised against both a real-shaped adapter and the
 * plain-object mocks used elsewhere in this suite (e.g.
 * tests/service/install-flow.test.ts) to confirm the duck-typing guard
 * degrades safely instead of throwing when the two extra methods are absent.
 */
import { describe, it, expect, vi } from 'vitest';
import { runWatchdogProbe, hasWatchdogTimer, WATCHDOG_PROBE_INTERVAL_SEC, DEFAULT_PROBE_TIMEOUT_MS } from '../../src/service/watchdog-probe.js';
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

    const result = await runWatchdogProbe({ port, dataDir, adapter, fetchImpl, stopLockHolderImpl });

    expect(result.healthy).toBe(true);
    expect(result.action).toBe('none');
    expect(stopLockHolderImpl).not.toHaveBeenCalled();
    expect(adapter.start).not.toHaveBeenCalled();
  });

  it('reports healthy=false with action=none-adjacent when /health responds non-2xx', async () => {
    // A non-ok status still counts as "no answer" for recovery purposes —
    // confirm it actually triggers the restart path rather than being
    // silently treated as healthy.
    const fetchImpl = vi.fn(async () => new Response(null, { status: 503 })) as unknown as typeof fetch;
    const stopLockHolderImpl = vi.fn(async () => ({ ok: true, detail: 'stopped pid 123' }));
    const adapter = makePlainAdapter();

    const result = await runWatchdogProbe({ port, dataDir, adapter, fetchImpl, stopLockHolderImpl });

    expect(result.healthy).toBe(false);
    expect(result.action).toBe('restarted');
    expect(stopLockHolderImpl).toHaveBeenCalledWith(dataDir, port);
    expect(adapter.start).toHaveBeenCalledOnce();
  });

  it('kills the lock holder and restarts via the adapter when /health throws/times out', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('AbortError: timeout'); }) as unknown as typeof fetch;
    const stopLockHolderImpl = vi.fn(async () => ({ ok: true, detail: 'stopped pid 42' }));
    const adapter = makePlainAdapter();

    const result = await runWatchdogProbe({ port, dataDir, adapter, fetchImpl, stopLockHolderImpl });

    expect(result.healthy).toBe(false);
    expect(result.action).toBe('restarted');
    expect(result.detail).toContain('stopped pid 42');
    expect(result.detail).toContain('linux');
    expect(stopLockHolderImpl).toHaveBeenCalledWith(dataDir, port);
    expect(adapter.start).toHaveBeenCalledOnce();
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

    const result = await runWatchdogProbe({ port, dataDir, adapter, fetchImpl, stopLockHolderImpl });

    expect(result.healthy).toBe(false);
    expect(result.action).toBe('restart-failed');
    expect(result.detail).toContain('pid 42 still serving after 5000ms');
    expect(result.detail).toContain('NOT restarted');
    expect(adapter.start).not.toHaveBeenCalled();
  });

  it('reports restart-failed (never throws) when adapter.start() itself fails after a successful stop', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('timeout'); }) as unknown as typeof fetch;
    const stopLockHolderImpl = vi.fn(async () => ({ ok: true, detail: 'stopped pid 42' }));
    const adapter = makePlainAdapter({
      start: vi.fn(async () => { throw new Error('systemctl start failed: unit not found'); }),
    });

    const result = await runWatchdogProbe({ port, dataDir, adapter, fetchImpl, stopLockHolderImpl });

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
});

describe('WATCHDOG_PROBE_INTERVAL_SEC', () => {
  it('stays comfortably under the 5-minute Windows PT5M keepalive bound this mirrors', () => {
    expect(WATCHDOG_PROBE_INTERVAL_SEC).toBeLessThan(300);
    expect(WATCHDOG_PROBE_INTERVAL_SEC).toBeGreaterThan(0);
  });
});
