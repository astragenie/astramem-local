import { describe, it, expect, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { openDb } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { queueCommand } from '../../src/cli/queue.js';

function tmpDataDir(): string {
  const dir = join(tmpdir(), `astra-queue-test-${randomUUID()}`);
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
      VALUES (?, ?, '{}', ?, 0, ?, ?, ?)
    `).run(randomUUID(), j.kind ?? 'distill', j.state, j.last_error ?? null, now, now);
  }
  db.close();
}

const origDataDir = process.env.ASTRA_MEMORY_DATADIR;

afterEach(() => {
  if (origDataDir === undefined) delete process.env.ASTRA_MEMORY_DATADIR;
  else process.env.ASTRA_MEMORY_DATADIR = origDataDir;
  vi.restoreAllMocks();
});

describe('queueCommand', () => {
  it('reports zero jobs when the queue is empty', async () => {
    const dir = tmpDataDir();
    process.env.ASTRA_MEMORY_DATADIR = dir;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await queueCommand(['--json']);

    const output = JSON.parse(logSpy.mock.calls[0]![0] as string);
    expect(output.counts).toEqual([]);
    expect(output.recentFailures).toEqual([]);
  });

  it('reports state counts and recent failures with last_error', async () => {
    const dir = tmpDataDir();
    process.env.ASTRA_MEMORY_DATADIR = dir;
    seedJobs(dir, [
      { state: 'pending' },
      { state: 'pending' },
      { state: 'completed' },
      { state: 'failed', last_error: 'boom: extraction timed out' },
      { state: 'poison', last_error: 'deterministic parse failure' },
    ]);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await queueCommand(['--json']);

    const output = JSON.parse(logSpy.mock.calls[0]![0] as string);
    const byState = Object.fromEntries(output.counts.map((c: { state: string; n: number }) => [c.state, c.n]));
    expect(byState.pending).toBe(2);
    expect(byState.completed).toBe(1);
    expect(byState.failed).toBe(1);
    expect(byState.poison).toBe(1);

    expect(output.recentFailures).toHaveLength(2);
    const errors = output.recentFailures.map((f: { last_error: string }) => f.last_error);
    expect(errors).toContain('boom: extraction timed out');
    expect(errors).toContain('deterministic parse failure');
  });

  it('non-JSON mode prints a human-readable table without throwing', async () => {
    const dir = tmpDataDir();
    process.env.ASTRA_MEMORY_DATADIR = dir;
    seedJobs(dir, [{ state: 'pending' }]);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await queueCommand([]);

    const printed = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(printed).toContain('AstraMemory Job Queue');
    expect(printed).toContain('pending');
  });
});
