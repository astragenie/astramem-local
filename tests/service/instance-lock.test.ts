import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:net';
import {
  acquireInstanceLock, AlreadyRunningError, ZombieLockTakeoverError, lockPath, stopLockHolder,
  getProcessStartTime, isPortInUse, acquiringLockPath, MutexTimeoutError, type InstanceLock,
} from '../../src/service/instance-lock.js';

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

  // issue #387: on 3 failed health probes, acquireInstanceLock no longer
  // steals unconditionally — it must first confirm the holder is actually
  // gone (reusing stopLockHolder's identity-checked kill). These two tests
  // inject `signal`/`processStartTime` so nothing real is ever touched
  // (holder pid is process.ppid — the test runner's own parent).
  it('steals when holder PID is alive but health probe fails 3x (zombie) AND the identity-checked stop confirms it actually stopped', async () => {
    writeFileSync(
      lockPath(dir),
      JSON.stringify({ pid: process.ppid, port: 9999, startedAt: FIXED_STARTED_AT, version: '0.5.0' }),
    );
    let probes = 0;
    const signaled: number[] = [];
    const lock = await acquireInstanceLock(dir, 7777, '0.6.0', {
      // Same stub answers both the 3x zombie-detection loop AND the
      // post-signal wait loop inside stopLockHolder — always unhealthy, so
      // the "stopped" branch is reached on the very first post-signal probe.
      healthProbe: async () => { probes++; return false; },
      signal: pid => { signaled.push(pid); },
      processStartTime: matchingStartTime,
    });
    expect(probes).toBeGreaterThanOrEqual(3); // 3 zombie-detect probes + >=1 stopLockHolder probe
    expect(signaled).toEqual([process.ppid]); // confirmed via a real (injected) kill, not skipped
    expect(JSON.parse(readFileSync(lockPath(dir), 'utf8')).pid).toBe(process.pid);
    lock.release();
  });

  it('REFUSES to steal (throws ZombieLockTakeoverError, never overwrites the lock) when the stop cannot be confirmed AND the port is genuinely still bound', async () => {
    writeFileSync(
      lockPath(dir),
      JSON.stringify({ pid: process.ppid, port: 9999, startedAt: FIXED_STARTED_AT, version: '0.5.0' }),
    );
    const signaled: number[] = [];
    await expect(
      acquireInstanceLock(dir, 7777, '0.6.0', {
        healthProbe: async () => false, // zombie-detected AND "still serving" per stopLockHolder's own probe
        signal: pid => { signaled.push(pid); },
        // Identity check reports a mismatch — stopLockHolder must refuse to
        // signal an unrelated process that happens to share this PID.
        processStartTime: async () => new Date(Date.parse(FIXED_STARTED_AT) + 60 * 60 * 1000),
        // issue #389: a confirmed-bound port is what keeps this refusal in
        // place — without this, an unbound port would now let the takeover
        // proceed instead (see the dedicated port-FREE test below).
        portInUse: async () => true,
      }),
    ).rejects.toThrow(ZombieLockTakeoverError);
    expect(signaled).toEqual([]); // never signaled — identity refused before any kill
    // The original holder's info must still be on disk — we must never
    // return control (or a lock handle) while its ownership is unconfirmed.
    expect(JSON.parse(readFileSync(lockPath(dir), 'utf8')).pid).toBe(process.ppid);
  });

  // issue #389: a recycled PID (identity-mismatch) makes stopLockHolder
  // refuse to signal — but that refusal alone used to always throw
  // ZombieLockTakeoverError, turning a recoverable state (holder isn't our
  // daemon AND isn't bound to the port either) into a hard boot-denial loop.
  // These tests inject `portInUse` so nothing real is ever bound/checked.
  it('issue #389: recycled-PID (identity-mismatch) + port FREE -> takeover proceeds (no throw)', async () => {
    writeFileSync(
      lockPath(dir),
      JSON.stringify({ pid: process.ppid, port: 9999, startedAt: FIXED_STARTED_AT, version: '0.5.0' }),
    );
    const signaled: number[] = [];
    let portChecked: number | null = null;
    const lock = await acquireInstanceLock(dir, 7777, '0.6.0', {
      healthProbe: async () => false, // zombie-detected AND stopLockHolder's own "still serving" probe
      signal: pid => { signaled.push(pid); },
      // Identity check reports a mismatch — stopLockHolder refuses to signal.
      processStartTime: async () => new Date(Date.parse(FIXED_STARTED_AT) + 60 * 60 * 1000),
      portInUse: async port => { portChecked = port; return false; }, // nothing actually listening
    });
    expect(signaled).toEqual([]); // never signaled — identity refused before any kill, exactly as #388 left it
    expect(portChecked).toBe(9999); // checked the HOLDER's recorded port
    expect(JSON.parse(readFileSync(lockPath(dir), 'utf8')).pid).toBe(process.pid); // takeover proceeded
    lock.release();
  });

  it('issue #389: recycled-PID (identity-mismatch) + port STILL BOUND -> throws ZombieLockTakeoverError, never overwrites the lock', async () => {
    writeFileSync(
      lockPath(dir),
      JSON.stringify({ pid: process.ppid, port: 9999, startedAt: FIXED_STARTED_AT, version: '0.5.0' }),
    );
    const signaled: number[] = [];
    await expect(
      acquireInstanceLock(dir, 7777, '0.6.0', {
        healthProbe: async () => false,
        signal: pid => { signaled.push(pid); },
        processStartTime: async () => new Date(Date.parse(FIXED_STARTED_AT) + 60 * 60 * 1000),
        portInUse: async () => true, // something is genuinely still bound
      }),
    ).rejects.toThrow(ZombieLockTakeoverError);
    expect(signaled).toEqual([]);
    // The original holder's info must still be on disk — unchanged from the
    // pre-#389 refusal behavior when the port genuinely can't be ruled out.
    expect(JSON.parse(readFileSync(lockPath(dir), 'utf8')).pid).toBe(process.ppid);
  });

  it('issue #389: genuinely-dead holder (!pidAlive) still takes over unconditionally, without ever consulting the port check (unchanged from #388)', async () => {
    writeFileSync(lockPath(dir), JSON.stringify({ pid: 2 ** 30, port: 7777, startedAt: '', version: '' }));
    let portChecked = false;
    const lock = await acquireInstanceLock(dir, 8888, '0.6.0', {
      portInUse: async () => { portChecked = true; return true; },
    });
    // The dead-PID path steals via `pidAlive` alone and never reaches the
    // zombie/health-probe branch at all — the port check must not fire here.
    expect(portChecked).toBe(false);
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

    it('issue #307: drift + no force -> refuses with a message naming --force', async () => {
      writeFileSync(lockPath(dir), JSON.stringify({ pid: process.ppid, port: 9020, startedAt: FIXED_STARTED_AT, version: '0.9.0' }));
      const signaled: number[] = [];
      const result = await stopLockHolder(dir, 9020, {
        signal: pid => { signaled.push(pid); },
        healthProbe: async () => true,
        processStartTime: async () => new Date(Date.parse(FIXED_STARTED_AT) + 60 * 60 * 1000),
      });
      expect(signaled).toEqual([]);
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('identity-mismatch');
      // The library detail itself stays generic (reused by restore.ts/reinstall.ts,
      // which have their own recovery flags); the CLI layer (service.ts) is what
      // appends the `--force` pointer for `service stop` specifically. Assert the
      // reason so the CLI's hint-selection logic has something stable to key off.
      expect(result.detail).toContain('process start time mismatch');
    });

    it('issue #307: drift + force=true -> proceeds (signals the pid), logging the drift', async () => {
      writeFileSync(lockPath(dir), JSON.stringify({ pid: process.ppid, port: 9021, startedAt: FIXED_STARTED_AT, version: '0.9.0' }));
      const signaled: number[] = [];
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const result = await stopLockHolder(dir, 9021, {
        signal: pid => { signaled.push(pid); },
        healthProbe: async () => false, // stops answering immediately after signal
        processStartTime: async () => new Date(Date.parse(FIXED_STARTED_AT) + 60 * 60 * 1000),
        force: true,
      });
      // Read recorded calls BEFORE mockRestore() — vitest's mockRestore also
      // clears mock.calls (matches Jest semantics), so reading after would
      // always see an empty array regardless of whether console.error fired.
      const warned = errSpy.mock.calls.map(c => c.join(' ')).join('\n');
      errSpy.mockRestore();
      expect(signaled).toEqual([process.ppid]); // proceeded despite the drift
      expect(result.ok).toBe(true);
      // Logged what the drift WAS before overriding.
      expect(warned).toContain('WARNING');
      expect(warned).toContain('overriding recycled-PID guard');
      expect(warned).toContain('drift');
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

  // B2 (docs/specs/20260713-stability-wave-plan.md) — every test above injects
  // BOTH `signal` and `processStartTime`, so none of them exercises the real
  // default path: real `process.kill` actually delivering a signal, and real
  // `getProcessStartTime` actually resolving via `stopLockHolder`'s own
  // internal call (not just called directly against `process.pid`, as the
  // single real-query test above does). A mocked test proves the branch
  // logic; it does not prove the OS query is wired correctly end-to-end, or
  // that a real drift is actually measured and actually refused. This
  // describe block closes that gap against a real, disposable child process
  // this suite spawns and owns — never against `process.pid`/`process.ppid`
  // (the test runner itself) or any process this suite didn't start.
  //
  // What this DOES prove: the real OS start-time query wired through
  // `stopLockHolder`'s default `processStartTime`, a real refusal on a real
  // mismatch (innocent process survives), and a real `process.kill` signal
  // delivered on a real match (the process actually dies). What this does
  // NOT prove: an actual OS PID-reuse (recycling a specific numeric PID for
  // an unrelated process) — that cannot be forced deterministically in a
  // test. That scenario is Wave D2's manual E2E (SIGKILL the daemon, recycle
  // the PID, run `service stop`/watchdog, assert the innocent process
  // survives) and remains unautomated; this describe block is the closest
  // in-process approximation, not a substitute for it.
  describe('end-to-end against a REAL spawned process (no injected signal or processStartTime)', () => {
    const children: ChildProcess[] = [];

    /** A disposable process this suite owns end-to-end: spawned here, never
     *  left running past this describe block's afterEach, regardless of
     *  whether the test under it passes, fails, or throws. Does nothing but
     *  keep its event loop alive — no port, no file writes, no astramem code
     *  loaded — so there is nothing to isolate via ASTRA_MEMORY_DATADIR/etc,
     *  and nothing at risk beyond the PID itself. */
    function spawnThrowaway(): ChildProcess {
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30);'], { stdio: 'ignore' });
      children.push(child);
      return child;
    }

    function isAlive(pid: number): boolean {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    }

    afterEach(() => {
      // Force-kill every PID this describe block spawned, whether or not the
      // test above already stopped it — SIGKILL on an already-dead PID just
      // throws (ESRCH-equivalent), swallowed here. This runs on test failure
      // too (afterEach, not inline cleanup at the end of the happy path) —
      // required on a box that also runs the production daemon, Ollama, and
      // sibling agents' own processes.
      while (children.length) {
        const child = children.pop()!;
        if (child.pid && isAlive(child.pid)) {
          try { process.kill(child.pid, 'SIGKILL'); } catch { /* already gone */ }
        }
      }
    });

    it('REFUSES to signal a real spawned process when the forged startedAt does not match its real OS start time — and the process survives', async () => {
      const child = spawnThrowaway();
      // Give the OS a moment to finish registering the new process before we
      // query it — spawn() returning does not guarantee every OS bookkeeping
      // path (e.g. Windows CIM's view) is immediately consistent.
      await new Promise(resolve => setTimeout(resolve, 200));
      expect(child.pid).toBeDefined();
      const pid = child.pid!;

      writeFileSync(lockPath(dir), JSON.stringify({
        pid, port: 9100, startedAt: new Date(0).toISOString(), version: '0.9.0',
      }));

      // No injected `signal` or `processStartTime` — real process.kill, real getProcessStartTime.
      const result = await stopLockHolder(dir, 9100);

      expect(result.ok).toBe(false);
      expect(result.detail).toContain('process start time mismatch');
      // The proof: an innocent process, checked with a real OS query, refused
      // by the real code path — not an injected stub asserting on itself.
      expect(isAlive(pid)).toBe(true);
    }, 30_000); // one real OS start-time query inside stopLockHolder; budget as generously as the single-query test above

    it('DOES signal a real spawned process when the recorded startedAt matches its real OS start time', async () => {
      const child = spawnThrowaway();
      await new Promise(resolve => setTimeout(resolve, 200));
      const pid = child.pid!;

      const realStart = await getProcessStartTime(pid);
      // Sanity gate: if the OS query itself can't resolve a start time for
      // our own freshly-spawned child, this test cannot mean anything either
      // way — fail loudly here rather than silently asserting on a null.
      expect(realStart).not.toBeNull();

      writeFileSync(lockPath(dir), JSON.stringify({
        pid, port: 9101, startedAt: (realStart as Date).toISOString(), version: '0.9.0',
      }));

      const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));

      // No injected `signal` or `processStartTime` — real process.kill(pid,
      // 'SIGTERM'), which force-terminates on Windows (stopLockHolder's own
      // doc comment). `healthProbe` IS injected (always unhealthy): the
      // /health-polling loop itself is already exhaustively covered by the
      // injected-probe tests above — what this test proves is the identity
      // check plus real signal delivery, not the polling loop a second time.
      const result = await stopLockHolder(dir, 9101, { healthProbe: async () => false });

      await Promise.race([
        exited,
        new Promise((_, reject) => setTimeout(() => reject(new Error('child did not exit within 5s of signal')), 5_000)),
      ]);

      expect(result.ok).toBe(true);
      expect(result.detail).toBe(`stopped pid ${pid}`);
      // The proof: the process is actually gone, not just reported gone.
      expect(isAlive(pid)).toBe(false);
    }, 40_000); // two real OS start-time queries (pre-seed + stopLockHolder's own) plus signal-delivery wait
  });
});

