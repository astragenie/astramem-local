import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireInstanceLock, AlreadyRunningError, lockPath, stopLockHolder } from '../../src/service/instance-lock.js';

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

  it('signals the live holder PID and reports stopped once the health probe goes unhealthy', async () => {
    writeFileSync(lockPath(dir), JSON.stringify({ pid: process.ppid, port: 9001, startedAt: 'x', version: '0.9.0' }));
    const signaled: Array<{ pid: number; signal: NodeJS.Signals | number }> = [];
    let probeCalls = 0;
    const result = await stopLockHolder(dir, 9001, {
      signal: (pid, signal) => { signaled.push({ pid, signal }); },
      healthProbe: async () => { probeCalls++; return false; }, // stops answering immediately after signal
    });
    expect(signaled).toEqual([{ pid: process.ppid, signal: 'SIGTERM' }]);
    expect(probeCalls).toBeGreaterThanOrEqual(1);
    expect(result).toEqual({ ok: true, detail: `stopped pid ${process.ppid}` });
  });

  it('reports failure when the holder keeps answering /health past the wait budget', async () => {
    writeFileSync(lockPath(dir), JSON.stringify({ pid: process.ppid, port: 9002, startedAt: 'x', version: '0.9.0' }));
    const result = await stopLockHolder(dir, 9002, {
      signal: () => { /* no-op */ },
      healthProbe: async () => true, // never stops answering
      waitMs: 10,
    });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('still serving after');
  });

  it('surfaces a signal failure without hanging', async () => {
    writeFileSync(lockPath(dir), JSON.stringify({ pid: process.ppid, port: 9003, startedAt: 'x', version: '0.9.0' }));
    const result = await stopLockHolder(dir, 9003, {
      signal: () => { throw new Error('permission denied'); },
    });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('permission denied');
  });
});
