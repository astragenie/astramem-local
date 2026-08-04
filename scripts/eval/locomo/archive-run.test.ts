/**
 * P0-3 (2026-08-04): proves archive-run.mts survives deletion of the git
 * worktree it was invoked from. This repo already lost two headline LoCoMo
 * numbers to exactly this failure mode (see archive-run.mts's header
 * comment) because the old code resolved `docs/eval-runs` relative to
 * `process.cwd()` -- inside a throwaway eval worktree, that cwd-relative
 * path IS the worktree, and deleting the worktree deletes the "archive"
 * with it.
 *
 * Builds a fully ISOLATED throwaway git repo (a primary checkout + one
 * linked worktree, both under a temp dir) so this test never touches this
 * repo's own real docs/eval-runs/ -- archive-run.mts is run with cwd set
 * to the linked worktree against a stub run-dir, the worktree directory is
 * then deleted outright (simulating exactly what happened for real), and
 * the archived files + ledger row are asserted to still exist under the
 * PRIMARY checkout.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ARCHIVE_SCRIPT = join(HERE, 'archive-run.mts');

function git(cwd: string, args: string[]): void {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd}:\n${r.stderr}`);
  }
}

/** Minimal stub run-dir + sibling `<run>.metrics.json` in the shape
 *  archive-run.mts expects -- enough to exercise the score/params parsing
 *  without running any real (metered) LoCoMo eval. */
function writeStubRun(scratchDir: string): string {
  const runDir = join(scratchDir, 'stub-run');
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'run-manifest.json'), JSON.stringify({
    config: {
      extractionPasses: 2, k: 15,
      models: { extractionProvider: 'codex', extraction: 'gpt-5.4-mini' },
      gitState: { sha: 'deadbeef', srcDirty: false },
    },
  }));
  writeFileSync(join(runDir, 'run-params.json'), JSON.stringify({ note: 'stub run for P0-3 archive test' }));
  writeFileSync(`${runDir}.metrics.json`, JSON.stringify({
    f1: { per_category: { single_hop: { accuracy: 0.6, n: 199 } } },
  }));
  return runDir;
}

describe('archive-run.mts — archive survives worktree deletion (P0-3)', () => {
  let scratchDir: string;
  afterEach(() => {
    if (scratchDir) rmSync(scratchDir, { recursive: true, force: true });
  });

  it('resolves the archive to the PRIMARY checkout so it outlives the worktree it ran from', () => {
    scratchDir = mkdtempSync(join(tmpdir(), 'archive-run-p0-3-'));
    const primaryRepo = join(scratchDir, 'primary');
    const worktree = join(scratchDir, 'worktree');
    mkdirSync(primaryRepo, { recursive: true });

    git(primaryRepo, ['init', '-q']);
    git(primaryRepo, ['config', 'user.email', 'test@example.com']);
    git(primaryRepo, ['config', 'user.name', 'Test']);
    writeFileSync(join(primaryRepo, 'README.md'), '# scratch\n');
    git(primaryRepo, ['add', 'README.md']);
    git(primaryRepo, ['commit', '-q', '-m', 'init']);
    git(primaryRepo, ['worktree', 'add', '-q', '--detach', worktree]);

    const runDir = writeStubRun(scratchDir);

    // Invoke from the LINKED WORKTREE's cwd -- the exact scenario that lost
    // the two real numbers this repo cites (an eval run executed inside a
    // throwaway worktree).
    const result = spawnSync('bun', [ARCHIVE_SCRIPT, '--run-dir', runDir, '--name', 'p0-3-stub'], {
      cwd: worktree,
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('score: 0.6000');
    expect(result.stdout).toContain('n=199');

    // Must NOT have landed inside the worktree's own copy of docs/eval-runs.
    expect(existsSync(join(worktree, 'docs', 'eval-runs', 'p0-3-stub'))).toBe(false);
    // Must have landed under the primary checkout instead.
    const archivedManifest = join(primaryRepo, 'docs', 'eval-runs', 'p0-3-stub', 'run-manifest.json');
    const archivedMetrics = join(primaryRepo, 'docs', 'eval-runs', 'p0-3-stub', 'metrics.json');
    const ledger = join(primaryRepo, 'docs', 'eval-runs', 'LEDGER.md');
    expect(existsSync(archivedManifest)).toBe(true);
    expect(existsSync(archivedMetrics)).toBe(true);
    expect(existsSync(ledger)).toBe(true);
    expect(readFileSync(ledger, 'utf8')).toContain('p0-3-stub');

    // Destroy the worktree exactly like the real incidents (worktree
    // pruned / deleted after the throwaway eval sandbox was done with it).
    // On today's (pre-fix) code this is the moment the "archived" evidence
    // would vanish, because it lived inside this very directory.
    rmSync(worktree, { recursive: true, force: true });

    expect(existsSync(archivedManifest)).toBe(true);
    expect(existsSync(archivedMetrics)).toBe(true);
    expect(existsSync(ledger)).toBe(true);
    expect(readFileSync(ledger, 'utf8')).toContain('p0-3-stub');
  });

  it('fails loud (non-zero exit, no silent partial archive) when the primary checkout cannot be resolved', () => {
    scratchDir = mkdtempSync(join(tmpdir(), 'archive-run-p0-3-noloud-'));
    const plainDir = join(scratchDir, 'not-a-git-repo');
    mkdirSync(plainDir, { recursive: true });
    const runDir = writeStubRun(scratchDir);

    // Force `git rev-parse --git-common-dir` to fail deterministically.
    // Plain non-repo cwds aren't reliable for this on every dev box (git
    // walks up parent directories looking for a repo, and e.g. a tracked
    // dotfiles repo at $HOME would make an ordinary temp-dir cwd resolve
    // successfully) -- an explicit bogus GIT_DIR bypasses discovery
    // entirely and always errors "not a git repository".
    const result = spawnSync('bun', [ARCHIVE_SCRIPT, '--run-dir', runDir, '--name', 'p0-3-noloud'], {
      cwd: plainDir,
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, GIT_DIR: join(scratchDir, 'definitely-not-a-repo', '.git') },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Refusing to archive');
    expect(result.stdout).not.toContain('score:');
  });
});
