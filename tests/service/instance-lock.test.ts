import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireInstanceLock, AlreadyRunningError, lockPath, stopLockHolder, getProcessStartTime } from '../../src/service/instance-lock.js';

/** A fixed, arbitrary start-time used across identity-check tests. */
const FIXED_STARTED_AT = '2026-07-13T00:00:00.000Z';
/** A stub that always reports the holder started exactly at FIXED_STARTED_AT — identity matches. */
const matchingStartTime = async () => new Date(FIXED_STARTED_AT);

describe('instance-lock', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'astra-lock-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('acquires exclusively when no lock exists and writes holder info', async () => {
    const lock = await acquireInstanceLock(dir, 7777, '0.6.0');
    expect(existsSync(lockPath(dir))).toBe(true);
    const info = JSON.parse(readFileSync(lockPath(dir), 'utf8'));
    expect(info.pid).toBe(process.pid);
    expect(info.port).toBe(7777);
    expect(info.version).toBe('0.6.0');
    lock.release();
    expect(existsSync(lockPath(dir))).toBe(false);
  });

  it('release is idempotent', async () => {
    const lock = await acquireInstanceLock(dir, 7777, '0.6.0');
    lock.release();
    lock.release(); // second call must not throw
  });

  it('steals a lock held by a dead PID', async () => {
    // PID beyond Windows/Linux practical range — process.kill throws ESRCH.
    writeFileSync(lockPath(dir), JSON.stringify({ pid: 2 ** 30, port: 7777, startedAt: '', version: '' }));
    const lock = await acquireInstanceLock(dir, 8888, '0.6.0');
    const info = JSON.parse(readFileSync(lockPath(dir), 'utf8'));
    expect(info.pid).toBe(process.pid);
    expect(info.port).toBe(8888);
    lock.release();
  });

  it('steals a corrupt/unreadable lock', async () => {
    writeFileSync(lockPath(dir), 'not-json{{{');
    const lock = await acquireInstanceLock(dir, 7777, '0.6.0');
    expect(JSON.parse(readFileSync(lockPath(dir), 'utf8')).pid).toBe(process.pid);
    lock.release();
  });

  it('throws AlreadyRunningError when holder PID is alive and healthy', async () => {
    // Use our own PID (alive by definition) + a stubbed healthy probe.
    writeFileSync(
      lockPath(dir),
      JSON.stringify({ pid: process.pid + 0, port: 9999, startedAt: 'x', version: '0.5.0' }),
    );
    // holder.pid === process.pid is treated as self; use a real other PID via
    // ppid (the test runner's parent, alive for the duration of the test).
    writeFileSync(
      lockPath(dir),
      JSON.stringify({ pid: process.ppid, port: 9999, startedAt: 'x', version: '0.5.0' }),
    );
    await expect(
      acquireInstanceLock(dir, 7777, '0.6.0', { healthProbe: async () => true }),
    ).rejects.toThrow(AlreadyRunningError);
  });

  it('steals when holder PID is alive but health probe fails 3x (zombie)', async () => {
    writeFileSync(
      lockPath(dir),
      JSON.stringify({ pid: process.ppid, port: 9999, startedAt: 'x', version: '0.5.0' }),
    );
    let probes = 0;
    const lock = await acquireInstanceLock(dir, 7777, '0.6.0', {
      healthProbe: async () => { probes++; return false; },
    });
    expect(probes).toBe(3);
    expect(JSON.parse(readFileSync(lockPath(dir), 'utf8')).pid).toBe(process.pid);
    lock.release();
  });

  it('release does not delete a lock that was stolen by a newer process', async () => {
    const lock = await acquireInstanceLock(dir, 7777, '0.6.0');
    // Simulate a newer daemon stealing the lock (zombie takeover).
    writeFileSync(lockPath(dir), JSON.stringify({ pid: 2 ** 30, port: 7778, startedAt: '', version: '' }));
    lock.release();
    // The stolen lock must survive the old holder's release.
    expect(existsSync(lockPath(dir))).toBe(true);
  });
});

