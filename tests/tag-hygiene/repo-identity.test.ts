/**
 * tests/tag-hygiene/repo-identity.test.ts — FEAT-484 (issue #177).
 *
 * Exercises resolveRepoIdentity() against real fixture git repos + real
 * `git worktree add` (spawnSync + an actual `git` binary, no mocking — same
 * style as tests/service/git-hooks-activate.test.ts) so the assertion is
 * "git actually resolves a linked worktree back to its main checkout",
 * not a mock of that behavior.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';

import {
  resolveRepoIdentity,
  __clearRepoIdentityCacheForTests,
} from '../../src/tag-hygiene/repo-identity.js';

let tmpDirs: string[] = [];

function mkTmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function git(cwd: string, args: string[]): string {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (exit ${res.status}): ${res.stderr}`);
  }
  return res.stdout;
}

function initFixtureRepo(dir: string): void {
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  writeFileSync(join(dir, 'README.md'), 'hello\n', 'utf8');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'init']);
}

const ORIGINAL_CEILING = process.env['GIT_CEILING_DIRECTORIES'];

beforeEach(() => {
  __clearRepoIdentityCacheForTests();
  // Bound git's upward repo-discovery search at the OS temp root so a
  // coincidental ambient git repo higher up the real filesystem (e.g. a
  // dotfiles repo at the user's home directory) can't leak into the
  // "non-git directory" assertion below — test-isolation only, this env var
  // is restored after every test and never touches production resolution.
  process.env['GIT_CEILING_DIRECTORIES'] = tmpdir();
});

afterEach(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  tmpDirs = [];
  if (ORIGINAL_CEILING === undefined) delete process.env['GIT_CEILING_DIRECTORIES'];
  else process.env['GIT_CEILING_DIRECTORIES'] = ORIGINAL_CEILING;
});

describe('resolveRepoIdentity — git-common-dir resolution', () => {
  it('resolves a main checkout to its own directory name', () => {
    const root = mkTmpDir('repoidmain-');
    const repoDir = join(root, 'astramemory-local');
    mkdirSync(repoDir);
    initFixtureRepo(repoDir);

    expect(resolveRepoIdentity(repoDir)).toBe('astramemory-local');
  });

  it('resolves a NESTED worktree (.claude/worktrees/<name>) to the main checkout name — the exact FEAT-484 regression shape', () => {
    const root = mkTmpDir('repoidnested-');
    const repoDir = join(root, 'astramemory-local');
    mkdirSync(repoDir);
    initFixtureRepo(repoDir);

    const worktreeDir = join(repoDir, '.claude', 'worktrees', 'agent-ac72934b8fdc982ea');
    mkdirSync(join(repoDir, '.claude', 'worktrees'), { recursive: true });
    git(repoDir, ['worktree', 'add', '-b', 'agent-branch', worktreeDir]);

    // The old string-only heuristic (deriveWorktreeSafeBasename) would
    // return 'agent-ac72934b8fdc982ea' here — the parent segment is
    // 'worktrees', not '<repo>-worktrees', so its regex never matches.
    expect(resolveRepoIdentity(worktreeDir)).toBe('astramemory-local');
    expect(resolveRepoIdentity(worktreeDir)).not.toBe(basename(worktreeDir));
  });

  it('resolves a SIBLING worktree (<repo>-worktrees/<name>) to the main checkout name too', () => {
    const root = mkTmpDir('repoidsibling-');
    const repoDir = join(root, 'astramemory-local');
    mkdirSync(repoDir);
    initFixtureRepo(repoDir);

    const worktreeDir = join(root, 'astramemory-local-worktrees', 'wt-foo');
    mkdirSync(join(root, 'astramemory-local-worktrees'), { recursive: true });
    git(repoDir, ['worktree', 'add', '-b', 'wt-foo-branch', worktreeDir]);

    expect(resolveRepoIdentity(worktreeDir)).toBe('astramemory-local');
  });

  it('returns null for a non-git directory (caller falls back to the string heuristic)', () => {
    const dir = mkTmpDir('repoidnongit-');
    expect(resolveRepoIdentity(dir)).toBeNull();
  });

  it('returns null for a nonexistent path', () => {
    expect(resolveRepoIdentity('C:\\this\\path\\does\\not\\exist\\anywhere')).toBeNull();
  });

  it('returns null for blank/nullish cwd', () => {
    expect(resolveRepoIdentity(null)).toBeNull();
    expect(resolveRepoIdentity(undefined)).toBeNull();
    expect(resolveRepoIdentity('')).toBeNull();
  });

  it('memoizes per-cwd — a second call for the same cwd does not require the directory to still exist', () => {
    const root = mkTmpDir('repoidcache-');
    const repoDir = join(root, 'astramemory-local');
    mkdirSync(repoDir);
    initFixtureRepo(repoDir);

    const first = resolveRepoIdentity(repoDir);
    expect(first).toBe('astramemory-local');

    // Simulate the directory being deleted (worktree cleanup) after first
    // resolution — the cached value should still be returned.
    rmSync(repoDir, { recursive: true, force: true });
    const second = resolveRepoIdentity(repoDir);
    expect(second).toBe('astramemory-local');
  });
});
