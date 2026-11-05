/**
 * tests/tag-hygiene/repo-identity-backfill.test.ts — FEAT-484 (issue #177),
 * extended by FEAT-553 / DEC-017 (SLICE-445) for the `project` column, the
 * `sessions` table, and the trust-gated string-heuristic fallback for
 * deleted worktrees.
 *
 * Migration hazard coverage per the FEAT-484 dispatch: dry-run shows what
 * WOULD change without mutating; a re-stamp never guesses beyond the
 * DEC-017 trust boundary (no silent merge of unrelated memories); a row
 * already correctly stamped is left untouched (idempotent by construction);
 * re-running after an apply is a pure no-op. All fixture timestamps are in
 * the PAST (repo lesson: "verify_dont_migrate" / "valid_to means unbounded"
 * both trace back to a migration fixture whose 'now' wasn't).
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

function insertSession(
  db: DB,
  id: string,
  opts: { repo?: string | null; project?: string | null; cwd?: string | null },
): void {
  db.prepare(`
    INSERT INTO sessions (id, repo, project, branch, agent, cwd, started_at)
    VALUES (?, ?, ?, NULL, NULL, ?, ?)
  `).run(id, opts.repo ?? null, opts.project ?? null, opts.cwd ?? null, PAST_NOW);
}

function insertMemory(
  db: DB,
  opts: { text?: string; repo?: string | null; project?: string | null; session_id?: string | null },
): string {
  const id = randomUUID();
  const text = opts.text ?? 'some memory text';
  db.prepare(`
    INSERT INTO memories (id, type, text, normalized_text, repo, project, branch, agent, session_id,
      importance, confidence, hash, created_at, updated_at, source_hash)
    VALUES (?, 'fact', ?, ?, ?, ?, NULL, NULL, ?, 0.5, 0.5, ?, ?, ?, NULL)
  `).run(
    id, text, text.toLowerCase(), opts.repo ?? null, opts.project ?? null,
    opts.session_id ?? null, randomUUID(), PAST_NOW, PAST_NOW,
  );
  return id;
}

function getMemoryColumn(db: DB, memId: string, column: 'repo' | 'project'): string | null {
  const row = db.prepare(`SELECT ${column} as value FROM memories WHERE id = ?`).get(memId) as { value: string | null };
  return row.value;
}

function getSessionColumn(db: DB, sessionId: string, column: 'repo' | 'project'): string | null {
  const row = db.prepare(`SELECT ${column} as value FROM sessions WHERE id = ?`).get(sessionId) as { value: string | null };
  return row.value;
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

describe('runRepoIdentityBackfill — repo column (default, FEAT-484)', () => {
  it('dry-run: reports the proposed change WITHOUT mutating any row', () => {
    const db = setupDb();
    const { worktreeDir } = makeWorktreeFixture('astramemory-local', 'agent-ac72934b8fdc982ea');
    const sessionId = randomUUID();
    insertSession(db, sessionId, { repo: 'agent-ac72934b8fdc982ea', cwd: worktreeDir });
    const memId = insertMemory(db, { session_id: sessionId, repo: 'agent-ac72934b8fdc982ea' });

    const result = runRepoIdentityBackfill(db, { dryRun: true });

    expect(result.column).toBe('repo'); // default, unspecified
    expect(result.dryRun).toBe(true);
    expect(result.scanned).toBe(1);
    expect(result.applied).toBe(1);
    const candidate = result.candidates.find(c => c.memoryId === memId)!;
    expect(candidate.resolvedValue).toBe('astramemory-local');
    expect(candidate.applied).toBe(false); // dry-run never applies

    // Row is untouched on disk.
    expect(getMemoryColumn(db, memId, 'repo')).toBe('agent-ac72934b8fdc982ea');
  });

  it('apply: re-stamps the row to the git-resolved identity', () => {
    const db = setupDb();
    const { worktreeDir } = makeWorktreeFixture('astramemory-local', 'agent-ac72934b8fdc982ea');
    const sessionId = randomUUID();
    insertSession(db, sessionId, { repo: 'agent-ac72934b8fdc982ea', cwd: worktreeDir });
    const memId = insertMemory(db, { session_id: sessionId, repo: 'agent-ac72934b8fdc982ea' });

    const result = runRepoIdentityBackfill(db, { dryRun: false });
    expect(result.applied).toBe(1);

    expect(getMemoryColumn(db, memId, 'repo')).toBe('astramemory-local');
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
    expect(getMemoryColumn(db, memId, 'repo')).toBe('astramemory-local');
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

    expect(getMemoryColumn(db, memA, 'repo')).toBe('repo-alpha');
    expect(getMemoryColumn(db, memB, 'repo')).toBe('repo-beta');
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
    expect(candidate.resolvedValue).toBe('astramemory-local');
    expect(candidate.joiningExistingCount).toBe(2);
  });
});

describe('runRepoIdentityBackfill — AC-4: no-session / no-cwd / unresolved never-guess guard', () => {
  it("reason 'no-session': memory row has no session_id at all", () => {
    const db = setupDb();
    const memId = insertMemory(db, { session_id: null, repo: 'agent-aaaa00000001' });

    const result = runRepoIdentityBackfill(db, { dryRun: true });

    expect(result.scanned).toBe(1);
    expect(result.unresolved).toBe(1);
    const candidate = result.candidates.find(c => c.memoryId === memId)!;
    expect(candidate.reason).toBe('no-session');
    expect(candidate.resolvedValue).toBeNull();
  });

  it("reason 'no-cwd': the session exists but recorded no cwd", () => {
    const db = setupDb();
    const sessionId = randomUUID();
    insertSession(db, sessionId, { repo: 'agent-bbbb00000002', cwd: null });
    const memId = insertMemory(db, { session_id: sessionId, repo: 'agent-bbbb00000002' });

    const result = runRepoIdentityBackfill(db, { dryRun: true });

    expect(result.unresolved).toBe(1);
    const candidate = result.candidates.find(c => c.memoryId === memId)!;
    expect(candidate.reason).toBe('no-cwd');
    expect(candidate.resolvedValue).toBeNull();
  });

  it(
    "DELETED-WORKTREE STRING FALLBACK (DEC-017 rule 1/4): a cwd that structurally matches the " +
    'trusted nested .claude/worktrees/<x> layout resolves via the string heuristic even though ' +
    "the worktree directory no longer exists on disk and git can't answer",
    () => {
      const db = setupDb();
      const sessionId = randomUUID();
      // This directory was never created (mkdtempSync not called) — simulates
      // a worktree Claude Code already tore down by the time backfill runs.
      // git resolution MUST fail (ENOENT), but the path shape itself is one
      // of the two DEC-017-trusted layouts, so the string heuristic recovers
      // the repo name from the path string alone.
      insertSession(db, sessionId, {
        repo: 'agent-dead0beef123',
        cwd: 'C:\\work\\mega\\astramemory-local\\.claude\\worktrees\\agent-dead0beef123',
      });
      const memId = insertMemory(db, { session_id: sessionId, repo: 'agent-dead0beef123' });

      const result = runRepoIdentityBackfill(db, { dryRun: true });

      expect(result.scanned).toBe(1);
      expect(result.applied).toBe(1);
      expect(result.unresolved).toBe(0);
      const candidate = result.candidates.find(c => c.memoryId === memId)!;
      expect(candidate.resolvedValue).toBe('astramemory-local');
      expect(candidate.reason).toBeUndefined();
    },
  );

  it(
    "GENUINE NEVER-GUESS (DEC-017 rule 1): a cwd that matches NEITHER trusted worktree layout " +
    'stays unresolved even though it no longer exists on disk and the bad-shape pattern matched it',
    () => {
      const db = setupDb();
      const sessionId = randomUUID();
      // Not nested under .claude/worktrees, not a <repo>-worktrees sibling —
      // just some ordinary (deleted/never-existed) directory whose last
      // segment happens to look like one of the ephemeral shapes. There is
      // no recoverable repo-name segment in this path at all.
      insertSession(db, sessionId, {
        repo: 'agent-deadbeef12345',
        cwd: 'C:\\work\\mega\\some-random-scratch-dir\\agent-deadbeef12345',
      });
      const memId = insertMemory(db, { session_id: sessionId, repo: 'agent-deadbeef12345' });

      const result = runRepoIdentityBackfill(db, { dryRun: true });

      expect(result.scanned).toBe(1);
      expect(result.applied).toBe(0);
      expect(result.unresolved).toBe(1);
      const candidate = result.candidates.find(c => c.memoryId === memId)!;
      expect(candidate.resolvedValue).toBeNull();
      expect(candidate.reason).toBe('unresolved');

      // Still untouched on disk.
      expect(getMemoryColumn(db, memId, 'repo')).toBe('agent-deadbeef12345');
    },
  );
});

describe('runRepoIdentityBackfill — project column (FEAT-553)', () => {
  it('dry-run: resolves a mis-tagged project the same way repo does, without mutating', () => {
    const db = setupDb();
    const { worktreeDir } = makeWorktreeFixture('astramemory-local', 'agent-cccc00000003');
    const sessionId = randomUUID();
    insertSession(db, sessionId, { project: 'agent-cccc00000003', cwd: worktreeDir });
    const memId = insertMemory(db, { session_id: sessionId, project: 'agent-cccc00000003' });

    const result = runRepoIdentityBackfill(db, { dryRun: true, column: 'project' });

    expect(result.column).toBe('project');
    expect(result.scanned).toBe(1);
    expect(result.applied).toBe(1);
    const candidate = result.candidates.find(c => c.memoryId === memId)!;
    expect(candidate.resolvedValue).toBe('astramemory-local');
    expect(candidate.applied).toBe(false);

    expect(getMemoryColumn(db, memId, 'project')).toBe('agent-cccc00000003');
  });

  it('apply: re-stamps memories.project to the resolved identity', () => {
    const db = setupDb();
    const { worktreeDir } = makeWorktreeFixture('astramemory-local', 'agent-dddd00000004');
    const sessionId = randomUUID();
    insertSession(db, sessionId, { project: 'agent-dddd00000004', cwd: worktreeDir });
    const memId = insertMemory(db, { session_id: sessionId, project: 'agent-dddd00000004' });

    const result = runRepoIdentityBackfill(db, { dryRun: false, column: 'project' });
    expect(result.applied).toBe(1);

    expect(getMemoryColumn(db, memId, 'project')).toBe('astramemory-local');
  });

  it('idempotent: a second project-column pass after apply finds nothing left to scan', () => {
    const db = setupDb();
    const { worktreeDir } = makeWorktreeFixture('astramemory-local', 'agent-eeee00000005');
    const sessionId = randomUUID();
    insertSession(db, sessionId, { project: 'agent-eeee00000005', cwd: worktreeDir });
    insertMemory(db, { session_id: sessionId, project: 'agent-eeee00000005' });

    const first = runRepoIdentityBackfill(db, { dryRun: false, column: 'project' });
    expect(first.applied).toBe(1);

    const second = runRepoIdentityBackfill(db, { dryRun: false, column: 'project' });
    expect(second.scanned).toBe(0);
    expect(second.applied).toBe(0);
  });

  it('operating on project leaves repo completely untouched, and vice-versa', () => {
    const db = setupDb();
    const { worktreeDir } = makeWorktreeFixture('astramemory-local', 'agent-ffff00000006');
    const sessionId = randomUUID();
    insertSession(db, sessionId, {
      repo: 'agent-ffff00000006', project: 'agent-ffff00000006', cwd: worktreeDir,
    });
    const memId = insertMemory(db, {
      session_id: sessionId, repo: 'agent-ffff00000006', project: 'agent-ffff00000006',
    });

    runRepoIdentityBackfill(db, { dryRun: false, column: 'project' });

    expect(getMemoryColumn(db, memId, 'project')).toBe('astramemory-local');
    // repo was never selected by this pass (column: 'project') — untouched.
    expect(getMemoryColumn(db, memId, 'repo')).toBe('agent-ffff00000006');
  });
});

describe('runRepoIdentityBackfill — includeSessions re-stamp (FEAT-553)', () => {
  it('dry-run: reports sessionsRestamped without mutating the sessions row', () => {
    const db = setupDb();
    const { worktreeDir } = makeWorktreeFixture('astramemory-local', 'agent-aaaa10000007');
    const sessionId = randomUUID();
    insertSession(db, sessionId, { repo: 'agent-aaaa10000007', cwd: worktreeDir });
    insertMemory(db, { session_id: sessionId, repo: 'agent-aaaa10000007' });

    const result = runRepoIdentityBackfill(db, { dryRun: true, includeSessions: true });

    expect(result.sessionsRestamped).toBe(1);
    // Still untouched on disk — dry-run never mutates sessions either.
    expect(getSessionColumn(db, sessionId, 'repo')).toBe('agent-aaaa10000007');
  });

  it('apply: re-stamps sessions.repo to the same resolved identity as its memories', () => {
    const db = setupDb();
    const { worktreeDir } = makeWorktreeFixture('astramemory-local', 'agent-aaaa20000008');
    const sessionId = randomUUID();
    insertSession(db, sessionId, { repo: 'agent-aaaa20000008', cwd: worktreeDir });
    insertMemory(db, { session_id: sessionId, repo: 'agent-aaaa20000008' });

    const result = runRepoIdentityBackfill(db, { dryRun: false, includeSessions: true });

    expect(result.sessionsRestamped).toBe(1);
    expect(getSessionColumn(db, sessionId, 'repo')).toBe('astramemory-local');
  });

  it('apply: re-stamps sessions.project when column is project', () => {
    const db = setupDb();
    const { worktreeDir } = makeWorktreeFixture('astramemory-local', 'agent-aaaa30000009');
    const sessionId = randomUUID();
    insertSession(db, sessionId, { project: 'agent-aaaa30000009', cwd: worktreeDir });
    insertMemory(db, { session_id: sessionId, project: 'agent-aaaa30000009' });

    const result = runRepoIdentityBackfill(db, {
      dryRun: false, column: 'project', includeSessions: true,
    });

    expect(result.sessionsRestamped).toBe(1);
    expect(getSessionColumn(db, sessionId, 'project')).toBe('astramemory-local');
  });

  it('counts each session only ONCE even when multiple memories share it', () => {
    const db = setupDb();
    const { worktreeDir } = makeWorktreeFixture('astramemory-local', 'agent-aaaa4000000a');
    const sessionId = randomUUID();
    insertSession(db, sessionId, { repo: 'agent-aaaa4000000a', cwd: worktreeDir });
    insertMemory(db, { session_id: sessionId, repo: 'agent-aaaa4000000a' });
    insertMemory(db, { session_id: sessionId, repo: 'agent-aaaa4000000a' });
    insertMemory(db, { session_id: sessionId, repo: 'agent-aaaa4000000a' });

    const result = runRepoIdentityBackfill(db, { dryRun: false, includeSessions: true });

    expect(result.applied).toBe(3); // 3 memories re-stamped
    expect(result.sessionsRestamped).toBe(1); // but only 1 distinct session
    expect(getSessionColumn(db, sessionId, 'repo')).toBe('astramemory-local');
  });

  it('defaults to NOT touching sessions when includeSessions is omitted (byte-identical FEAT-484 default)', () => {
    const db = setupDb();
    const { worktreeDir } = makeWorktreeFixture('astramemory-local', 'agent-aaaa5000000b');
    const sessionId = randomUUID();
    insertSession(db, sessionId, { repo: 'agent-aaaa5000000b', cwd: worktreeDir });
    insertMemory(db, { session_id: sessionId, repo: 'agent-aaaa5000000b' });

    const result = runRepoIdentityBackfill(db, { dryRun: false });

    expect(result.sessionsRestamped).toBe(0);
    expect(getSessionColumn(db, sessionId, 'repo')).toBe('agent-aaaa5000000b');
  });

  it('does not re-stamp a session already carrying the resolved value (no spurious count)', () => {
    const db = setupDb();
    const { worktreeDir } = makeWorktreeFixture('astramemory-local', 'agent-aaaa6000000c');
    const sessionId = randomUUID();
    // Session's own repo column is already correct — only the memory is
    // still mis-tagged (e.g. a prior partial fix touched the session but
    // not yet this memory).
    insertSession(db, sessionId, { repo: 'astramemory-local', cwd: worktreeDir });
    insertMemory(db, { session_id: sessionId, repo: 'agent-aaaa6000000c' });

    const result = runRepoIdentityBackfill(db, { dryRun: false, includeSessions: true });

    expect(result.applied).toBe(1);
    expect(result.sessionsRestamped).toBe(0);
    expect(getSessionColumn(db, sessionId, 'repo')).toBe('astramemory-local');
  });
});

describe('runRepoIdentityBackfill — --column all composition (FEAT-553 CLI)', () => {
  it(
    'two independent single-column passes (what the CLI --column all flag composes) each ' +
    'scan/resolve/apply their own column without interfering with the other',
    () => {
      const db = setupDb();
      const repoFixture = makeWorktreeFixture('repo-side-project', 'agent-aaaa7000000d');
      const projFixture = makeWorktreeFixture('project-side-project', 'agent-aaaa8000000e');

      const repoSession = randomUUID();
      insertSession(db, repoSession, { repo: 'agent-aaaa7000000d', cwd: repoFixture.worktreeDir });
      const repoMem = insertMemory(db, { session_id: repoSession, repo: 'agent-aaaa7000000d' });

      const projSession = randomUUID();
      insertSession(db, projSession, { project: 'agent-aaaa8000000e', cwd: projFixture.worktreeDir });
      const projMem = insertMemory(db, { session_id: projSession, project: 'agent-aaaa8000000e' });

      const repoResult = runRepoIdentityBackfill(db, { dryRun: false, column: 'repo' });
      const projectResult = runRepoIdentityBackfill(db, { dryRun: false, column: 'project' });

      expect(repoResult.column).toBe('repo');
      expect(repoResult.applied).toBe(1);
      expect(projectResult.column).toBe('project');
      expect(projectResult.applied).toBe(1);

      expect(getMemoryColumn(db, repoMem, 'repo')).toBe('repo-side-project');
      expect(getMemoryColumn(db, projMem, 'project')).toBe('project-side-project');
    },
  );
});
