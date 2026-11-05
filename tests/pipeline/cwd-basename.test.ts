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

  it('resolves a nested ".claude/worktrees/<x>" shaped cwd to the main repo name (POSIX) — FEAT-553 AC-2', () => {
    expect(
      deriveWorktreeSafeBasename(
        '/c/work/mega/astramem-local/.claude/worktrees/agent-a0112287d8dd8d401',
      ),
    ).toBe('astramem-local');
  });

  it('resolves a nested ".claude/worktrees/<x>" shaped cwd to the main repo name (Windows) — FEAT-553 AC-2', () => {
    expect(
      deriveWorktreeSafeBasename(
        'C:\\work\\mega\\astramem-local\\.claude\\worktrees\\agent-a0112287d8dd8d401',
      ),
    ).toBe('astramem-local');
  });

  it('resolves the nested ".claude/worktrees/<x>" shape with a trailing separator', () => {
    expect(
      deriveWorktreeSafeBasename(
        '/c/work/mega/astramem-local/.claude/worktrees/agent-a0112287d8dd8d401/',
      ),
    ).toBe('astramem-local');
    expect(
      deriveWorktreeSafeBasename(
        'C:\\work\\mega\\astramem-local\\.claude\\worktrees\\agent-a0112287d8dd8d401\\',
      ),
    ).toBe('astramem-local');
  });

  it('evaluates the nested rule before the sibling "-worktrees" rule when both could apply', () => {
    // Parent-of-worktrees-dir segment here is "mega", not "<repo>-worktrees",
    // so only the nested rule can fire; this pins precedence per the slice
    // spec ("evaluate the nested rule first, then the sibling rule").
    expect(
      deriveWorktreeSafeBasename('/home/user/mega/astramem-local/.claude/worktrees/agent-x'),
    ).toBe('astramem-local');
  });

  it('does not treat it as the nested shape when ".claude" is not exactly three segments from the end (passthrough)', () => {
    // ".claude" sits at depth 4 from the end here (one extra "nested"
    // segment between it and "worktrees"), so the last-three-segments
    // contract is not satisfied — falls through to plain basename.
    expect(
      deriveWorktreeSafeBasename('/home/user/repo/.claude/nested/worktrees/agent-x'),
    ).toBe('agent-x');
  });

  it('does not treat a bare ".claude/worktrees/<x>" with nothing before ".claude" as the nested shape (no repo segment to recover)', () => {
    expect(deriveWorktreeSafeBasename('/.claude/worktrees/agent-x')).toBe('agent-x');
    expect(deriveWorktreeSafeBasename('.claude/worktrees/agent-x')).toBe('agent-x');
  });

  it('KNOWN LIMITATION (FEAT-425 coincidence case): mis-derives a real, non-worktree subdirectory whose parent merely ends in "-worktrees"', () => {
    // The heuristic is string-only by design (no git/fs calls — see the impl's
    // doc comment) and only ever checks the immediate PARENT segment's name.
    // It cannot distinguish an actual git worktree checkout from any other
    // ordinary subdirectory that happens to live under a `<repo>-worktrees`
    // parent. `some-real-subdir` below is a legitimate, non-worktree directory
    // (e.g. a scratch folder someone created next to the real worktrees), but
    // it still gets collapsed to the captured repo name — this is the
    // documented coincidence-case limitation, not a bug fix target here.
    expect(
      deriveWorktreeSafeBasename('/home/user/my-repo-worktrees/some-real-subdir'),
    ).toBe('my-repo');
  });
});
