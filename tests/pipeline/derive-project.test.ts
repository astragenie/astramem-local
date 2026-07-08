import { describe, it, expect } from 'vitest';
import { deriveProject } from '../../src/pipeline/derive-project.js';

describe('deriveProject', () => {
  it('derives the basename of cwd when cwd is present (POSIX)', () => {
    expect(deriveProject('/home/user/my-repo', null)).toBe('my-repo');
  });

  it('derives the basename of cwd when cwd is present (Windows)', () => {
    expect(deriveProject('C:\\work\\my-repo', null)).toBe('my-repo');
  });

  it('strips a trailing separator before taking the basename', () => {
    expect(deriveProject('/home/user/my-repo/', null)).toBe('my-repo');
    expect(deriveProject('C:\\work\\my-repo\\', null)).toBe('my-repo');
  });

  it('prefers repo over cwd basename when both are present (FEAT-403 precedence)', () => {
    expect(deriveProject('/home/user/my-repo', 'other-repo')).toBe('other-repo');
  });

  it('prefers repo over cwd basename even for a worktree-style cwd (avoids recall fragmentation)', () => {
    expect(
      deriveProject('C:\\work\\mega\\astramemory-local-worktrees\\wt-423b', 'astramemory-local'),
    ).toBe('astramemory-local');
  });

  it('falls back to repo when cwd is absent', () => {
    expect(deriveProject(null, 'fallback-repo')).toBe('fallback-repo');
    expect(deriveProject(undefined, 'fallback-repo')).toBe('fallback-repo');
  });

  it('returns null when both cwd and repo are null/absent', () => {
    expect(deriveProject(null, null)).toBeNull();
    expect(deriveProject(undefined, undefined)).toBeNull();
  });

  it('returns null for an empty or root-only cwd with no repo fallback', () => {
    expect(deriveProject('', null)).toBeNull();
    expect(deriveProject('/', null)).toBeNull();
    expect(deriveProject('\\', null)).toBeNull();
  });

  it('falls back to repo when cwd is empty/root-only', () => {
    expect(deriveProject('/', 'fallback-repo')).toBe('fallback-repo');
  });

  // FEAT-425: worktree-safe cwd-basename fallback (no repo signal at all).
  it('resolves a worktree-shaped cwd to the base repo name when repo is absent (POSIX)', () => {
    expect(deriveProject('/home/user/my-repo-worktrees/wt-foo', null)).toBe('my-repo');
  });

  it('resolves a worktree-shaped cwd to the base repo name when repo is absent (Windows)', () => {
    expect(
      deriveProject('C:\\work\\mega\\astramemory-local-worktrees\\wt-423b', null),
    ).toBe('astramemory-local');
  });

  it('resolves a worktree-shaped cwd whose subdir is not "wt-"-prefixed (e.g. a branch/feature name)', () => {
    expect(
      deriveProject(
        'C:\\work\\mega\\astramemory-local-worktrees\\425-project-identity',
        null,
      ),
    ).toBe('astramemory-local');
  });

  it('leaves a non-worktree cwd unaffected (AC-2 regression guard)', () => {
    expect(deriveProject('/home/user/my-repo', null)).toBe('my-repo');
    expect(deriveProject('C:\\work\\my-repo', null)).toBe('my-repo');
  });

  it('strips the "-worktrees" parent even with only two path segments total', () => {
    expect(deriveProject('/repo-worktrees/sub', null)).toBe('repo');
  });
});
