/**
 * tests/tag-hygiene/worktree-ingest-canary.test.ts — FEAT-484 AC (issue #177).
 *
 * "Ingest from a worktree path, assert the resulting memory carries the
 * project repo name, not the worktree basename." Exercises the real
 * /ingest/transcript route (same style as tests/server/ingest.test.ts)
 * against a real git repo + a real nested `.claude/worktrees/<name>` linked
 * worktree — the exact directory shape from the reported bug
 * (repo='agent-ac72934b8fdc982ea').
 *
 * `sessions.repo` is the actual fix point (src/server/routes/ingest.ts calls
 * deriveRepoFromCwd(data.cwd) at ingest time); distill later copies it
 * verbatim onto the memory row (`repo: session?.repo ?? null` —
 * src/pipeline/handlers/distill.ts / distill-events.ts do not re-derive), so
 * asserting the session-level value is what actually proves the canary
 * without needing a full (LLM-backed) distill run.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildApp } from '../../src/server/app.js';
import { openDb } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { __clearRepoIdentityCacheForTests } from '../../src/tag-hygiene/repo-identity.js';

function makeApp() {
  const db = openDb(':memory:');
  migrate(db);
  return { db, app: buildApp({ db, token: 't' }) };
}

const AUTH = { authorization: 'Bearer t', 'content-type': 'application/json' } as const;

let tmpDirs: string[] = [];

function mkTmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function git(cwd: string, args: string[]): void {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (exit ${res.status}): ${res.stderr}`);
  }
}

beforeEach(() => {
  __clearRepoIdentityCacheForTests();
});

afterEach(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  tmpDirs = [];
});

describe('FEAT-484 canary: ingest from a worktree carries the project repo name', () => {
  it('POST /ingest/transcript with cwd inside .claude/worktrees/<agent-hash> stamps sessions.repo with the MAIN checkout name, not the worktree basename', async () => {
    const root = mkTmpDir('canary-ingest-');
    const repoDir = join(root, 'astramemory-local');
    mkdirSync(repoDir);
    git(repoDir, ['init', '-q']);
    git(repoDir, ['config', 'user.email', 'test@example.com']);
    git(repoDir, ['config', 'user.name', 'Test']);
    git(repoDir, ['commit', '--allow-empty', '-q', '-m', 'init']);

    const worktreeDir = join(repoDir, '.claude', 'worktrees', 'agent-ac72934b8fdc982ea');
    mkdirSync(join(repoDir, '.claude', 'worktrees'), { recursive: true });
    git(repoDir, ['worktree', 'add', '-b', 'agent-branch', worktreeDir]);

    const { db, app } = makeApp();
    const res = await (await app).inject({
      method: 'POST',
      url: '/ingest/transcript',
      headers: AUTH,
      payload: {
        event: 'subagent_stop',
        session_id: 'sess-worktree-canary',
        project_id: 'proj-canary',
        cwd: worktreeDir,
        captured_at: '2025-06-30T10:00:00.000Z',
        turns: [
          { role: 'user', text: 'Hello from a worktree subagent' },
          { role: 'assistant', text: 'Acknowledged' },
        ],
        client_scrub_applied: true,
        client_scrub_hits: 0,
        client_version: '0.19.0',
        client_scrub_version: '1.2.0',
        wire_version: 'v1.0',
      },
    });

    expect(res.statusCode).toBe(200);

    const session = db.prepare('SELECT repo, cwd FROM sessions WHERE id = ?')
      .get('sess-worktree-canary') as { repo: string | null; cwd: string | null };

    expect(session.repo).toBe('astramemory-local');
    expect(session.repo).not.toBe('agent-ac72934b8fdc982ea');
  });
});
