/**
 * worktree-guard.ts — refuse to touch the PRODUCTION datadir from a linked
 * git worktree (issue #187).
 *
 * A git worktree gets its own branch, its own `dist/`, and its own
 * `.claude/state/`. It does NOT get its own datadir: `defaultDataDir()`
 * resolves to the same `%LOCALAPPDATA%\Astramem` no matter which checkout you
 * run from. So an agent working in a worktree that runs `serve`/`doctor`/
 * `reinstall`, or a test that reaches `migrate()`, points at the LIVE
 * production database, keystore, and port — carrying whatever uncommitted
 * schema changes happen to be in its tree.
 *
 * That is not hypothetical. It has fired twice:
 *
 *   - 2026-07-13: a builder agent in a worktree applied an UNCOMMITTED
 *     `030-evidence-guard-drops.sql` to the live prod DB. Prod jumped to
 *     user_version=30 with a migration that existed on no branch; combined
 *     with a second, colliding `030` on main, the daemon would not boot and
 *     production went down until manual DB surgery.
 *   - FEAT-466: a sandboxed `init` overwrote the PRODUCTION bearer token,
 *     because the OS keystore is not datadir-scoped either.
 *
 * Both were known hazards that we nonetheless walked into, which is the signal
 * that documentation is not the right control. This makes it structural.
 *
 * Detection is deliberately subprocess-free: a linked worktree's `.git` is a
 * FILE (containing `gitdir: <path>`), while a primary checkout's `.git` is a
 * DIRECTORY. Walk up from cwd until we find one.
 *
 * Escape hatches (all explicit — the point is that you cannot do it by
 * ACCIDENT, not that you can never do it):
 *   - `ASTRA_MEMORY_DATADIR=<path>` or `:memory:`   — an isolated datadir
 *   - `ASTRA_MEMORY_ISOLATED=1`                     — full isolation mode
 *   - `--data-dir <path>` (CLI override)
 *   - `ASTRA_ALLOW_PROD_DATADIR=1`                  — "yes, I mean production"
 */
import { statSync } from 'node:fs';
import { join, dirname, parse } from 'node:path';

/** Thrown when a linked worktree tries to resolve the default (production) datadir. */
export class ProdDatadirFromWorktreeError extends Error {
  constructor(dataDir: string, worktreeRoot: string) {
    super(
      `Refusing to use the PRODUCTION datadir from a linked git worktree.\n\n` +
        `  worktree : ${worktreeRoot}\n` +
        `  datadir  : ${dataDir}   <- this is the LIVE production database\n\n` +
        `A worktree has its own branch and its own dist/, but NOT its own datadir — so this\n` +
        `command would operate on production with whatever uncommitted changes are in this\n` +
        `tree. That is how the 2026-07-13 outage happened (an uncommitted migration was\n` +
        `applied to the live DB from a worktree; the daemon then would not boot).\n\n` +
        `Pick one:\n` +
        `  - isolated datadir : set ASTRA_MEMORY_DATADIR=<some temp path>  (or ':memory:')\n` +
        `  - full isolation   : set ASTRA_MEMORY_ISOLATED=1\n` +
        `  - explicit override: pass --data-dir <path>\n` +
        `  - you REALLY mean production: set ASTRA_ALLOW_PROD_DATADIR=1\n`,
    );
    this.name = 'ProdDatadirFromWorktreeError';
  }
}

/**
 * Returns the worktree root when `cwd` sits inside a LINKED git worktree,
 * else null (primary checkout, or not a git repo at all — e.g. an
 * npm-installed user, who has no `.git` and must never be blocked).
 *
 * Linked worktree  -> `.git` is a FILE  (`gitdir: /path/to/main/.git/worktrees/x`)
 * Primary checkout -> `.git` is a DIRECTORY
 */
export function findLinkedWorktreeRoot(cwd: string = process.cwd()): string | null {
  let dir = cwd;
  const { root } = parse(dir);
  for (;;) {
    try {
      const st = statSync(join(dir, '.git'));
      // Found the checkout root. A FILE means linked worktree; a DIR means primary.
      return st.isFile() ? dir : null;
    } catch {
      // no .git here — keep walking up
    }
    if (dir === root) return null; // walked out without finding a repo
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export interface WorktreeGuardInput {
  /** The resolved datadir. */
  dataDir: string;
  /** Where it came from — only 'default'/'config.yaml' are accidental. */
  dataDirSource: 'cli' | 'env' | 'config.yaml' | 'default';
  /** The production default datadir, for comparison. */
  defaultDataDir: string;
  /** True when ASTRA_MEMORY_ISOLATED=1 already isolated this resolution. */
  isolated: boolean;
}

/**
 * Throws ProdDatadirFromWorktreeError when a linked worktree is about to
 * operate on the production datadir without saying so explicitly.
 *
 * No-ops (returns normally) for every legitimate case: the primary checkout,
 * npm-installed users with no git repo at all, `:memory:`, isolated mode, an
 * explicit `--data-dir`/`ASTRA_MEMORY_DATADIR`, and the explicit
 * ASTRA_ALLOW_PROD_DATADIR=1 opt-in.
 */
export function assertNotProdDatadirFromWorktree(input: WorktreeGuardInput): void {
  const { dataDir, dataDirSource, defaultDataDir, isolated } = input;

  if (isolated) return;                                   // already isolated
  if (dataDir === ':memory:') return;                     // nothing to clobber
  if (dataDirSource === 'cli' || dataDirSource === 'env') return; // caller said where, explicitly
  if (process.env.ASTRA_ALLOW_PROD_DATADIR === '1') return;       // "yes, I mean production"

  // Only the PRODUCTION default is protected. A config.yaml pointing somewhere
  // else is already a deliberate, non-default choice.
  if (dataDir !== defaultDataDir) return;

  const worktreeRoot = findLinkedWorktreeRoot();
  if (worktreeRoot === null) return; // primary checkout, or no git repo (npm user)

  throw new ProdDatadirFromWorktreeError(dataDir, worktreeRoot);
}
