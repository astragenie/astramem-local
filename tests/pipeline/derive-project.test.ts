import { describe, it, expect } from 'vitest';
import { deriveProject, reconcileIngestProject } from '../../src/pipeline/derive-project.js';

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

describe('reconcileIngestProject (FEAT-553 / DEC-017 rule 2)', () => {
  const nestedCwd = 'C:\\work\\mega\\astramem-local\\.claude\\worktrees\\agent-a0112287d8dd8d401';

  it('AC-1 shape: overrides when project_id === basename(cwd), preferring the git-resolved repo', () => {
    const result = reconcileIngestProject({
      projectId: 'agent-a0112287d8dd8d401',
      cwd: nestedCwd,
      repo: 'astramem-local',
    });
    expect(result).toEqual({
      project: 'astramem-local',
      overridden: true,
      source: 'git-common-dir',
    });
  });

  it('falls back to the worktree-safe string heuristic when git could not answer (repo null)', () => {
    const result = reconcileIngestProject({
      projectId: 'agent-a0112287d8dd8d401',
      cwd: nestedCwd,
      repo: null,
    });
    expect(result).toEqual({
      project: 'astramem-local',
      overridden: true,
      source: 'string-heuristic',
    });
  });

  it('also fires for the FEAT-425 sibling worktree shape (<repo>-worktrees/<x>)', () => {
    const cwd = 'C:\\work\\mega\\astramemory-local-worktrees\\wt-423b';
    const result = reconcileIngestProject({
      projectId: 'wt-423b',
      cwd,
      repo: null,
    });
    expect(result).toEqual({
      project: 'astramemory-local',
      overridden: true,
      source: 'string-heuristic',
    });
  });

  it('AC-5: a deliberate project_id label that does NOT equal basename(cwd) is stored verbatim, never clobbered', () => {
    const result = reconcileIngestProject({
      projectId: 'my-deliberate-label',
      cwd: nestedCwd,
      repo: 'astramem-local',
    });
    expect(result).toEqual({ project: 'my-deliberate-label', overridden: false });
  });

  it('is a no-op when cwd is absent (the legacy envelope has no cwd at all)', () => {
    const result = reconcileIngestProject({
      projectId: 'agent-a0112287d8dd8d401',
      cwd: undefined,
      repo: 'astramem-local',
    });
    expect(result).toEqual({ project: 'agent-a0112287d8dd8d401', overridden: false });
  });

  it('is a no-op for a plain (non-worktree) cwd whose basename happens to equal project_id', () => {
    const result = reconcileIngestProject({
      projectId: 'astramem-local',
      cwd: '/home/user/astramem-local',
      repo: 'astramem-local',
    });
    // basename(cwd) === projectId, but the derived value is IDENTICAL —
    // nothing would actually change, so this must not be flagged overridden.
    expect(result).toEqual({ project: 'astramem-local', overridden: false });
  });

  it('does not override when the derived value is null (git and the string heuristic both come up empty)', () => {
    const result = reconcileIngestProject({
      projectId: 'agent-x',
      cwd: '/agent-x',
      repo: null,
    });
    // basename('/agent-x') === 'agent-x' === projectId, and
    // deriveWorktreeSafeBasename('/agent-x') also just returns 'agent-x'
    // (not a worktree shape) -- derived === projectId, no real change.
    expect(result).toEqual({ project: 'agent-x', overridden: false });
  });

  it('passes through a null/undefined projectId verbatim', () => {
    expect(reconcileIngestProject({ projectId: null, cwd: nestedCwd, repo: 'astramem-local' }))
      .toEqual({ project: null, overridden: false });
    expect(reconcileIngestProject({ projectId: undefined, cwd: nestedCwd, repo: 'astramem-local' }))
      .toEqual({ project: null, overridden: false });
  });

  it('handles a POSIX nested worktree cwd the same way', () => {
    const result = reconcileIngestProject({
      projectId: 'agent-ac72934b8fdc982ea',
      cwd: '/c/work/mega/astramem-local/.claude/worktrees/agent-ac72934b8fdc982ea',
      repo: 'astramem-local',
    });
    expect(result).toEqual({
      project: 'astramem-local',
      overridden: true,
      source: 'git-common-dir',
    });
  });
});
