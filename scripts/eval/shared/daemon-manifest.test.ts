import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type AddressInfo } from 'node:net';
import {
  daemonManifestPath, writeDaemonManifest, readDaemonManifest, killManifestDaemons, checkPortOwner,
  type DaemonManifestEntry,
} from './daemon-manifest.js';

const FIXTURE = join('scripts', 'eval', 'shared', '__fixtures__', 'fake-detached-worker.mjs');

/** Grabs a currently-free TCP port by binding ephemeral port 0 and closing
 *  immediately. Needed everywhere a test wants a port guaranteed NOT to be
 *  listening (the identity guard's "port not listening -> already-dead"
 *  branch would otherwise be at the mercy of whatever else happens to be
 *  bound to a hardcoded port number on the test machine). */
function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

/** Spawns the fake-detached-worker fixture bound to a real port -- the
 *  identity guard (review fix, Finding 1) verifies a manifest's recorded
 *  pid still owns the recorded port before signaling, so any test proving
 *  a real 'killed' outcome needs a process that genuinely binds one. */
function spawnPortOwner(dir: string, tag: string, port: number): ChildProcess {
  return spawn('node', [
    FIXTURE,
    '--pid-file', join(dir, `${tag}-pid.txt`),
    '--heartbeat-file', join(dir, `${tag}-heartbeat.json`),
    '--port', String(port),
  ], { stdio: 'ignore' });
}

