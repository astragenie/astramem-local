/**
 * resolveRepoIdentity — git-aware repo identity resolution (FEAT-484 /
 * issue #177).
 *
 * Problem: `deriveWorktreeSafeBasename` (src/pipeline/cwd-basename.ts) is a
 * STRING-ONLY heuristic that only recognizes one worktree naming convention
 * (`<repo>-worktrees/<name>`, sibling directory — FEAT-425). It does NOT
 * recognize the nested `.claude/worktrees/<name>` convention this repo's own
 * agents use (e.g. `astramemory-local/.claude/worktrees/agent-<hash>`) — for
 * that shape the parent segment is literally `worktrees`, not `<repo>-
 * worktrees`, so the regex never matches and the heuristic falls through to
 * the raw last-segment basename (`agent-<hash>`). That mis-tag is the bug:
 * repo-scoped recall misses the memory, consolidation never dedupes it
 * against its main-checkout twin, and once the worktree is deleted the value
 * points at a path that no longer exists.
 *
 * Rather than special-case a second string pattern (fragile — any future
 * worktree-naming convention reintroduces the same bug), ask git directly:
 * `git rev-parse --git-common-dir` resolves a WORKTREE checkout to its MAIN
 * checkout's `.git` directory, regardless of what the worktree directory
 * itself happens to be named. This works for local-first astramem because
 * the daemon and the capture hook normally run on the same box (CLAUDE.md:
 * "Local-first memory daemon"), so at ingest time the client-reported `cwd`
 * is very likely still resolvable from the daemon's own process.
 *
 * Non-git / unresolvable cases (git not installed, cwd no longer exists —
 * e.g. a worktree cleaned up before a later backfill run, or the daemon
 * genuinely running on a different host) return `null` — callers fall back
 * to the pre-existing string-basename heuristic, preserving current
 * behavior for anything git can't answer (AC: "Handle the non-git case
 * gracefully").
 */
import { execFileSync } from 'node:child_process';
import { dirname, basename, resolve as resolvePath } from 'node:path';

const GIT_TIMEOUT_MS = 2000;

/** Bounded memoization — an ingest burst (subagent_stop + session_end, or a
 *  batch of subagent transcripts from one parallel run) can call this many
 *  times for the SAME cwd in quick succession; avoid re-spawning git per
 *  call. Small cap keeps this from growing unbounded across a long-running
 *  daemon process. */
const CACHE_MAX = 500;
const cache = new Map<string, string | null>();

function cacheGet(cwd: string): string | null | undefined {
  return cache.get(cwd);
}

function cacheSet(cwd: string, value: string | null): void {
  if (cache.size >= CACHE_MAX && !cache.has(cwd)) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(cwd, value);
}

function runGit(cwd: string, args: string[]): string | null {
  try {
    const out = execFileSync('git', args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    });
    const trimmed = out.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null; // not a git dir, git missing, path gone, timeout — never throw
  }
}

/** `git rev-parse --git-common-dir` → the MAIN checkout's `.git` dir for
 *  both a plain checkout (returns `.git`) and a linked worktree (returns a
 *  path into the main checkout, e.g. `../../main-repo/.git`). The parent of
 *  that directory's basename is the repo identity — stable across every
 *  worktree naming convention because it's git's own bookkeeping, not a
 *  guess about directory names. */
function resolveViaGitCommonDir(cwd: string): string | null {
  const commonDir = runGit(cwd, ['rev-parse', '--git-common-dir']);
  if (!commonDir) return null;
  const absCommonDir = resolvePath(cwd, commonDir);
  const repoRoot = dirname(absCommonDir); // strip trailing .git
  const name = basename(repoRoot);
  return name.length > 0 ? name : null;
}

/** Fallback when `--git-common-dir` can't be read as a repo-root name (rare
 *  — e.g. a bare repo, or an unconventional `.git` file layout): the
 *  `origin` remote URL's final path segment, handling both SSH
 *  (`git@host:org/repo.git`) and HTTPS (`https://host/org/repo.git`) forms. */
function resolveViaOriginRemote(cwd: string): string | null {
  const url = runGit(cwd, ['config', '--get', 'remote.origin.url']);
  if (!url) return null;
  const stripped = url.trim().replace(/\/+$/, '').replace(/\.git$/i, '');
  const segments = stripped.split(/[/:]/).filter(Boolean);
  const last = segments[segments.length - 1];
  return last && last.length > 0 ? last : null;
}

/**
 * Resolve a session's repo identity from its working directory via git,
 * memoized per-cwd. Returns `null` when git can't answer (non-git dir, git
 * unavailable, path no longer exists, or timeout) — callers are expected to
 * fall back to the pre-existing string-basename heuristic in that case.
 */
export function resolveRepoIdentity(cwd: string | null | undefined): string | null {
  if (!cwd || cwd.trim() === '') return null;

  const cached = cacheGet(cwd);
  if (cached !== undefined) return cached;

  const resolved = resolveViaGitCommonDir(cwd) ?? resolveViaOriginRemote(cwd);
  cacheSet(cwd, resolved);
  return resolved;
}

/** Test-only escape hatch — the cache is process-lifetime by design (daemon
 *  process), but unit tests reuse the same process across cases with
 *  colliding tmp-dir paths. */
export function __clearRepoIdentityCacheForTests(): void {
  cache.clear();
}