// issue #389: the real (non-injected) port-liveness probe. Uses an ephemeral
// port bound by this suite itself — never a fixed/well-known port and never
// anything astramem code touches — so this is safe against a box that also
// runs the production daemon and sibling agents' processes.
describe('isPortInUse (real socket probe, issue #389)', () => {
  let server: Server;
  let port: number;

  beforeEach(async () => {
    server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('expected an AddressInfo from an ephemeral TCP listener');
    port = addr.port;
  });

  afterEach(async () => {
    if (!server.listening) return;
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  it('reports true while something is actually listening', async () => {
    expect(await isPortInUse(port)).toBe(true);
  });

  it('reports false (ECONNREFUSED) once nothing is listening', async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    expect(await isPortInUse(port)).toBe(false);
  });
});

// Wave 0 Item 2 — the `.acquiring` mutex. These tests use INJECTED timing
// (a manually-controlled gate, or a manually-held sentinel file) rather than
// organic "spawn N, see one bind" races — per ADR-016 §5, an organic-timing
// concurrency test can pass green for the wrong reason (a mutex scoped only
// to the lock write, not the bind, still usually "looks" serialized under
// normal scheduling). Every assertion here targets the SPECIFIC window the
// old code left open: the mutex must be held continuously from decide
// through the caller's `bind` callback (typically `app.listen()`), not just
// until `daemon.lock` is written.
describe('acquireInstanceLock — the .acquiring mutex (Wave 0 Item 2)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'astra-lock-mutex-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('a manually-held .acquiring sentinel blocks a new acquireInstanceLock call from proceeding past the mutex', async () => {
    // Simulate "another process is mid-decide" by taking the sentinel
    // ourselves, exactly the way acquireMutex does internally — with a LIVE
    // pid (our own) recorded, so it reads as genuinely held rather than
    // stale (an empty/unparseable sentinel is treated as stale and stolen
    // immediately — that's a DIFFERENT, deliberately fast path, covered by
    // the next test).
    writeFileSync(acquiringLockPath(dir), JSON.stringify({ pid: process.pid }));

    let resolved = false;
    const acquirePromise = acquireInstanceLock(dir, 7777, '0.6.0', { mutexTimeoutMs: 5_000 })
      .then(lock => { resolved = true; return lock; });

    // Give the call every chance to race past the mutex if it were broken —
    // it must NOT have written daemon.lock or resolved while the sentinel
    // (written by the OS-level pid inside it, our own pid here) is held and
    // still alive.
    await new Promise(r => setTimeout(r, 150));
    expect(resolved).toBe(false);
    expect(existsSync(lockPath(dir))).toBe(false);

    // Release the sentinel the same way acquireMutex's own release() does —
    // simulating the prior holder finishing.
    unlinkSync(acquiringLockPath(dir));

    const lock = await acquirePromise;
    expect(resolved).toBe(true);
    expect(existsSync(lockPath(dir))).toBe(true);
    lock.release();
  });

  it('a held-but-stale sentinel (pid no longer alive) is stolen immediately rather than waited out', async () => {
    // A PID beyond the practical range is never alive — same convention the
    // existing "steals a lock held by a dead PID" test above uses.
    writeFileSync(acquiringLockPath(dir), JSON.stringify({ pid: 2 ** 30 }));

    const start = Date.now();
    const lock = await acquireInstanceLock(dir, 7777, '0.6.0', { mutexTimeoutMs: 20_000 });
    const elapsedMs = Date.now() - start;

    // Should resolve almost immediately (stale-sentinel steal path), not
    // wait anywhere near the mutex timeout.
    expect(elapsedMs).toBeLessThan(2_000);
    expect(existsSync(lockPath(dir))).toBe(true);
    lock.release();
  });

  it('the .acquiring mutex stays held through the bind callback, not just until daemon.lock is written', async () => {
    let bindStarted = false;
    let releaseBindGate: () => void = () => {};
    const bindGate = new Promise<void>(resolve => { releaseBindGate = resolve; });
    const slowBind = async (): Promise<void> => {
      bindStarted = true;
      await bindGate; // held open until this test explicitly releases it
    };

    const acquirePromise = acquireInstanceLock(dir, 7777, '0.6.0', { bind: slowBind });

    // Poll for bind() to actually start (proves we got past decide+write).
    const deadline = Date.now() + 5_000;
    while (!bindStarted && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 10));
    }
    expect(bindStarted).toBe(true);

    // daemon.lock IS already written at this point (write happens before
    // bind) — proving this isn't just catching the earlier, already-fixed
    // window.
    expect(existsSync(lockPath(dir))).toBe(true);

    // While bind() is still pending, the mutex sentinel must STILL be held —
    // a second attempt to exclusively create it must fail with EEXIST. This
    // is the exact assertion the pre-fix code could never have passed: a
    // mutex released right after the lock write would have left the
    // sentinel gone by now.
    expect(() => {
      const fd = openSync(acquiringLockPath(dir), 'wx');
      closeSync(fd);
    }).toThrow(/EEXIST/);

    releaseBindGate();
    const lock: InstanceLock = await acquirePromise;

    // Now that bind() resolved and the mutex released, a fresh exclusive
    // create must succeed again.
    const fd = openSync(acquiringLockPath(dir), 'wx');
    closeSync(fd);
    unlinkSync(acquiringLockPath(dir));
    lock.release();
  });

  it('two concurrent acquires against an empty dir never run their bind callbacks concurrently (max-concurrency=1)', async () => {
    let active = 0;
    let maxConcurrent = 0;
    const order: string[] = [];
    const trackedBind = (label: string) => async (): Promise<void> => {
      active++;
      maxConcurrent = Math.max(maxConcurrent, active);
      order.push(`${label}-start`);
      await new Promise(r => setTimeout(r, 50));
      order.push(`${label}-end`);
      active--;
    };

    // Both calls run in the SAME OS process — the pid-self-check in
    // acquireInstanceLockCriticalSection means the second call's decide
    // logic sees `holder.pid === process.pid` and steals rather than
    // throwing AlreadyRunningError (that health-probe path is exhaustively
    // covered by the single-acquire tests earlier in this file, which use
    // process.ppid to simulate a genuinely different pid). What THIS test
    // proves — the thing Item 2 actually fixes — is that the mutex forces
    // the two binds to run strictly SEQUENTIALLY, never overlapping.
    const results = await Promise.allSettled([
      acquireInstanceLock(dir, 7777, '0.6.0', { bind: trackedBind('a') }),
      acquireInstanceLock(dir, 7777, '0.6.0', { bind: trackedBind('b') }),
    ]);

    expect(maxConcurrent).toBe(1);
    // Strictly sequential: whichever started second only starts after the
    // first fully finished.
    expect(order[0]?.endsWith('-start')).toBe(true);
    expect(order[1]).toBe(`${order[0]!.replace('-start', '')}-end`);

    for (const r of results) {
      if (r.status === 'fulfilled') r.value.release();
    }
  });

  it('MutexTimeoutError is thrown (not an indefinite hang) when a live sentinel holder never releases within the budget', async () => {
    // A live pid (our own) that never releases the sentinel — simulates a
    // genuinely wedged sibling process.
    writeFileSync(acquiringLockPath(dir), JSON.stringify({ pid: process.pid }));

    await expect(
      acquireInstanceLock(dir, 7777, '0.6.0', { mutexTimeoutMs: 200 }),
    ).rejects.toThrow(MutexTimeoutError);

    // Clean up the sentinel this test wrote so afterEach's rmSync isn't
    // doing anything surprising (it would clean it up anyway, but this
    // documents the expected end state explicitly).
    unlinkSync(acquiringLockPath(dir));
  });
});