describe('stopLockHolder (bug #2/#3 fix: kill the actual lock-holding daemon by PID)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'astra-lock-stop-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('is idempotent when no lock exists', async () => {
    const result = await stopLockHolder(dir, 7777);
    expect(result).toEqual({ ok: true, detail: 'no daemon.lock — nothing to stop' });
  });

  it('is idempotent when the lock holder PID is already dead (no signal sent)', async () => {
    writeFileSync(lockPath(dir), JSON.stringify({ pid: 2 ** 30, port: 7777, startedAt: '', version: '' }));
    let signalCalls = 0;
    const result = await stopLockHolder(dir, 7777, { signal: () => { signalCalls++; } });
    expect(result.ok).toBe(true);
    expect(result.detail).toContain('stale lock');
    expect(signalCalls).toBe(0);
  });

  it('treats EPERM (process exists but not signalable) as ALIVE and still stops it', async () => {
    // Regression: process.kill(pid,0) throwing EPERM means the process EXISTS
    // but we lack permission to signal — it must NOT be misread as "already dead"
    // (that would leave a live daemon running while reporting success).
    writeFileSync(lockPath(dir), JSON.stringify({ pid: process.ppid, port: 9004, startedAt: FIXED_STARTED_AT, version: '0.9.0' }));
    const spy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, sig?: string | number) => {
      if (sig === 0) {
        const e: NodeJS.ErrnoException = new Error('operation not permitted');
        e.code = 'EPERM';
        throw e;
      }
      return true;
    }) as typeof process.kill);
    const signaled: number[] = [];
    const result = await stopLockHolder(dir, 9004, {
      signal: pid => { signaled.push(pid); }, // injected SIGTERM path bypasses the spy
      healthProbe: async () => false,
      processStartTime: matchingStartTime,
    });
    spy.mockRestore();
    expect(signaled).toEqual([process.ppid]); // EPERM => alive => signal actually sent
    expect(result).toEqual({ ok: true, detail: `stopped pid ${process.ppid}` });
  });

  it('signals the live holder PID and reports stopped once the health probe goes unhealthy', async () => {
    writeFileSync(lockPath(dir), JSON.stringify({ pid: process.ppid, port: 9001, startedAt: FIXED_STARTED_AT, version: '0.9.0' }));
    const signaled: Array<{ pid: number; signal: NodeJS.Signals | number }> = [];
    let probeCalls = 0;
    const result = await stopLockHolder(dir, 9001, {
      signal: (pid, signal) => { signaled.push({ pid, signal }); },
      healthProbe: async () => { probeCalls++; return false; }, // stops answering immediately after signal
      processStartTime: matchingStartTime,
    });
    expect(signaled).toEqual([{ pid: process.ppid, signal: 'SIGTERM' }]);
    expect(probeCalls).toBeGreaterThanOrEqual(1);
    expect(result).toEqual({ ok: true, detail: `stopped pid ${process.ppid}` });
  });

  it('reports failure when the holder keeps answering /health past the wait budget', async () => {
    writeFileSync(lockPath(dir), JSON.stringify({ pid: process.ppid, port: 9002, startedAt: FIXED_STARTED_AT, version: '0.9.0' }));
    const result = await stopLockHolder(dir, 9002, {
      signal: () => { /* no-op */ },
      healthProbe: async () => true, // never stops answering
      processStartTime: matchingStartTime,
      waitMs: 10,
    });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('still serving after');
  });

  it('surfaces a signal failure without hanging', async () => {
    writeFileSync(lockPath(dir), JSON.stringify({ pid: process.ppid, port: 9003, startedAt: FIXED_STARTED_AT, version: '0.9.0' }));
    const result = await stopLockHolder(dir, 9003, {
      signal: () => { throw new Error('permission denied'); },
      processStartTime: matchingStartTime,
    });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('permission denied');
  });

  describe('identity check (bug: PID-alive was treated as PID-is-our-daemon)', () => {
    it('REFUSES to signal when the recorded start-time does not match the OS-reported start-time (forged/recycled-PID lock)', async () => {
      writeFileSync(lockPath(dir), JSON.stringify({ pid: process.ppid, port: 9005, startedAt: FIXED_STARTED_AT, version: '0.9.0' }));
      const signaled: number[] = [];
      const result = await stopLockHolder(dir, 9005, {
        signal: pid => { signaled.push(pid); },
        healthProbe: async () => true,
        // OS reports the live process actually started an hour later than the
        // lock claims — same PID, different (real) process. Must not be killed.
        processStartTime: async () => new Date(Date.parse(FIXED_STARTED_AT) + 60 * 60 * 1000),
      });
      expect(signaled).toEqual([]);
      expect(result.ok).toBe(false);
      expect(result.detail).toContain('process start time mismatch');
    });

    it('STILL KILLS a genuinely wedged daemon whose start-time matches the lock', async () => {
      writeFileSync(lockPath(dir), JSON.stringify({ pid: process.ppid, port: 9006, startedAt: FIXED_STARTED_AT, version: '0.9.0' }));
      const signaled: number[] = [];
      const result = await stopLockHolder(dir, 9006, {
        signal: pid => { signaled.push(pid); },
        healthProbe: async () => false, // wedged/dead-looking immediately after signal
        processStartTime: matchingStartTime,
      });
      expect(signaled).toEqual([process.ppid]);
      expect(result).toEqual({ ok: true, detail: `stopped pid ${process.ppid}` });
    });

    it('fails closed (refuses to signal) when the identity check itself cannot determine a start-time', async () => {
      writeFileSync(lockPath(dir), JSON.stringify({ pid: process.ppid, port: 9007, startedAt: FIXED_STARTED_AT, version: '0.9.0' }));
      const signaled: number[] = [];
      const result = await stopLockHolder(dir, 9007, {
        signal: pid => { signaled.push(pid); },
        // Simulates an unreadable /proc entry, a failed PowerShell query, etc.
        processStartTime: async () => null,
      });
      expect(signaled).toEqual([]);
      expect(result.ok).toBe(false);
      expect(result.detail).toContain('could not verify process identity');
    });

    it('fails closed (refuses to signal) when the lock has no valid startedAt to verify against (pre-fix / legacy lock)', async () => {
      writeFileSync(lockPath(dir), JSON.stringify({ pid: process.ppid, port: 9008, startedAt: '', version: '0.9.0' }));
      const signaled: number[] = [];
      const result = await stopLockHolder(dir, 9008, {
        signal: pid => { signaled.push(pid); },
        processStartTime: matchingStartTime,
      });
      expect(signaled).toEqual([]);
      expect(result.ok).toBe(false);
      expect(result.detail).toContain('no valid startedAt');
    });

    it('the real (non-injected) getProcessStartTime resolves a plausible start-time for the current process', async () => {
      const resolved = await getProcessStartTime(process.pid);
      expect(resolved).not.toBeNull();
      // process.uptime() gives us an independent estimate of our own start
      // time; the OS-reported value should land within a generous window of
      // it (allows for query latency, clock granularity, and CI slowness).
      const estimatedStart = Date.now() - process.uptime() * 1000;
      expect(Math.abs((resolved as Date).getTime() - estimatedStart)).toBeLessThan(30_000);
    }, 20_000); // real powershell.exe/ps/proc query — cold PowerShell+CIM start measured ~5.8s, budget generously
  });
});
