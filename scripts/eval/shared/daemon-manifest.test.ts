import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  daemonManifestPath, writeDaemonManifest, readDaemonManifest, killManifestDaemons,
  type DaemonManifestEntry,
} from './daemon-manifest.js';

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

  it('killManifestDaemons skips entries with pid undefined without throwing', () => {
    const result = killManifestDaemons({ run_dir: dir, updated_at: 'x', daemons: [{ shard: 0, label: 's0', pid: undefined, port: 0, datadir: 'x' }] });
    expect(result.skipped).toHaveLength(1);
    expect(result.killed).toEqual([]);
    expect(result.alreadyDead).toEqual([]);
  });

  describe('against real spawned processes', () => {
    const spawned: ChildProcess[] = [];

    afterEach(() => {
      for (const p of spawned.splice(0)) { try { p.kill('SIGKILL'); } catch { /* already dead */ } }
    });

    it('kills only the PIDs in the manifest, leaving unrelated processes alone', async () => {
      // A long-lived, harmless child process (node's own REPL-less idle
      // via a script that just sleeps) — literal 'node', matching this
      // repo's spawn-daemon.ts precedent for spawning real subprocesses.
      const victim = spawn('node', ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      const bystander = spawn('node', ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      spawned.push(victim, bystander);
      await new Promise(resolve => setTimeout(resolve, 200)); // let both actually start

      writeDaemonManifest(dir, [{ shard: 0, label: 'shard-0', pid: victim.pid, port: 1234, datadir: 'x' }]);
      const manifest = readDaemonManifest(dir)!;
      const result = killManifestDaemons(manifest, 'SIGKILL');

      expect(result.killed).toEqual([victim.pid]);
      expect(result.alreadyDead).toEqual([]);

      await new Promise<void>(resolve => {
        if (victim.exitCode !== null || victim.signalCode !== null) return resolve();
        victim.on('exit', () => resolve());
      });
      expect(victim.exitCode !== null || victim.signalCode !== null).toBe(true);

      // Bystander (not in the manifest) is unaffected — proves this is a
      // scoped kill, not a sweep.
      expect(bystander.exitCode).toBeNull();
      expect(bystander.signalCode).toBeNull();
    }, 10_000);

    it('reports alreadyDead (ESRCH) for a PID that already exited, instead of throwing', async () => {
      const victim = spawn('node', ['-e', '0'], { stdio: 'ignore' }); // exits almost immediately
      spawned.push(victim);
      await new Promise<void>(resolve => {
        if (victim.exitCode !== null) return resolve();
        victim.on('exit', () => resolve());
      });

      writeDaemonManifest(dir, [{ shard: 0, label: 'shard-0', pid: victim.pid, port: 1234, datadir: 'x' }]);
      const manifest = readDaemonManifest(dir)!;
      const result = killManifestDaemons(manifest, 'SIGTERM');

      expect(result.alreadyDead).toEqual([victim.pid]);
      expect(result.killed).toEqual([]);
    }, 10_000);
  });
});
