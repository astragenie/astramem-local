import { describe, it, expect } from 'vitest';
import { deriveRepoFromCwd } from '../../src/tag-hygiene/derive-repo.js';

describe('deriveRepoFromCwd', () => {
  it('derives the basename of cwd when cwd is present (POSIX)', () => {
    expect(deriveRepoFromCwd('/home/user/my-repo')).toBe('my-repo');
  });

  it('derives the basename of cwd when cwd is present (Windows)', () => {
    expect(deriveRepoFromCwd('C:\\work\\my-repo')).toBe('my-repo');
  });

  it('strips a trailing separator before taking the basename', () => {
    expect(deriveRepoFromCwd('/home/user/my-repo/')).toBe('my-repo');
    expect(deriveRepoFromCwd('C:\\work\\my-repo\\')).toBe('my-repo');
  });

  it('returns null when cwd is null/undefined', () => {
    expect(deriveRepoFromCwd(null)).toBeNull();
    expect(deriveRepoFromCwd(undefined)).toBeNull();
  });

  it('returns null for an empty or root-only cwd', () => {
    expect(deriveRepoFromCwd('')).toBeNull();
    expect(deriveRepoFromCwd('/')).toBeNull();
    expect(deriveRepoFromCwd('\\')).toBeNull();
  });

  // FEAT-425: worktree-safe cwd-basename fallback.
  it('resolves a worktree-shaped cwd to the base repo name (POSIX)', () => {
    expect(deriveRepoFromCwd('/home/user/my-repo-worktrees/wt-foo')).toBe('my-repo');
  });

  it('resolves a worktree-shaped cwd to the base repo name (Windows)', () => {
    expect(deriveRepoFromCwd('C:\\work\\mega\\astramemory-local-worktrees\\wt-423b')).toBe(
      'astramemory-local',
    );
  });

  it('resolves regardless of the worktree subdir naming (not just "wt-"-prefixed)', () => {
    expect(
      deriveRepoFromCwd('C:\\work\\mega\\astramemory-local-worktrees\\425-project-identity'),
    ).toBe('astramemory-local');
  });

  it('leaves a non-worktree cwd unaffected (AC-2 regression guard)', () => {
    expect(deriveRepoFromCwd('/home/user/my-repo')).toBe('my-repo');
    expect(deriveRepoFromCwd('C:\\work\\mega\\astramemory-local')).toBe('astramemory-local');
  });
});
