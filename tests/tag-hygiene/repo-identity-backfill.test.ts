/**
 * tests/tag-hygiene/repo-identity-backfill.test.ts — FEAT-484 (issue #177).
 *
 * Migration hazard coverage per the FEAT-484 dispatch: dry-run shows what
 * WOULD change without mutating; a re-stamp never guesses when git can't
 * resolve (no silent merge of unrelated memories); a row already correctly
 * stamped is left untouched (idempotent by construction); re-running after
 * an apply is a pure no-op. All fixture timestamps are in the PAST (repo
 * lesson: "verify_dont_migrate" / "valid_to means unbounded" both trace back
 * to a migration fixture whose 'now' wasn't).
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { runRepoIdentityBackfill } from '../../src/tag-hygiene/repo-identity-backfill.js';
import { __clearRepoIdentityCacheForTests } from '../../src/tag-hygiene/repo-identity.js';
import type { DB } from '../../src/storage/db.js';

// A fixed point safely in the past (repo lesson: fixture 'now' must never be
// the actual present when validity/backfill logic is under test).
const PAST_NOW = Date.parse('2026-01-01T00:00:00.000Z');

function setupDb(): DB {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

function insertSession(db: DB, id: string, opts: { repo?: string | null; cwd?: string | null }): void {
  db.prepare(`
    INSERT INTO sessions (id, repo, project, branch, agent, cwd, started_at)
    VALUES (?, ?, NULL, NULL, NULL, ?, ?)
  `).run(id, opts.repo ?? null, opts.cwd ?? null, PAST_NOW);
}

function insertMemory(
  db: DB,
  opts: { text?: string; repo?: string | null; session_id?: string | null },
): string {
  const id = randomUUID();
  const text = opts.text ?? 'some memory text';
  db.prepare(`
    INSERT INTO memories (id, type, text, normalized_text, repo, project, branch, agent, session_id,
      importance, confidence, hash, created_at, updated_at, source_hash)
    VALUES (?, 'fact', ?, ?, ?, NULL, NULL, NULL, ?, 0.5, 0.5, ?, ?, ?, NULL)
  `).run(id, text, text.toLowerCase(), opts.repo ?? null, opts.session_id ?? null, randomUUID(), PAST_NOW, PAST_NOW);
  return id;
}

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

/** Builds a real repo + a real nested `.claude/worktrees/<name>` linked
 *  worktree, matching the FEAT-484 bug shape exactly. Returns both paths. */
