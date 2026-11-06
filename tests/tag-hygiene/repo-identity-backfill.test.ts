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
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
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
// AC-8 evidence: the dashboard dropdown half of AC-8 is verified here by
// importing the REAL, unmodified query (read-only import — this file does
// not edit src/server/queries/dashboard.ts, which is out of this slice's
// touches_files scope) and asserting its behavior post-backfill.
import { queryProjectOptions } from '../../src/server/queries/dashboard.js';
// CLI-layer evidence (AC-6/AC-9 argv wiring): exercises the actual CLI
// entry point against a file-backed temp datadir via ASTRA_MEMORY_DATADIR
// (the same safe-isolation pattern tests/cli/queue-purge.test.ts already
// uses for a sibling openRuntimeDb()-based command) — never the production
// datadir.
import { repoIdentityBackfillCommand } from '../../src/cli/repo-identity-backfill.js';

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

/** Seeds a FILE-backed datadir (not :memory:) the way the CLI layer opens
 *  it (`openRuntimeDb` via `ASTRA_MEMORY_DATADIR`), for CLI-layer tests
 *  that must exercise `repoIdentityBackfillCommand` itself rather than
 *  calling the core function directly. Mirrors the seed/close pattern
 *  tests/cli/queue-purge.test.ts already uses for a sibling
 *  openRuntimeDb()-based command. */
function seedFileDb(dataDir: string, seed: (db: DB) => void): void {
  const db = openDb(join(dataDir, 'memory.sqlite'));
  migrate(db);
  seed(db);
  db.close();
}

