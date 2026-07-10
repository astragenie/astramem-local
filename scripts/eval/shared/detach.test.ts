import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type AddressInfo } from 'node:net';
import {
  evaluateDetachDecision, buildDetachedChildArgs, isDetachedChild, spawnDetached,
  DETACHED_CHILD_ENV_VAR,
} from './detach.js';
import { killManifestDaemons } from './daemon-manifest.js';

const FIXTURE = join('scripts', 'eval', 'shared', '__fixtures__', 'fake-detached-worker.mjs');

/** Grabs a currently-free TCP port by binding ephemeral port 0 and closing
 *  immediately -- same "measure then rebind" pattern used elsewhere in this
 *  test suite's fixtures. A real port is needed here (review fix, Finding
 *  1): killManifestDaemons now verifies the manifest's recorded pid still
 *  owns the recorded port before signaling, so the test's manifest entry
 *  must point at a port the fixture process genuinely binds. */
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

describe('evaluateDetachDecision (single decision point, DEC-012 pattern)', () => {
  it('no --detach passed -> run-inline regardless of the env marker', () => {
    expect(evaluateDetachDecision({ detachRequested: false, alreadyDetached: false })).toEqual({ action: 'run-inline' });
    expect(evaluateDetachDecision({ detachRequested: false, alreadyDetached: true })).toEqual({ action: 'run-inline' });
  });

  it('--detach passed, not yet the detached child -> spawn-detached', () => {
    expect(evaluateDetachDecision({ detachRequested: true, alreadyDetached: false })).toEqual({ action: 'spawn-detached' });
  });

  it('--detach passed AND already the detached child -> run-inline (does not re-fork)', () => {
    expect(evaluateDetachDecision({ detachRequested: true, alreadyDetached: true })).toEqual({ action: 'run-inline' });
  });
});

describe('isDetachedChild', () => {
  it('false when the env marker is unset', () => {
    expect(isDetachedChild({})).toBe(false);
  });
  it('true when the env marker is "1"', () => {
    expect(isDetachedChild({ [DETACHED_CHILD_ENV_VAR]: '1' })).toBe(true);
  });
  it('false for any other value', () => {
    expect(isDetachedChild({ [DETACHED_CHILD_ENV_VAR]: 'true' })).toBe(false);
  });
});

describe('buildDetachedChildArgs', () => {
  it('strips --detach and appends --run-dir <runDir>', () => {
    const out = buildDetachedChildArgs(['--detach', '--seed', '42'], '/tmp/run-1');
    expect(out).toEqual(['--seed', '42', '--run-dir', '/tmp/run-1']);
  });

  it('replaces an existing --run-dir with the pinned one instead of duplicating it', () => {
    const out = buildDetachedChildArgs(['--run-dir', '.eval-data/runs/whatever', '--detach', '--n', '50'], '/tmp/run-1');
    expect(out).toEqual(['--n', '50', '--run-dir', '/tmp/run-1']);
  });

  it('is a no-op on flags other than --detach/--run-dir', () => {
    const out = buildDetachedChildArgs(['--resume', '/tmp/run-1', '--shards', '2'], '/tmp/run-1');
    expect(out).toEqual(['--resume', '/tmp/run-1', '--shards', '2', '--run-dir', '/tmp/run-1']);
  });
});

describe('spawnDetached (real process integration — AC-2 detach test)', () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it(
    'the detached child keeps running independently, and manifest-scoped kill stops it',
    async () => {
      dir = mkdtempSync(join(tmpdir(), 'detach-test-'));
      const pidFile = join(dir, 'pid.txt');
      const heartbeatFile = join(dir, 'heartbeat.json');
      const port = await getFreePort();

      const child = spawnDetached({
        scriptPath: FIXTURE,
        args: ['--pid-file', pidFile, '--heartbeat-file', heartbeatFile, '--port', String(port)],
        cwd: process.cwd(),
        runDir: dir,
      });
      expect(child.pid).toBeDefined();

      // "Parent moving on" is modeled by this test itself never awaiting
      // the child and never holding a reference that keeps the event loop
      // alive (spawnDetached already called .unref()) -- we only poll the
      // heartbeat file the child writes on its own, exactly like a later
      // session polling run-status.json per AC-2.
      const readHeartbeat = (): { tick: number } | undefined => {
        if (!existsSync(heartbeatFile)) return undefined;
        try { return JSON.parse(readFileSync(heartbeatFile, 'utf8')); } catch { return undefined; }
      };

      const deadline = Date.now() + 5_000;
      let first: { tick: number } | undefined;
      while (Date.now() < deadline && !first) {
        first = readHeartbeat();
        if (!first) await new Promise(resolve => setTimeout(resolve, 50));
      }
      expect(first).toBeDefined();

      // Confirm it's genuinely alive and progressing (tick advances), not a
      // one-shot write.
      await new Promise(resolve => setTimeout(resolve, 300));
      const second = readHeartbeat();
      expect(second!.tick).toBeGreaterThan(first!.tick);

      // Manifest-scoped kill (AC-3 handshake): the daemon manifest names
      // exactly this PID; killing via the manifest must actually stop it.
      const result = killManifestDaemons(
        { run_dir: dir, updated_at: 'x', daemons: [{ shard: 0, label: 'detached-child', pid: child.pid, port, datadir: dir }] },
        'SIGKILL',
      );
      expect(result.killed).toEqual([child.pid]);
      expect(result.outcomes[0]!.action).toBe('killed');

      await new Promise(resolve => setTimeout(resolve, 400));
      const afterKillTick = readHeartbeat()!.tick;
      await new Promise(resolve => setTimeout(resolve, 400));
      const stillSameTick = readHeartbeat()!.tick;
      expect(stillSameTick).toBe(afterKillTick); // heartbeat stopped advancing -- process is actually dead
    },
    15_000,
  );
});