function makeWorktreeFixture(repoName: string, worktreeName: string): { repoDir: string; worktreeDir: string } {
  const root = mkTmpDir('repoidbackfill-');
  const repoDir = join(root, repoName);
  mkdirSync(repoDir);
  git(repoDir, ['init', '-q']);
  git(repoDir, ['config', 'user.email', 'test@example.com']);
  git(repoDir, ['config', 'user.name', 'Test']);
  git(repoDir, ['commit', '--allow-empty', '-q', '-m', 'init']);

  const worktreeDir = join(repoDir, '.claude', 'worktrees', worktreeName);
  mkdirSync(join(repoDir, '.claude', 'worktrees'), { recursive: true });
  git(repoDir, ['worktree', 'add', '-b', `${worktreeName}-branch`, worktreeDir]);

  return { repoDir, worktreeDir };
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

describe('runRepoIdentityBackfill', () => {
  it('dry-run: reports the proposed change WITHOUT mutating any row', () => {
    const db = setupDb();
    const { worktreeDir } = makeWorktreeFixture('astramemory-local', 'agent-ac72934b8fdc982ea');
    const sessionId = randomUUID();
    insertSession(db, sessionId, { repo: 'agent-ac72934b8fdc982ea', cwd: worktreeDir });
    const memId = insertMemory(db, { session_id: sessionId, repo: 'agent-ac72934b8fdc982ea' });

    const result = runRepoIdentityBackfill(db, { dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.scanned).toBe(1);
    expect(result.applied).toBe(1);
    const candidate = result.candidates.find(c => c.memoryId === memId)!;
    expect(candidate.resolvedRepo).toBe('astramemory-local');
    expect(candidate.applied).toBe(false); // dry-run never applies

    // Row is untouched on disk.
    const row = db.prepare('SELECT repo FROM memories WHERE id = ?').get(memId) as { repo: string };
    expect(row.repo).toBe('agent-ac72934b8fdc982ea');
  });

  it('apply: re-stamps the row to the git-resolved identity', () => {
    const db = setupDb();
    const { worktreeDir } = makeWorktreeFixture('astramemory-local', 'agent-ac72934b8fdc982ea');
    const sessionId = randomUUID();
    insertSession(db, sessionId, { repo: 'agent-ac72934b8fdc982ea', cwd: worktreeDir });
    const memId = insertMemory(db, { session_id: sessionId, repo: 'agent-ac72934b8fdc982ea' });

    const result = runRepoIdentityBackfill(db, { dryRun: false });
    expect(result.applied).toBe(1);

    const row = db.prepare('SELECT repo FROM memories WHERE id = ?').get(memId) as { repo: string };
    expect(row.repo).toBe('astramemory-local');
  });

  it('idempotent: re-running after apply finds nothing left to scan (pattern no longer matches)', () => {
    const db = setupDb();
    const { worktreeDir } = makeWorktreeFixture('astramemory-local', 'agent-1de401091234');
    const sessionId = randomUUID();
    insertSession(db, sessionId, { repo: 'agent-1de401091234', cwd: worktreeDir });
    insertMemory(db, { session_id: sessionId, repo: 'agent-1de401091234' });

    const first = runRepoIdentityBackfill(db, { dryRun: false });
    expect(first.applied).toBe(1);

    const second = runRepoIdentityBackfill(db, { dryRun: false });
    expect(second.scanned).toBe(0);
    expect(second.applied).toBe(0);
  });

  it('never mutates a row already correctly tagged (does not match the bad-shape pattern)', () => {
    const db = setupDb();
    const sessionId = randomUUID();
    insertSession(db, sessionId, { repo: 'astramemory-local', cwd: 'C:\\work\\astramemory-local' });
    const memId = insertMemory(db, { session_id: sessionId, repo: 'astramemory-local' });

    const result = runRepoIdentityBackfill(db, { dryRun: false });

    expect(result.scanned).toBe(0);
    expect(result.applied).toBe(0);
    const row = db.prepare('SELECT repo FROM memories WHERE id = ?').get(memId) as { repo: string };
    expect(row.repo).toBe('astramemory-local');
  });

  it('MIGRATION HAZARD guard: never guesses when the worktree is already gone — leaves the row unresolved, does not merge into an unrelated repo', () => {
    const db = setupDb();
    const sessionId = randomUUID();
    // cwd points at a path that was never a real directory (worktree already
    // cleaned up) — git resolution must fail, and the backfill must NOT fall
    // back to some other repo's name.
    insertSession(db, sessionId, {
      repo: 'agent-dead0beef123',
      cwd: 'C:\\work\\mega\\astramemory-local\\.claude\\worktrees\\agent-dead0beef123',
    });
    const memId = insertMemory(db, { session_id: sessionId, repo: 'agent-dead0beef123' });

    const result = runRepoIdentityBackfill(db, { dryRun: true });

    expect(result.scanned).toBe(1);
    expect(result.applied).toBe(0);
    expect(result.unresolved).toBe(1);
    const candidate = result.candidates.find(c => c.memoryId === memId)!;
    expect(candidate.resolvedRepo).toBeNull();
    expect(candidate.reason).toBe('unresolved');
  });

  it('does not collide two UNRELATED mis-tagged memories from different repos into the same identity', () => {
    const db = setupDb();
    const fixtureA = makeWorktreeFixture('repo-alpha', 'agent-aaaa1111');
    const fixtureB = makeWorktreeFixture('repo-beta', 'agent-bbbb2222');

    const sessionA = randomUUID();
    insertSession(db, sessionA, { repo: 'agent-aaaa1111', cwd: fixtureA.worktreeDir });
    const memA = insertMemory(db, { session_id: sessionA, repo: 'agent-aaaa1111' });

    const sessionB = randomUUID();
    insertSession(db, sessionB, { repo: 'agent-bbbb2222', cwd: fixtureB.worktreeDir });
    const memB = insertMemory(db, { session_id: sessionB, repo: 'agent-bbbb2222' });

    const result = runRepoIdentityBackfill(db, { dryRun: false });
    expect(result.applied).toBe(2);

    const rowA = db.prepare('SELECT repo FROM memories WHERE id = ?').get(memA) as { repo: string };
    const rowB = db.prepare('SELECT repo FROM memories WHERE id = ?').get(memB) as { repo: string };
    expect(rowA.repo).toBe('repo-alpha');
    expect(rowB.repo).toBe('repo-beta');
    expect(rowA.repo).not.toBe(rowB.repo);
  });

  it('reports joiningExistingCount so a dry-run reviewer can see the consolidation-grouping merge blast radius', () => {
    const db = setupDb();
    const { worktreeDir } = makeWorktreeFixture('astramemory-local', 'agent-cccc3333');

    // Two memories already correctly tagged 'astramemory-local'.
    const mainSession = randomUUID();
    insertSession(db, mainSession, { repo: 'astramemory-local', cwd: null });
    insertMemory(db, { session_id: mainSession, repo: 'astramemory-local' });
    insertMemory(db, { session_id: mainSession, repo: 'astramemory-local' });

    // One mis-tagged memory that will resolve to the same identity.
    const wtSession = randomUUID();
    insertSession(db, wtSession, { repo: 'agent-cccc3333', cwd: worktreeDir });
    const memId = insertMemory(db, { session_id: wtSession, repo: 'agent-cccc3333' });

    const result = runRepoIdentityBackfill(db, { dryRun: true });
    const candidate = result.candidates.find(c => c.memoryId === memId)!;
    expect(candidate.resolvedRepo).toBe('astramemory-local');
    expect(candidate.joiningExistingCount).toBe(2);
  });
});