function readFileDbColumn(
  dataDir: string,
  table: 'memories' | 'sessions',
  column: 'repo' | 'project',
  id: string,
): string | null {
  const db = openDb(join(dataDir, 'memory.sqlite'));
  const row = db.prepare(`SELECT ${column} as value FROM ${table} WHERE id = ?`).get(id) as { value: string | null };
  db.close();
  return row.value;
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

describe('runRepoIdentityBackfill — AC-6: two consecutive dry-runs are byte-identical', () => {
  it(
    'calling dryRun:true TWICE in a row against the same unmodified DB reports identical ' +
    'scanned/applied/unresolved/sessionsRestamped counts and identical candidate lists — proving ' +
    'dry-run performs zero writes across repeats, not just on the first call',
    () => {
      const db = setupDb();
      const { worktreeDir } = makeWorktreeFixture('astramemory-local', 'agent-feed00000f01');
      const resolvableSession = randomUUID();
      insertSession(db, resolvableSession, { repo: 'agent-feed00000f01', cwd: worktreeDir });
      const memId = insertMemory(db, { session_id: resolvableSession, repo: 'agent-feed00000f01' });

      // A genuinely-unresolvable row alongside it, so the identical-ness
      // check also covers the unresolved branch, not just the happy path.
      const unresolvableSession = randomUUID();
      insertSession(db, unresolvableSession, { repo: 'agent-deadfeed0f02', cwd: null });
      insertMemory(db, { session_id: unresolvableSession, repo: 'agent-deadfeed0f02' });

      const first = runRepoIdentityBackfill(db, { dryRun: true, includeSessions: true });
      const second = runRepoIdentityBackfill(db, { dryRun: true, includeSessions: true });

      expect(second.scanned).toBe(first.scanned);
      expect(second.applied).toBe(first.applied);
      expect(second.unresolved).toBe(first.unresolved);
      expect(second.sessionsRestamped).toBe(first.sessionsRestamped);
      expect(second.dryRun).toBe(first.dryRun);
      expect(second.candidates).toEqual(first.candidates);

      // And still truly a no-op after TWO passes, not just one.
      expect(getMemoryColumn(db, memId, 'repo')).toBe('agent-feed00000f01');
      expect(getSessionColumn(db, resolvableSession, 'repo')).toBe('agent-feed00000f01');
    },
  );

  it(
    'the same byte-identical property holds for the project column + --sessions combination',
    () => {
      const db = setupDb();
      const { worktreeDir } = makeWorktreeFixture('astramemory-local', 'agent-feed00000f03');
      const sessionId = randomUUID();
      insertSession(db, sessionId, { project: 'agent-feed00000f03', cwd: worktreeDir });
      insertMemory(db, { session_id: sessionId, project: 'agent-feed00000f03' });

      const first = runRepoIdentityBackfill(db, { dryRun: true, column: 'project', includeSessions: true });
      const second = runRepoIdentityBackfill(db, { dryRun: true, column: 'project', includeSessions: true });

      expect(second).toEqual(first);
    },
  );
});

describe('runRepoIdentityBackfill — AC-8: post-apply counts are fully accounted for (memories AND sessions)', () => {
  it(
    'repo column + --sessions: after apply, GLOB agent-* counts on BOTH memories and sessions ' +
    'equal result.unresolved (no row silently left behind on either table)',
    () => {
      const db = setupDb();
      const { worktreeDir } = makeWorktreeFixture('astramemory-local', 'agent-aaaa900000f0');
      const resolvableSession = randomUUID();
      insertSession(db, resolvableSession, { repo: 'agent-aaaa900000f0', cwd: worktreeDir });
      insertMemory(db, { session_id: resolvableSession, repo: 'agent-aaaa900000f0' });

      // Genuinely unresolvable (AC-4 'unresolved' reason): a recorded cwd
      // that matches NEITHER trusted worktree layout — stays agent-* on
      // both tables after apply.
      const unresolvableSession = randomUUID();
      insertSession(db, unresolvableSession, {
        repo: 'agent-deadbeef9001',
        cwd: 'C:\\work\\mega\\some-random-scratch-dir\\agent-deadbeef9001',
      });
      insertMemory(db, { session_id: unresolvableSession, repo: 'agent-deadbeef9001' });

      const result = runRepoIdentityBackfill(db, { dryRun: false, includeSessions: true });
      expect(result.applied).toBe(1);
      expect(result.unresolved).toBe(1);

      const memGlobCount = (
        db.prepare(`SELECT COUNT(*) as n FROM memories WHERE repo GLOB 'agent-*'`).get() as { n: number }
      ).n;
      const sessionGlobCount = (
        db.prepare(`SELECT COUNT(*) as n FROM sessions WHERE repo GLOB 'agent-*'`).get() as { n: number }
      ).n;

      expect(memGlobCount).toBe(result.unresolved);
      expect(sessionGlobCount).toBe(result.unresolved);
    },
  );

  it(
    'project column + --sessions: same GLOB-count parity on BOTH memories and sessions',
    () => {
      const db = setupDb();
      const { worktreeDir } = makeWorktreeFixture('astramemory-local', 'agent-bbbb900000f1');
      const resolvableSession = randomUUID();
      insertSession(db, resolvableSession, { project: 'agent-bbbb900000f1', cwd: worktreeDir });
      insertMemory(db, { session_id: resolvableSession, project: 'agent-bbbb900000f1' });

      const unresolvableSession = randomUUID();
      insertSession(db, unresolvableSession, {
        project: 'agent-deadbeef9002',
        cwd: 'C:\\work\\mega\\some-random-scratch-dir\\agent-deadbeef9002',
      });
      insertMemory(db, { session_id: unresolvableSession, project: 'agent-deadbeef9002' });

      const result = runRepoIdentityBackfill(db, { dryRun: false, column: 'project', includeSessions: true });
      expect(result.applied).toBe(1);
      expect(result.unresolved).toBe(1);

      const memGlobCount = (
        db.prepare(`SELECT COUNT(*) as n FROM memories WHERE project GLOB 'agent-*'`).get() as { n: number }
      ).n;
      const sessionGlobCount = (
        db.prepare(`SELECT COUNT(*) as n FROM sessions WHERE project GLOB 'agent-*'`).get() as { n: number }
      ).n;

      expect(memGlobCount).toBe(result.unresolved);
      expect(sessionGlobCount).toBe(result.unresolved);
    },
  );

  it(
    "the dashboard's queryProjectOptions (src/server/queries/dashboard.ts, read-only import — " +
    'not edited by this slice) lists only resolvable project names plus the explicitly-' +
    'unresolved remainder after apply, so AC-8\'s dashboard-dropdown half holds without any ' +
    'change to dashboard.ts',
    () => {
      const db = setupDb();
      const { worktreeDir } = makeWorktreeFixture('real-project-name', 'agent-cccc900000f2');
      const resolvableSession = randomUUID();
      insertSession(db, resolvableSession, { project: 'agent-cccc900000f2', cwd: worktreeDir });
      insertMemory(db, { session_id: resolvableSession, project: 'agent-cccc900000f2' });

      const unresolvableSession = randomUUID();
      insertSession(db, unresolvableSession, {
        project: 'agent-deadbeef9003',
        cwd: 'C:\\work\\mega\\some-random-scratch-dir\\agent-deadbeef9003',
      });
      insertMemory(db, { session_id: unresolvableSession, project: 'agent-deadbeef9003' });

      // Noise: an already-correct, never-mis-tagged project, to confirm
      // the dropdown isn't somehow cleared or over-filtered by the apply.
      const normalSession = randomUUID();
      insertSession(db, normalSession, { project: 'anothergenuineproject', cwd: null });
      insertMemory(db, { session_id: normalSession, project: 'anothergenuineproject' });

      const result = runRepoIdentityBackfill(db, { dryRun: false, column: 'project' });
      expect(result.applied).toBe(1);
      expect(result.unresolved).toBe(1);

      const options = queryProjectOptions(db);

      expect(options).toContain('real-project-name'); // resolved by this apply
      expect(options).toContain('anothergenuineproject'); // untouched, already-correct
      expect(options).toContain('agent-deadbeef9003'); // explicitly-unresolved remainder
      expect(options).not.toContain('agent-cccc900000f2'); // the resolved row's OLD value is gone
    },
  );
});

describe('repoIdentityBackfillCommand — CLI layer (FEAT-553 argv wiring: --column/--sessions/--yes)', () => {
  const origDataDir = process.env.ASTRA_MEMORY_DATADIR;

  afterEach(() => {
    if (origDataDir === undefined) delete process.env.ASTRA_MEMORY_DATADIR;
    else process.env.ASTRA_MEMORY_DATADIR = origDataDir;
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it('--column rejects an invalid value: exits 1 with a clear error, never opens a db', () => {
    const dir = mkTmpDir('repoidbackfill-cli-');
    process.env.ASTRA_MEMORY_DATADIR = dir;
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    repoIdentityBackfillCommand(['--column', 'bogus']);

    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(errSpy.mock.calls[0]![0]).toContain('--column must be one of');
    expect(process.exitCode).toBe(1);
  });

  it('AC-6: default invocation (no --yes) is a dry-run — zero mutations, preview reports scanned/would-re-stamp/unresolved', () => {
    const dir = mkTmpDir('repoidbackfill-cli-');
    process.env.ASTRA_MEMORY_DATADIR = dir;
    const { worktreeDir } = makeWorktreeFixture('astramemory-local', 'agent-cafe0000000001');
    let memId = '';
    seedFileDb(dir, (db) => {
      const sessionId = randomUUID();
      insertSession(db, sessionId, { repo: 'agent-cafe0000000001', cwd: worktreeDir });
      memId = insertMemory(db, { session_id: sessionId, repo: 'agent-cafe0000000001' });
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    repoIdentityBackfillCommand([]);

    const printed = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(printed).toContain('Would re-stamp: 1');
    expect(printed).toContain('Preview only');

    expect(readFileDbColumn(dir, 'memories', 'repo', memId)).toBe('agent-cafe0000000001');
  });

  it('AC-6: a second identical dry-run invocation (still no --yes) reports byte-identical preview text', () => {
    const dir = mkTmpDir('repoidbackfill-cli-');
    process.env.ASTRA_MEMORY_DATADIR = dir;
    const { worktreeDir } = makeWorktreeFixture('astramemory-local', 'agent-cafe0000000009');
    seedFileDb(dir, (db) => {
      const sessionId = randomUUID();
      insertSession(db, sessionId, { repo: 'agent-cafe0000000009', cwd: worktreeDir });
      insertMemory(db, { session_id: sessionId, repo: 'agent-cafe0000000009' });
    });

    const logSpy1 = vi.spyOn(console, 'log').mockImplementation(() => {});
    repoIdentityBackfillCommand([]);
    const first = logSpy1.mock.calls.map(c => c.join(' ')).join('\n');
    logSpy1.mockRestore();
    // Guard against a vacuous pass (e.g. both runs finding 0 candidates):
    // the fixture must actually be a live would-re-stamp candidate.
    expect(first).toContain('Would re-stamp: 1');

    const logSpy2 = vi.spyOn(console, 'log').mockImplementation(() => {});
    repoIdentityBackfillCommand([]);
    const second = logSpy2.mock.calls.map(c => c.join(' ')).join('\n');

    expect(second).toBe(first);
  });

  it('--yes applies the mutation (no flag leaves it a preview, confirmed above)', () => {
    const dir = mkTmpDir('repoidbackfill-cli-');
    process.env.ASTRA_MEMORY_DATADIR = dir;
    const { worktreeDir } = makeWorktreeFixture('astramemory-local', 'agent-cafe0000000002');
    let memId = '';
    seedFileDb(dir, (db) => {
      const sessionId = randomUUID();
      insertSession(db, sessionId, { repo: 'agent-cafe0000000002', cwd: worktreeDir });
      memId = insertMemory(db, { session_id: sessionId, repo: 'agent-cafe0000000002' });
    });

    vi.spyOn(console, 'log').mockImplementation(() => {});
    repoIdentityBackfillCommand(['--yes']);

    expect(readFileDbColumn(dir, 'memories', 'repo', memId)).toBe('astramemory-local');
  });

  it('--column project scans/re-stamps memories.project, not memories.repo', () => {
    const dir = mkTmpDir('repoidbackfill-cli-');
    process.env.ASTRA_MEMORY_DATADIR = dir;
    const { worktreeDir } = makeWorktreeFixture('astramemory-local', 'agent-cafe0000000003');
    let memId = '';
    seedFileDb(dir, (db) => {
      const sessionId = randomUUID();
      insertSession(db, sessionId, { project: 'agent-cafe0000000003', cwd: worktreeDir });
      memId = insertMemory(db, { session_id: sessionId, project: 'agent-cafe0000000003' });
    });

    vi.spyOn(console, 'log').mockImplementation(() => {});
    repoIdentityBackfillCommand(['--yes', '--column', 'project']);

    expect(readFileDbColumn(dir, 'memories', 'project', memId)).toBe('astramemory-local');
  });

  it('--column all runs both passes and reports each column independently (verified via --json)', () => {
    const dir = mkTmpDir('repoidbackfill-cli-');
    process.env.ASTRA_MEMORY_DATADIR = dir;
    const repoFixture = makeWorktreeFixture('repo-side-cli', 'agent-cafe0000000004');
    const projFixture = makeWorktreeFixture('project-side-cli', 'agent-cafe0000000005');
    seedFileDb(dir, (db) => {
      const repoSession = randomUUID();
      insertSession(db, repoSession, { repo: 'agent-cafe0000000004', cwd: repoFixture.worktreeDir });
      insertMemory(db, { session_id: repoSession, repo: 'agent-cafe0000000004' });

      const projSession = randomUUID();
      insertSession(db, projSession, { project: 'agent-cafe0000000005', cwd: projFixture.worktreeDir });
      insertMemory(db, { session_id: projSession, project: 'agent-cafe0000000005' });
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    repoIdentityBackfillCommand(['--yes', '--column', 'all', '--json']);

    const output = JSON.parse(logSpy.mock.calls[0]![0] as string) as Record<
      'repo' | 'project',
      { applied: number; column: string }
    >;
    expect(output.repo.column).toBe('repo');
    expect(output.repo.applied).toBe(1);
    expect(output.project.column).toBe('project');
    expect(output.project.applied).toBe(1);
  });

  it('--sessions wires includeSessions through to the core function (sessions.<column> is re-stamped too)', () => {
    const dir = mkTmpDir('repoidbackfill-cli-');
    process.env.ASTRA_MEMORY_DATADIR = dir;
    const { worktreeDir } = makeWorktreeFixture('astramemory-local', 'agent-cafe0000000006');
    let sessionId = '';
    seedFileDb(dir, (db) => {
      sessionId = randomUUID();
      insertSession(db, sessionId, { repo: 'agent-cafe0000000006', cwd: worktreeDir });
      insertMemory(db, { session_id: sessionId, repo: 'agent-cafe0000000006' });
    });

    vi.spyOn(console, 'log').mockImplementation(() => {});
    repoIdentityBackfillCommand(['--yes', '--sessions']);

    expect(readFileDbColumn(dir, 'sessions', 'repo', sessionId)).toBe('astramemory-local');
  });

  it('without --sessions, the sessions table is left untouched (default-off, byte-identical to FEAT-484)', () => {
    const dir = mkTmpDir('repoidbackfill-cli-');
    process.env.ASTRA_MEMORY_DATADIR = dir;
    const { worktreeDir } = makeWorktreeFixture('astramemory-local', 'agent-cafe0000000007');
    let sessionId = '';
    let memId = '';
    seedFileDb(dir, (db) => {
      sessionId = randomUUID();
      insertSession(db, sessionId, { repo: 'agent-cafe0000000007', cwd: worktreeDir });
      memId = insertMemory(db, { session_id: sessionId, repo: 'agent-cafe0000000007' });
    });

    vi.spyOn(console, 'log').mockImplementation(() => {});
    repoIdentityBackfillCommand(['--yes']);

    // Guard against a vacuous pass: the memory row must have actually been
    // re-stamped (proving the backfill genuinely ran against this fixture)
    // while the session row — only re-stamped when --sessions is passed —
    // stays at its original bad-shape value.
    expect(readFileDbColumn(dir, 'memories', 'repo', memId)).toBe('astramemory-local');
    expect(readFileDbColumn(dir, 'sessions', 'repo', sessionId)).toBe('agent-cafe0000000007');
  });

  it('AC-9: the human-readable preview never prints the absolute worktree cwd path, only basenames', () => {
    const dir = mkTmpDir('repoidbackfill-cli-');
    process.env.ASTRA_MEMORY_DATADIR = dir;
    const { worktreeDir } = makeWorktreeFixture('astramemory-local', 'agent-cafe0000000008');
    seedFileDb(dir, (db) => {
      const sessionId = randomUUID();
      insertSession(db, sessionId, { repo: 'agent-cafe0000000008', cwd: worktreeDir });
      insertMemory(db, { session_id: sessionId, repo: 'agent-cafe0000000008' });
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    repoIdentityBackfillCommand([]);

    const printed = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(printed).not.toContain(worktreeDir);
    expect(printed).toContain('astramemory-local');
  });
});
