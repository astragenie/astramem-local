/**
 * tests/service/git-hooks-activate.test.ts — FEAT-439 residual.
 *
 * Exercises activateGitHooks() against real fixture git repos (spawnSync +
 * an actual `git` binary, no mocking — same style as
 * tests/scripts/post-merge-rebuild.test.ts) rather than the mocked
 * execSync/execFileSync tests/cli/init.test.ts installs for the Ollama
 * checks; see git-hooks-activate.ts's file header for why this module
 * deliberately avoids those two functions.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { activateGitHooks } from '../../src/service/git-hooks-activate.js';

let tmpDirs: string[] = [];

function mkTmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function git(cwd: string, args: string[]): string {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (exit ${res.status}): ${res.stderr}`);
  }
  return res.stdout;
}

/** Fixture repo shaped like this one: a real .git plus a scripts/git-hooks
 *  dir containing a stand-in post-merge hook file (content doesn't matter —
 *  activateGitHooks() only checks the directory exists). */
function initFixtureRepo(dir: string): void {
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  mkdirSync(join(dir, 'scripts', 'git-hooks'), { recursive: true });
  writeFileSync(join(dir, 'scripts', 'git-hooks', 'post-merge'), '#!/usr/bin/env node\n', 'utf8');
  writeFileSync(join(dir, 'README.md'), 'hello\n', 'utf8');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'init']);
}

function readHooksPath(dir: string): string | null {
  const res = spawnSync('git', ['config', '--get', 'core.hooksPath'], { cwd: dir, encoding: 'utf8' });
  return res.status === 0 ? res.stdout.trim() : null;
}

afterEach(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  tmpDirs = [];
});

describe('activateGitHooks: real fixture git repo', () => {
  it('sets core.hooksPath on a fresh checkout that has never configured it', () => {
    const dir = mkTmpDir('astramem-hooks-fresh-');
    initFixtureRepo(dir);
    expect(readHooksPath(dir)).toBeNull();

    const result = activateGitHooks(dir);
    expect(result).toEqual({ status: 'set', repoRoot: dir });
    expect(readHooksPath(dir)).toBe('scripts/git-hooks');
  });

  it('is idempotent — a second call reports already-set and does not error', () => {
    const dir = mkTmpDir('astramem-hooks-idempotent-');
    initFixtureRepo(dir);

    const first = activateGitHooks(dir);
    expect(first.status).toBe('set');

    const second = activateGitHooks(dir);
    expect(second).toEqual({ status: 'already-set', repoRoot: dir });
    expect(readHooksPath(dir)).toBe('scripts/git-hooks'); // unchanged, still correct
  });

  it('overwrites a stale/different hooksPath value rather than leaving it alone, and reports it as overwrote (not a fresh set)', () => {
    const dir = mkTmpDir('astramem-hooks-stale-');
    initFixtureRepo(dir);
    git(dir, ['config', 'core.hooksPath', 'some/other/path']);

    const result = activateGitHooks(dir);
    expect(result).toEqual({ status: 'overwrote', repoRoot: dir, previousValue: 'some/other/path' });
    expect(readHooksPath(dir)).toBe('scripts/git-hooks');
  });
});

describe('activateGitHooks: non-git-checkout no-op', () => {
  it('a plain (non-git) directory is a silent no-op — no error, no throw', () => {
    const dir = mkTmpDir('astramem-hooks-nongit-');
    // deliberately no `git init`
    const result = activateGitHooks(dir);
    expect(result).toEqual({ status: 'not-a-git-checkout' });
  });

  it('a real git repo that lacks scripts/git-hooks (not this project) is also a no-op', () => {
    const dir = mkTmpDir('astramem-hooks-othergit-');
    git(dir, ['init', '-q']);
    git(dir, ['config', 'user.email', 'test@example.com']);
    git(dir, ['config', 'user.name', 'Test']);
    writeFileSync(join(dir, 'README.md'), 'hello\n', 'utf8');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-q', '-m', 'init']);
    // no scripts/git-hooks directory created

    const result = activateGitHooks(dir);
    expect(result).toEqual({ status: 'not-a-git-checkout' });
    expect(readHooksPath(dir)).toBeNull(); // untouched
  });

  it('a nonexistent directory is a no-op, not a throw', () => {
    const dir = join(tmpdir(), 'astramem-hooks-does-not-exist-' + Date.now());
    expect(() => activateGitHooks(dir)).not.toThrow();
    expect(activateGitHooks(dir)).toEqual({ status: 'not-a-git-checkout' });
  });
});
