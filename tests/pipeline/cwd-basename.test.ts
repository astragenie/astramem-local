import { describe, it, expect } from 'vitest';
import { deriveWorktreeSafeBasename } from '../../src/pipeline/cwd-basename.js';

describe('deriveWorktreeSafeBasename', () => {
  it('returns null for null/undefined/empty/root-only cwd', () => {
    expect(deriveWorktreeSafeBasename(null)).toBeNull();
    expect(deriveWorktreeSafeBasename(undefined)).toBeNull();
    expect(deriveWorktreeSafeBasename('')).toBeNull();
    expect(deriveWorktreeSafeBasename('/')).toBeNull();
    expect(deriveWorktreeSafeBasename('\\')).toBeNull();
  });

  it('returns the plain basename for a non-worktree cwd (POSIX/Windows)', () => {
    expect(deriveWorktreeSafeBasename('/home/user/my-repo')).toBe('my-repo');
    expect(deriveWorktreeSafeBasename('C:\\work\\my-repo')).toBe('my-repo');
  });

  it('strips a trailing separator before taking the basename', () => {
    expect(deriveWorktreeSafeBasename('/home/user/my-repo/')).toBe('my-repo');
    expect(deriveWorktreeSafeBasename('C:\\work\\my-repo\\')).toBe('my-repo');
  });

  it('resolves a "<repo>-worktrees/<sub>" shaped cwd to <repo> (POSIX)', () => {
    expect(deriveWorktreeSafeBasename('/home/user/my-repo-worktrees/wt-foo')).toBe('my-repo');
  });

  it('resolves a "<repo>-worktrees/<sub>" shaped cwd to <repo> (Windows)', () => {
    expect(
      deriveWorktreeSafeBasename('C:\\work\\mega\\astramemory-local-worktrees\\wt-423b'),
    ).toBe('astramemory-local');
  });

  it('resolves regardless of the worktree subdirectory name (branch-derived, not just "wt-")', () => {
    expect(
      deriveWorktreeSafeBasename(
        'C:\\work\\mega\\astramemory-local-worktrees\\425-project-identity',
      ),
    ).toBe('astramemory-local');
  });

  it('does not strip when "-worktrees" appears in the last segment rather than the parent', () => {
    expect(deriveWorktreeSafeBasename('/home/user/my-repo-worktrees')).toBe(
      'my-repo-worktrees',
    );
  });

  it('does not strip a "-worktrees"-suffixed segment that is not the immediate parent', () => {
    expect(deriveWorktreeSafeBasename('/home/user/my-repo-worktrees/wt-foo/nested')).toBe(
      'nested',
    );
  });
});