// FEAT-475: the fixed "let the port actually bind" sleep this replaces was
// tuned for an idle box (300ms). Reproduced directly under concurrent
// parallel suite/agent load (4 concurrent full-suite-equivalent processes,
// 20-core box): real spawn-to-bound-port latency for this exact fixture
// measured p50=1558ms p90=2835ms p99=2885ms (n=20, timed via the fixture's
// own heartbeat file, which per its own header only starts writing once the
// TCP listen() callback fires -- i.e. once the port is CONFIRMED bound).
// A fixed sleep can't track that variance; poll checkPortOwner (the same
// identity check killManifestDaemons uses) until it actually reports the
// port as owned by the expected pid, so the test proceeds exactly when the
// real precondition is true instead of gambling on a guessed delay.
async function waitForPortBoundBy(port: number, expectedPid: number | undefined, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const check = checkPortOwner(port);
    if (check.ok && check.pid === expectedPid) return;
    if (Date.now() >= deadline) {
      throw new Error(`port ${port} was not confirmed bound by pid ${expectedPid} within ${timeoutMs}ms`);
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

// FEAT-475: these tests do a real spawn + (poll-verified, up to 10s) bind
// wait, then a real killManifestDaemons call whose internal netstat/lsof
// identity check now has its own 15_000ms budget (daemon-manifest.ts,
// PORT_OWNER_CHECK_TIMEOUT_MS) -- the outer per-test vitest timeout has to
// comfortably exceed the sum of those, not just the old un-widened 10_000ms
// default this replaces.
const IDENTITY_CHECK_TIMEOUT_MS = 30_000;

describe('daemon-manifest (FEAT-462 slice B, AC-3)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'daemon-manifest-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('readDaemonManifest returns undefined when no file exists', () => {
    expect(readDaemonManifest(dir)).toBeUndefined();
  });

  it('writeDaemonManifest then readDaemonManifest round-trips the entries', () => {
    const entries: DaemonManifestEntry[] = [
      { shard: 0, label: 'shard-0', pid: 111, port: 5001, datadir: join(dir, 'shard-0', 'datadir') },
      { shard: 1, label: 'shard-1', pid: 222, port: 5002, datadir: join(dir, 'shard-1', 'datadir') },
    ];
    writeDaemonManifest(dir, entries);
    expect(existsSync(daemonManifestPath(dir))).toBe(true);
    const manifest = readDaemonManifest(dir);
    expect(manifest?.daemons).toEqual(entries);
    expect(manifest?.run_dir).toBe(dir);
  });

  it('leaves no stray tmp file behind on success', () => {
    writeDaemonManifest(dir, []);
    const files = readdirSync(dir);
    expect(files.filter((f: string) => f.includes('.tmp'))).toEqual([]);
  });

  it('killManifestDaemons skips (as an identity-mismatch) entries with pid undefined, without throwing', () => {
    const result = killManifestDaemons({ run_dir: dir, updated_at: 'x', daemons: [{ shard: 0, label: 's0', pid: undefined, port: 0, datadir: 'x' }] });
    expect(result.skipped).toHaveLength(1);
    expect(result.killed).toEqual([]);
    expect(result.alreadyDead).toEqual([]);
    expect(result.outcomes[0]!.action).toBe('skipped-identity-mismatch');
  });

  describe('identity-checked kill against real spawned processes (review fix, Finding 1)', () => {
    const spawned: ChildProcess[] = [];

    afterEach(() => {
      for (const p of spawned.splice(0)) { try { p.kill('SIGKILL'); } catch { /* already dead */ } }
    });

    it('(a) live daemon bound to its manifest port -> killed, and an unrelated bystander is left alone', async () => {
      const victimPort = await getFreePort();
      const victim = spawnPortOwner(dir, 'victim', victimPort);
      // Bystander: alive, owns no port, NOT in the manifest -- proves this
      // is a scoped kill, not a sweep.
      const bystander = spawn('node', ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      spawned.push(victim, bystander);
      await waitForPortBoundBy(victimPort, victim.pid);

      writeDaemonManifest(dir, [{ shard: 0, label: 'shard-0', pid: victim.pid, port: victimPort, datadir: 'x' }]);
      const manifest = readDaemonManifest(dir)!;
      const result = killManifestDaemons(manifest, 'SIGKILL');

      expect(result.killed).toEqual([victim.pid]);
      expect(result.alreadyDead).toEqual([]);
      expect(result.skipped).toEqual([]);
      expect(result.outcomes).toEqual([{
        shard: 0, label: 'shard-0', pid: victim.pid, port: victimPort, action: 'killed',
        detail: expect.stringContaining(`signaled pid ${victim.pid}`),
      }]);

      await new Promise<void>(resolve => {
        if (victim.exitCode !== null || victim.signalCode !== null) return resolve();
        victim.on('exit', () => resolve());
      });
      expect(victim.exitCode !== null || victim.signalCode !== null).toBe(true);

      expect(bystander.exitCode).toBeNull();
      expect(bystander.signalCode).toBeNull();
    }, IDENTITY_CHECK_TIMEOUT_MS);

    it('(b) a pid whose port is not listening -> already-dead, with NO signal ever attempted', async () => {
      // A pid that is provably real and provably not listening on the
      // recorded port: spawn a process, wait for it to fully exit, THEN
      // record its (now-reusable, but for this instant still identifiable
      // as dead-via-port) pid in the manifest against a port nothing is
      // bound to. The identity guard must short-circuit on the port check
      // alone -- it must never even reach process.kill.
      const deadPort = await getFreePort();
      const victim = spawn('node', ['-e', '0'], { stdio: 'ignore' }); // exits almost immediately, binds no port
      spawned.push(victim);
      await new Promise<void>(resolve => {
        if (victim.exitCode !== null) return resolve();
        victim.on('exit', () => resolve());
      });

      writeDaemonManifest(dir, [{ shard: 0, label: 'shard-0', pid: victim.pid, port: deadPort, datadir: 'x' }]);
      const manifest = readDaemonManifest(dir)!;
      const result = killManifestDaemons(manifest, 'SIGTERM');

      expect(result.alreadyDead).toEqual([victim.pid]);
      expect(result.killed).toEqual([]);
      expect(result.skipped).toEqual([]);
      expect(result.outcomes[0]).toMatchObject({ action: 'already-dead', pid: victim.pid, port: deadPort });
      expect(result.outcomes[0]!.detail).toMatch(/not listening/);
    }, IDENTITY_CHECK_TIMEOUT_MS);

    it('(c) identity mismatch: port owned by a DIFFERENT live process than the manifest pid -> skipped-identity-mismatch, BOTH processes survive', async () => {
      const port = await getFreePort();
      // The process that actually owns the port.
      const portOwner = spawnPortOwner(dir, 'port-owner', port);
      // A second, unrelated live process this test also owns -- stands in
      // for "the pid a stale manifest still remembers", now reused/pointed
      // at something that is NOT the daemon on that port.
      const innocentBystander = spawn('node', ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      spawned.push(portOwner, innocentBystander);
      await waitForPortBoundBy(port, portOwner.pid);

      writeDaemonManifest(dir, [{ shard: 0, label: 'shard-0', pid: innocentBystander.pid, port, datadir: 'x' }]);
      const manifest = readDaemonManifest(dir)!;
      const result = killManifestDaemons(manifest, 'SIGKILL');

      expect(result.skipped).toEqual([innocentBystander.pid]);
      expect(result.killed).toEqual([]);
      expect(result.alreadyDead).toEqual([]);
      expect(result.outcomes[0]).toMatchObject({ action: 'skipped-identity-mismatch', pid: innocentBystander.pid, port });
      expect(result.outcomes[0]!.detail).toMatch(new RegExp(`owned by pid ${portOwner.pid}`));

      // The critical assertion: NEITHER process was signaled -- not the
      // pid actually on the port (never in the manifest, so untouched by
      // construction) and not the manifest's recorded pid either (identity
      // mismatch must refuse to signal it).
      await new Promise(resolve => setTimeout(resolve, 200));
      expect(portOwner.exitCode).toBeNull();
      expect(portOwner.signalCode).toBeNull();
      expect(innocentBystander.exitCode).toBeNull();
      expect(innocentBystander.signalCode).toBeNull();
    }, IDENTITY_CHECK_TIMEOUT_MS);
  });
});
