/**
 * git-hooks-activate.ts — FEAT-439 residual.
 *
 * The repo's git post-merge hook (scripts/git-hooks/post-merge →
 * post-merge-rebuild.mjs, FEAT-439) only fires once a checkout has run:
 *
 *   git config core.hooksPath scripts/git-hooks
 *
 * Nothing wired that one-liner into any command — every fresh clone (or
 * worktree) needed a human to read the hook file's own header comment and
 * run it by hand. `init` and `reinstall` are this repo's two "repair
 * everything" commands (CLAUDE.md); both now call `activateGitHooks()` so
 * either one running against a dev checkout activates the hook with no
 * separate step.
 *
 * Deliberately uses `spawnSync` (not `execSync`/`execFileSync`) so this
 * stays independent of the `execSync`/`execFileSync` child_process mocks
 * `tests/cli/init.test.ts` already installs for the Ollama binary/pull
 * checks — this module's own coverage (tests/service/git-hooks-activate.test.ts)
 * exercises it against a real fixture git repo instead.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export type HooksActivationResult =
  | { status: 'set'; repoRoot: string }
  | { status: 'already-set'; repoRoot: string }
  | { status: 'not-a-git-checkout' }
  | { status: 'error'; message: string };

const HOOKS_PATH = 'scripts/git-hooks';

/** Repo root inferred from this file's own location: src/service/
 *  git-hooks-activate.ts (or dist/service/git-hooks-activate.js post-build)
 *  is two levels below the repo root — same convention as release.ts's
 *  defaultCheckoutDir() and cli/index.ts's package.json lookup. */
export function defaultRepoRootForThisBuild(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', '..');
}

/**
 * Idempotently set `core.hooksPath` to `scripts/git-hooks` for the git
 * checkout at `repoRoot` (defaults to the currently-running build's own
 * repo root — see defaultRepoRootForThisBuild).
 *
 * Skips silently with `not-a-git-checkout` when `repoRoot` has no `.git`
 * or no `scripts/git-hooks` directory — an npm-installed user's install
 * location has neither, and this must never surface an error or a log
 * line for them; there is no hook to activate.
 *
 * Never throws: any failure to invoke `git` itself (missing binary,
 * non-zero exit) comes back as `{ status: 'error', message }` for the
 * caller to log as a soft warning — this must never block `init`/`reinstall`.
 */
export function activateGitHooks(repoRoot: string = defaultRepoRootForThisBuild()): HooksActivationResult {
  if (!existsSync(join(repoRoot, '.git')) || !existsSync(join(repoRoot, HOOKS_PATH))) {
    return { status: 'not-a-git-checkout' };
  }

  try {
    const current = spawnSync('git', ['config', '--get', 'core.hooksPath'], { cwd: repoRoot, encoding: 'utf8' });
    if (current.status === 0 && current.stdout.trim() === HOOKS_PATH) {
      return { status: 'already-set', repoRoot };
    }

    const set = spawnSync('git', ['config', 'core.hooksPath', HOOKS_PATH], { cwd: repoRoot, encoding: 'utf8' });
    if (set.error) {
      return { status: 'error', message: set.error.message };
    }
    if (set.status !== 0) {
      return { status: 'error', message: (set.stderr || '').trim() || `git config exited with status ${set.status}` };
    }
    return { status: 'set', repoRoot };
  } catch (err) {
    return { status: 'error', message: err instanceof Error ? err.message : String(err) };
  }
}
