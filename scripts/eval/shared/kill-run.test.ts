import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type AddressInfo } from 'node:net';
import { writeDaemonManifest } from './daemon-manifest.js';
import { writeRunStatus, readRunStatus } from './run-status.js';
import { killRun } from './kill-run.mts';

const FIXTURE = join('scripts', 'eval', 'shared', '__fixtures__', 'fake-detached-worker.mjs');

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

describe('killRun (review fix, Finding 2 -- operator cleanup CLI)', () => {
  let dir: string;
  const spawned: ChildProcess[] = [];

  afterEach(() => {
    for (const p of spawned.splice(0)) { try { p.kill('SIGKILL'); } catch { /* already dead */ } }
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('reports an error and exits non-zero when no daemon-manifest.json exists', () => {
    dir = mkdtempSync(join(tmpdir(), 'kill-run-test-'));
    const outcome = killRun(dir);
    expect(outcome.exitCode).toBe(1);
    expect(outcome.lines[0]).toMatch(/no daemon-manifest\.json found/);
  });

  it('exits 0 with a no-op message when the manifest has no recorded daemons', () => {
    dir = mkdtempSync(join(tmpdir(), 'kill-run-test-'));
    writeDaemonManifest(dir, []);
    const outcome = killRun(dir);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.lines[0]).toMatch(/nothing to do/);
  });

  it('kills a live daemon, patches run-status.json to failed, and preserves the original orchestrator_pid/started_at', async () => {
    dir = mkdtempSync(join(tmpdir(), 'kill-run-test-'));
    const port = await getFreePort();
    const victim = spawn('node', [
      FIXTURE, '--pid-file', join(dir, 'pid.txt'), '--heartbeat-file', join(dir, 'heartbeat.json'), '--port', String(port),
    ], { stdio: 'ignore' });
    spawned.push(victim);
    await new Promise(resolve => setTimeout(resolve, 300));

    writeDaemonManifest(dir, [{ shard: 0, label: 'shard-0', pid: victim.pid, port, datadir: 'x' }]);
    writeRunStatus(dir, {
      status: 'running', phase: 'ingesting', orchestrator_pid: 999999, detached: true,
      started_at: '2026-07-10T00:00:00.000Z', updated_at: '2026-07-10T00:00:01.000Z',
      sessions_done: 3, sessions_total: 10,
    });

    const outcome = killRun(dir, 'SIGKILL');
    expect(outcome.exitCode).toBe(0);
    expect(outcome.result?.killed).toEqual([victim.pid]);
    expect(outcome.lines.some(l => l.includes('1 killed'))).toBe(true);

    const status = readRunStatus(dir)!;
    expect(status.status).toBe('failed');
    expect(status.phase).toBe('failed');
    expect(status.error).toMatch(/manually killed via kill-run\.mts/);
    // The cleanup CLI's own pid must NOT clobber the original orchestrator's
    // recorded identity -- an operator reading run-status.json afterward
    // should still see who was actually running the eval.
    expect(status.orchestrator_pid).toBe(999999);
    expect(status.started_at).toBe('2026-07-10T00:00:00.000Z');

    await new Promise<void>(resolve => {
      if (victim.exitCode !== null || victim.signalCode !== null) return resolve();
      victim.on('exit', () => resolve());
    });
    expect(victim.exitCode !== null || victim.signalCode !== null).toBe(true);
  }, 10_000);

  it('exits non-zero (without touching run-status.json) when an entry is identity-ambiguous', async () => {
    dir = mkdtempSync(join(tmpdir(), 'kill-run-test-'));
    const deadPort = await getFreePort();
    writeDaemonManifest(dir, [{ shard: 0, label: 'shard-0', pid: undefined, port: deadPort, datadir: 'x' }]);

    const outcome = killRun(dir);
    expect(outcome.exitCode).toBe(1);
    expect(outcome.result?.skipped).toHaveLength(1);
    expect(readRunStatus(dir)).toBeUndefined(); // no kill happened -- status untouched
  });
});
