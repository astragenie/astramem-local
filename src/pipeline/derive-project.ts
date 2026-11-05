import { deriveWorktreeSafeBasename } from './cwd-basename.js';

/**
 * deriveProject — FEAT-423 write-side derivation.
 *
 * Sessions don't always carry an explicit `project` (e.g. plugin clients
 * that only report cwd). Rather than write a null `provenance.project` and
 * rely entirely on the FEAT-403 retag backfill to fix it up later, derive a
 * best-effort project name at ingest time so it's correct from the start.
 *
 * Precedence: explicit `repo` first (FEAT-403 established that an explicit
 * repo column wins over cwd — recall's `project` filter is exact-match, so
 * an inverted precedence fragments recall across git worktrees, where
 * `basename(cwd)` yields the worktree dir name rather than the repo name),
 * then a worktree-safe cwd basename as a fallback (FEAT-425 —
 * deriveWorktreeSafeBasename, shared with deriveRepoFromCwd in
 * src/tag-hygiene/derive-repo.ts), else null.
 */
export function deriveProject(
  cwd: string | null | undefined,
  repo: string | null | undefined,
): string | null {
  if (repo) return repo;
  return deriveWorktreeSafeBasename(cwd);
}

/**
 * reconcileIngestProject — FEAT-553 / DEC-017 rule (2) ingest-side override.
 *
 * Every astramem-plugin capture hook (session-end-summary.sh,
 * subagent-stop-capture.sh, pre-compact-capture.sh) stamps
 * `PROJECT_ID="$(basename "$CWD")"`. From inside a Claude Code agent
 * worktree (`<repo>/.claude/worktrees/agent-<hash>`) that yields the raw
 * worktree basename (`agent-<hash>`), not the repo name — the provenance
 * leak this feature fixes (docs/memory.md FEAT-553).
 *
 * DEC-017 rule (2) is deliberately narrow: re-derive `project_id` ONLY when
 * it is exactly that hook-produced shape — `projectId === basename(cwd)`
 * (the literal last path segment, not the worktree-safe repo name). An
 * explicit, deliberately different `project_id` label is a real client
 * signal and is always stored verbatim, never clobbered (FEAT-553 AC-5) —
 * this is what keeps the override conservative rather than a blanket
 * cwd-wins policy.
 *
 * When the hook-produced shape IS matched, the replacement value prefers a
 * git-resolved repo identity (`repo` — e.g. `resolveRepoIdentity`/
 * `resolveRepoIdentityAsync`, src/tag-hygiene/repo-identity.ts; DEC-017
 * rule 1 trusts this) and falls back to the same worktree-safe string
 * heuristic `deriveProject` already uses (`deriveWorktreeSafeBasename`,
 * extended for the nested `.claude/worktrees/<x>` shape by SLICE-442) only
 * when git couldn't answer. `repo` must be the RAW git-only signal (`null`
 * when git didn't resolve) rather than an already-merged value, so the
 * `source` on the result below is accurate for DEC-017 rule 3's audit
 * requirement — see `reconcileIngestProject`'s callers in
 * src/server/routes/ingest.ts for how that's threaded through cheaply
 * (resolveRepoIdentity's cache is warm by the time this runs, so reading it
 * a second time here never costs a second `git` spawn).
 *
 * No override fires when the derived replacement is null or identical to
 * `projectId` (nothing would actually change) — `overridden` only flags a
 * real substitution so callers log exactly the events DEC-017 rule 3 wants
 * measured, not every pass-through.
 */
export interface ReconcileIngestProjectInput {
  /** Client-sent `project_id` from the ingest envelope. */
  projectId: string | null | undefined;
  /** Client-sent `cwd` from the ingest envelope (absent on the legacy envelope — always a no-op there). */
  cwd: string | null | undefined;
  /**
   * The RAW git-only resolved repo identity for `cwd` (e.g.
   * `resolveRepoIdentity(cwd)` / `resolveRepoIdentityAsync(cwd)` —
   * `git rev-parse --git-common-dir`), or `null`/`undefined` when git
   * couldn't answer (non-git dir, worktree already deleted, git missing).
   * NOT the already-merged `deriveRepoFromCwd` value — this function does
   * its own fallback to `deriveWorktreeSafeBasename(cwd)` and needs to know
   * whether git itself answered to report an accurate `source`.
   */
  repo: string | null | undefined;
}

/** DEC-017 rule 3: which path produced the override's replacement value. */
export type IngestProjectOverrideSource = 'git-common-dir' | 'string-heuristic';

export interface ReconcileIngestProjectResult {
  /** The value to store as `sessions.project` — `projectId` verbatim when not overridden. */
  project: string | null;
  /** Whether `projectId` was replaced by a re-derived value. */
  overridden: boolean;
  /** Present only when `overridden` is true (DEC-017 rule 3). */
  source?: IngestProjectOverrideSource;
}

export function reconcileIngestProject({
  projectId,
  cwd,
  repo,
}: ReconcileIngestProjectInput): ReconcileIngestProjectResult {
  if (!projectId) {
    return { project: projectId ?? null, overridden: false };
  }

  const cwdBasename = plainBasename(cwd);
  if (!cwdBasename || projectId !== cwdBasename) {
    // Not the hook-produced shape (or no cwd at all, e.g. the legacy
    // envelope) — an intentional/explicit label, store verbatim (AC-5).
    return { project: projectId, overridden: false };
  }

  const derived = repo ? repo : deriveWorktreeSafeBasename(cwd);
  const source: IngestProjectOverrideSource = repo ? 'git-common-dir' : 'string-heuristic';

  if (!derived || derived === projectId) {
    return { project: projectId, overridden: false };
  }

  return { project: derived, overridden: true, source };
}

/**
 * Plain last-path-segment basename — deliberately NOT
 * `deriveWorktreeSafeBasename` (which resolves a worktree shape to the
 * REPO name). `reconcileIngestProject`'s equality check needs the literal
 * value `basename "$CWD"` would have produced client-side (DEC-017 rule 2),
 * which for a worktree cwd is the worktree dir name, not the repo. Mirrors
 * the separator/trailing-slash handling in cwd-basename.ts (cross-platform,
 * POSIX + Windows).
 */
function plainBasename(cwd: string | null | undefined): string | null {
  if (!cwd) return null;
  const trimmed = cwd.replace(/[\\/]+$/, '');
  if (!trimmed) return null;
  const segments = trimmed.split(/[\\/]/).filter(Boolean);
  const last = segments[segments.length - 1];
  return last && last.length > 0 ? last : null;
}
