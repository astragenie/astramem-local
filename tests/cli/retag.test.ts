import { describe, it, expect, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { openDb } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { retagCommand } from '../../src/cli/retag.js';

function tmpDataDir(): string {
  const dir = join(tmpdir(), `astra-retag-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function seedSession(dbPath: string, id: string, opts: { project?: string | null; cwd?: string | null } = {}): void {
  const db = openDb(dbPath);
  migrate(db);
  db.prepare(`
    INSERT INTO sessions (id, repo, project, branch, agent, cwd, started_at)
    VALUES (?, NULL, ?, NULL, NULL, ?, ?)
  `).run(id, opts.project ?? null, opts.cwd ?? null, Date.now());
  db.close();
}

function seedMemory(dbPath: string, opts: { repo?: string | null; project?: string | null; session_id?: string | null } = {}): string {
  const db = openDb(dbPath);
  migrate(db);
  const id = randomUUID();
  const now = Date.now();
  db.prepare(`
    INSERT INTO memories (id, type, text, normalized_text, repo, project, branch, agent, session_id,
      importance, confidence, hash, created_at, updated_at, source_hash)
    VALUES (?, 'fact', 'some fact', 'some fact', ?, ?, NULL, NULL, ?, 0.5, 0.5, ?, ?, ?, NULL)
  `).run(id, opts.repo ?? null, opts.project ?? null, opts.session_id ?? null, randomUUID(), now, now);
  db.close();
  return id;
}

const origDataDir = process.env.ASTRA_MEMORY_DATADIR;

afterEach(() => {
  if (origDataDir === undefined) delete process.env.ASTRA_MEMORY_DATADIR;
  else process.env.ASTRA_MEMORY_DATADIR = origDataDir;
  vi.restoreAllMocks();
});

describe('retagCommand', () => {
  it('tags an untagged memory from session metadata (tier-1) by default', async () => {
    const dir = tmpDataDir();
    const dbPath = join(dir, 'memory.sqlite');
    process.env.ASTRA_MEMORY_DATADIR = dir;

    const sessionId = randomUUID();
    seedSession(dbPath, sessionId, { project: 'proj-alpha', cwd: '/home/user/my-repo' });
    const memId = seedMemory(dbPath, { session_id: sessionId });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await retagCommand(['--json']);

    const output = JSON.parse(logSpy.mock.calls[0]![0] as string);
    expect(output.tier1Applied).toBe(1);
    expect(output.tier2Applied).toBe(0);
    expect(output.dryRun).toBe(false);

    const db = openDb(dbPath);
    const row = db.prepare('SELECT repo, project FROM memories WHERE id = ?').get(memId) as { repo: string; project: string };
    db.close();
    expect(row.repo).toBe('my-repo');
    expect(row.project).toBe('proj-alpha');
  });

  it('--dry-run reports proposed tags without mutating rows', async () => {
    const dir = tmpDataDir();
    const dbPath = join(dir, 'memory.sqlite');
    process.env.ASTRA_MEMORY_DATADIR = dir;

    const sessionId = randomUUID();
    seedSession(dbPath, sessionId, { project: 'proj-alpha', cwd: '/home/user/my-repo' });
    const memId = seedMemory(dbPath, { session_id: sessionId });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await retagCommand(['--dry-run', '--json']);

    const output = JSON.parse(logSpy.mock.calls[0]![0] as string);
    expect(output.dryRun).toBe(true);
    expect(output.tier1Applied).toBe(1); // counted as "would apply" even in dry-run

    const db = openDb(dbPath);
    const row = db.prepare('SELECT repo, project FROM memories WHERE id = ?').get(memId) as { repo: string | null; project: string | null };
    db.close();
    expect(row.repo).toBeNull();
    expect(row.project).toBeNull();
  });

  it('tier-2 stays off by default — no LLM provider is invoked, memory is left untagged', async () => {
    const dir = tmpDataDir();
    const dbPath = join(dir, 'memory.sqlite');
    process.env.ASTRA_MEMORY_DATADIR = dir;

    // No session metadata at all — only tier-2 could ever tag this row.
    const memId = seedMemory(dbPath, {});

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await retagCommand(['--json']);

    const output = JSON.parse(logSpy.mock.calls[0]![0] as string);
    expect(output.tier2Applied).toBe(0);
    expect(output.leftUntagged).toBe(1);

    const db = openDb(dbPath);
    const row = db.prepare('SELECT repo, project FROM memories WHERE id = ?').get(memId) as { repo: string | null; project: string | null };
    db.close();
    expect(row.repo).toBeNull();
    expect(row.project).toBeNull();
  });

  it('reports zero candidates on a fully-tagged corpus', async () => {
    const dir = tmpDataDir();
    const dbPath = join(dir, 'memory.sqlite');
    process.env.ASTRA_MEMORY_DATADIR = dir;
    seedMemory(dbPath, { repo: 'repo-a', project: 'proj-a' });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await retagCommand(['--json']);

    const output = JSON.parse(logSpy.mock.calls[0]![0] as string);
    expect(output.scanned).toBe(0);
    expect(output.tier1Applied).toBe(0);
    expect(output.tier2Applied).toBe(0);
  });
});
