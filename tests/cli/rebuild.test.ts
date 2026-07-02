import { describe, it, expect, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { openDb } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { rebuildCommand } from '../../src/cli/rebuild.js';

function tmpDataDir(): string {
  const dir = join(tmpdir(), `astra-rebuild-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function seedMemory(dataDirDb: string, opts: { repo?: string | null } = {}): string {
  const db = openDb(dataDirDb);
  migrate(db);
  const id = randomUUID();
  const now = Date.now();
  db.prepare(`
    INSERT INTO memories (id, type, text, normalized_text, repo, project, branch, agent, session_id,
      importance, confidence, hash, created_at, updated_at, source_hash)
    VALUES (?, 'fact', 'some fact', 'some fact', ?, NULL, NULL, NULL, NULL, 0.5, 0.5, ?, ?, ?, NULL)
  `).run(id, opts.repo ?? null, randomUUID(), now, now);
  db.close();
  return id;
}

const origDataDir = process.env.ASTRA_MEMORY_DATADIR;

afterEach(() => {
  if (origDataDir === undefined) delete process.env.ASTRA_MEMORY_DATADIR;
  else process.env.ASTRA_MEMORY_DATADIR = origDataDir;
  vi.restoreAllMocks();
});

describe('rebuildCommand', () => {
  it('queues one reembed job per existing memory', async () => {
    const dir = tmpDataDir();
    const dbPath = join(dir, 'memory.sqlite');
    process.env.ASTRA_MEMORY_DATADIR = dir;
    const id1 = seedMemory(dbPath);
    const id2 = seedMemory(dbPath);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await rebuildCommand(['--json']);

    const output = JSON.parse(logSpy.mock.calls[0]![0] as string);
    expect(output.candidateCount).toBe(2);
    expect(output.dryRun).toBe(false);
    expect(output.queuedIds.sort()).toEqual([id1, id2].sort());

    // Verify actual reembed jobs landed in the jobs table.
    const db = openDb(dbPath);
    const jobs = db.prepare("SELECT kind, payload_json, state FROM jobs WHERE kind = 'reembed'").all() as
      { kind: string; payload_json: string; state: string }[];
    db.close();
    expect(jobs).toHaveLength(2);
    for (const j of jobs) {
      expect(j.state).toBe('pending');
      const payload = JSON.parse(j.payload_json);
      expect(payload.kind).toBe('reembed');
      expect([id1, id2]).toContain(payload.memory_id);
    }
  });

  it('--dry-run reports candidates without queuing jobs', async () => {
    const dir = tmpDataDir();
    const dbPath = join(dir, 'memory.sqlite');
    process.env.ASTRA_MEMORY_DATADIR = dir;
    seedMemory(dbPath);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await rebuildCommand(['--dry-run', '--json']);

    const output = JSON.parse(logSpy.mock.calls[0]![0] as string);
    expect(output.candidateCount).toBe(1);
    expect(output.dryRun).toBe(true);
    expect(output.queuedIds).toEqual([]);

    const db = openDb(dbPath);
    const jobs = db.prepare("SELECT id FROM jobs WHERE kind = 'reembed'").all();
    db.close();
    expect(jobs).toHaveLength(0);
  });

  it('--repo filters candidates', async () => {
    const dir = tmpDataDir();
    const dbPath = join(dir, 'memory.sqlite');
    process.env.ASTRA_MEMORY_DATADIR = dir;
    seedMemory(dbPath, { repo: 'repo-a' });
    seedMemory(dbPath, { repo: 'repo-b' });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await rebuildCommand(['--repo', 'repo-a', '--json']);

    const output = JSON.parse(logSpy.mock.calls[0]![0] as string);
    expect(output.candidateCount).toBe(1);
  });

  it('reports zero candidates when no memories exist', async () => {
    const dir = tmpDataDir();
    process.env.ASTRA_MEMORY_DATADIR = dir;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await rebuildCommand(['--json']);

    const output = JSON.parse(logSpy.mock.calls[0]![0] as string);
    expect(output.candidateCount).toBe(0);
    expect(output.queuedIds).toEqual([]);
  });
});
