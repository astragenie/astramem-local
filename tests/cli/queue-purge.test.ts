import { describe, it, expect, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { openDb } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { queueCommand } from '../../src/cli/queue.js';

function tmpDataDir(): string {
  const dir = join(tmpdir(), `astra-queue-purge-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function seedJobs(dataDir: string, jobs: Array<{ state: string; kind?: string; last_error?: string | null }>): void {
  const db = openDb(join(dataDir, 'memory.sqlite'));
  migrate(db);
  const now = Date.now();
  for (const j of jobs) {
    db.prepare(`
      INSERT INTO jobs (id, kind, payload_json, state, attempts, last_error, created_at, updated_at)
      VALUES (?, ?, '{"kind":"distill","transcript_id":"t1","session_id":"s1"}', ?, 0, ?, ?, ?)
    `).run(randomUUID(), j.kind ?? 'distill', j.state, j.last_error ?? null, now, now);
  }
  db.close();
}

function stateCounts(dataDir: string): Record<string, number> {
  const db = openDb(join(dataDir, 'memory.sqlite'));
  migrate(db);
  const rows = db.prepare(`SELECT state, COUNT(*) AS n FROM jobs GROUP BY state`).all() as Array<{ state: string; n: number }>;
  db.close();
  return Object.fromEntries(rows.map(r => [r.state, r.n]));
}

const origDataDir = process.env.ASTRA_MEMORY_DATADIR;

afterEach(() => {
  if (origDataDir === undefined) delete process.env.ASTRA_MEMORY_DATADIR;
  else process.env.ASTRA_MEMORY_DATADIR = origDataDir;
  vi.restoreAllMocks();
});

describe('queue purge --poison', () => {
  it('AC-1: removes all poison jobs and writes a forensics dump before deleting', async () => {
    const dir = tmpDataDir();
    process.env.ASTRA_MEMORY_DATADIR = dir;
    seedJobs(dir, [
      { state: 'poison', last_error: 'parse failure A' },
      { state: 'poison', last_error: 'parse failure B' },
      { state: 'pending' },
    ]);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await queueCommand(['purge', '--poison', '--json']);

    const output = JSON.parse(logSpy.mock.calls[0]![0] as string);
    expect(output.purged).toBe(2);
    expect(typeof output.dumpPath).toBe('string');
    expect(existsSync(output.dumpPath)).toBe(true);

    const dump = JSON.parse(readFileSync(output.dumpPath, 'utf-8')) as { count: number; jobs: Array<{ failure_reason: string | null }> };
    expect(dump.count).toBe(2);
    expect(dump.jobs).toHaveLength(2);
    const reasons = dump.jobs.map(j => j.failure_reason);
    expect(reasons).toContain('parse failure A');
    expect(reasons).toContain('parse failure B');

    const counts = stateCounts(dir);
    expect(counts.poison ?? 0).toBe(0);
    expect(counts.pending).toBe(1);
  });

  it('AC-2: --json stdout is exactly {purged, dumpPath} on a single line', async () => {
    const dir = tmpDataDir();
    process.env.ASTRA_MEMORY_DATADIR = dir;
    seedJobs(dir, [{ state: 'poison', last_error: 'boom' }]);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await queueCommand(['purge', '--poison', '--json']);

    expect(logSpy).toHaveBeenCalledTimes(1);
    const output = JSON.parse(logSpy.mock.calls[0]![0] as string);
    expect(Object.keys(output).sort()).toEqual(['dumpPath', 'purged']);
    expect(output.purged).toBe(1);
    expect(typeof output.dumpPath).toBe('string');
  });

  it('AC-3: zero poison jobs is a no-op — exits 0, purged 0, no dump file, no rows mutated', async () => {
    const dir = tmpDataDir();
    process.env.ASTRA_MEMORY_DATADIR = dir;
    seedJobs(dir, [{ state: 'pending' }, { state: 'completed' }]);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((() => undefined) as unknown) as typeof process.exit);

    await queueCommand(['purge', '--poison', '--json']);

    expect(exitSpy).not.toHaveBeenCalled();
    const output = JSON.parse(logSpy.mock.calls[0]![0] as string);
    expect(output.purged).toBe(0);
    expect(output.dumpPath).toBeNull();
    expect(existsSync(join(dir, 'forensics'))).toBe(false);

    const counts = stateCounts(dir);
    expect(counts.pending).toBe(1);
    expect(counts.completed).toBe(1);
  });

  it('AC-4: only poison jobs are removed — healthy/pending counts unchanged before/after', async () => {
    const dir = tmpDataDir();
    process.env.ASTRA_MEMORY_DATADIR = dir;
    seedJobs(dir, [
      { state: 'pending' },
      { state: 'pending' },
      { state: 'running' },
      { state: 'completed' },
      { state: 'failed', last_error: 'transient' },
      { state: 'poison', last_error: 'dead' },
      { state: 'poison', last_error: 'dead2' },
    ]);

    const before = stateCounts(dir);
    expect(before.poison).toBe(2);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await queueCommand(['purge', '--poison', '--json']);

    const after = stateCounts(dir);
    expect(after.pending).toBe(before.pending);
    expect(after.running).toBe(before.running);
    expect(after.completed).toBe(before.completed);
    expect(after.failed).toBe(before.failed);
    expect(after.poison ?? 0).toBe(0);

    const output = JSON.parse(logSpy.mock.calls[0]![0] as string);
    expect(output.purged).toBe(2);
  });

  it('AC-5: creates the forensics dump directory when it does not exist', async () => {
    const dir = tmpDataDir();
    process.env.ASTRA_MEMORY_DATADIR = dir;
    seedJobs(dir, [{ state: 'poison', last_error: 'x' }]);
    expect(existsSync(join(dir, 'forensics'))).toBe(false);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await queueCommand(['purge', '--poison', '--json']);

    expect(existsSync(join(dir, 'forensics'))).toBe(true);
    const output = JSON.parse(logSpy.mock.calls[0]![0] as string);
    expect(existsSync(output.dumpPath)).toBe(true);
  });

  it('AC-5b: fails loud (exit 1, no rows deleted) if the dump dir cannot be created', async () => {
    const dir = tmpDataDir();
    process.env.ASTRA_MEMORY_DATADIR = dir;
    seedJobs(dir, [{ state: 'poison', last_error: 'x' }]);

    // Block directory creation: put a FILE where the dump dir's parent would go.
    const blockedPath = join(dir, 'blocked-not-a-dir');
    writeFileSync(blockedPath, 'i am a file, not a directory');

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((() => undefined) as unknown) as typeof process.exit);

    await queueCommand(['purge', '--poison', '--dump-dir', join(blockedPath, 'nested')]);

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errSpy.mock.calls.flat().join(' ')).toContain('failed to write forensics dump');

    // Dump failed BEFORE delete — the poison job must still be there.
    const counts = stateCounts(dir);
    expect(counts.poison).toBe(1);
  });
});
