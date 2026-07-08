/**
 * tests/scripts/post-merge-rebuild.test.ts
 *
 * FEAT-439 AC-1/AC-3/AC-4: unit + fixture-repo coverage for the git
 * post-merge trigger (scripts/git-hooks/post-merge-rebuild.mjs).
 *
 * Loaded via a computed (non-literal) dynamic import path — same pattern
 * src/doctor/checks.ts's resolveServedSchemaVersion() uses to dynamically
 * import a release's compiled wire-meta.js — so tsc never tries to resolve
 * module types for a plain .mjs script that lives outside src/ and has no
 * declaration file; vitest (esbuild-transpiled, no ambient typecheck) runs
 * it exactly like any other import either way.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mod: any;

beforeAll(async () => {
  const modPath = join(__dirname, '..', '..', 'scripts', 'git-hooks', 'post-merge-rebuild.mjs');
  mod = await import(pathToFileURL(modPath).href);
});

function git(cwd: string, args: string[]): string {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (exit ${res.status}): ${res.stderr}`);
  }
  return res.stdout;
}

function initFixtureRepo(dir: string): void {
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  writeFileSync(join(dir, 'README.md'), 'hello\n', 'utf8');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'init']);
}

/** Merges a feature branch touching `relPath` into the current branch —
 *  sets ORIG_HEAD the same way a real `git pull`/`git merge` would, so
 *  main()'s ORIG_HEAD..HEAD range detection sees exactly what a real
 *  post-merge hook invocation would. */
function mergeBranchTouching(dir: string, relPath: string, content: string): void {
  const base = git(dir, ['branch', '--show-current']).trim();
  git(dir, ['checkout', '-q', '-b', 'feature-tmp']);
  const filePath = join(dir, relPath);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, 'utf8');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', `touch ${relPath}`]);
  git(dir, ['checkout', '-q', base]);
  git(dir, ['merge', '-q', '--no-ff', '--no-edit', 'feature-tmp']);
}

describe('post-merge-rebuild.mjs — touchesWatchedPaths (FEAT-439 AC-1)', () => {
  it('matches files under migrations/ and src/storage/', () => {
    expect(mod.touchesWatchedPaths(['migrations/019-x.sql'])).toBe(true);
    expect(mod.touchesWatchedPaths(['src/storage/migrate.ts'])).toBe(true);
  });

  it('does not match unrelated paths', () => {
    expect(mod.touchesWatchedPaths(['src/doctor/checks.ts', 'README.md'])).toBe(false);
  });

  it('WATCHED_PREFIXES is exactly the two documented dirs', () => {
    expect(mod.WATCHED_PREFIXES).toEqual(['migrations/', 'src/storage/']);
  });
});

describe('post-merge-rebuild.mjs — main() (FEAT-439 AC-3/AC-4)', () => {
  let dir: string;
  let stderrOutput: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stderrSpy: any;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'astra-postmerge-'));
    stderrOutput = '';
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .mockImplementation((chunk: any) => {
        stderrOutput += chunk.toString();
        return true;
      });
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  it('skips silently (no throw) when ORIG_HEAD cannot be resolved (fresh repo, no merge yet)', () => {
    initFixtureRepo(dir);
    expect(() => mod.main(dir)).not.toThrow();
    expect(stderrOutput).toContain('could not resolve ORIG_HEAD');
  });

  it('no-op when the merge does not touch migrations/ or src/storage/', () => {
    initFixtureRepo(dir);
    mergeBranchTouching(dir, 'docs/notes.md', 'unrelated change\n');
    mod.main(dir);
    expect(stderrOutput).not.toContain('rebuilding');
    expect(existsSync(join(dir, '.git', 'astramem-post-merge-last-rebuilt-sha'))).toBe(false);
  });

  it(
    'attempts a rebuild when the merge touches migrations/, and reports the failure loudly without ' +
      'blocking (AC-3) — this fixture repo has no build script, so the rebuild pipeline fails as expected',
    () => {
      initFixtureRepo(dir);
      mergeBranchTouching(dir, 'migrations/099-fixture.sql', '-- fixture\n');
      expect(() => mod.main(dir)).not.toThrow();
      expect(stderrOutput).toContain('migrations/ or src/storage/ changed — rebuilding');
      // Which step fails first (bun install vs. bun run build vs. reinstall)
      // depends on what's available in the fixture dir / test environment —
      // the contract under test is that SOME step's failure is reported
      // loudly and non-fatally, not which one.
      expect(stderrOutput).toContain('REBUILD FAILED at step');
      expect(stderrOutput).toContain('merge is NOT reverted');
      // A failed rebuild must never write the marker — writing it here would
      // wrongly suppress the NEXT attempt after the operator fixes whatever
      // step failed.
      expect(existsSync(join(dir, '.git', 'astramem-post-merge-last-rebuilt-sha'))).toBe(false);
    },
    30_000,
  );

  it('de-dup: a second call for the same HEAD (marker already recorded) is a fast no-op (AC-4)', () => {
    initFixtureRepo(dir);
    mergeBranchTouching(dir, 'src/storage/fixture.ts', '// fixture\n');
    const head = git(dir, ['rev-parse', 'HEAD']).trim();
    writeFileSync(join(dir, '.git', 'astramem-post-merge-last-rebuilt-sha'), head, 'utf8');

    mod.main(dir);
    expect(stderrOutput).not.toContain('rebuilding');
  });

  it('src/storage/ changes are detected the same as migrations/ changes', () => {
    initFixtureRepo(dir);
    mergeBranchTouching(dir, 'src/storage/another-fixture.ts', '// fixture\n');
    mod.main(dir);
    expect(stderrOutput).toContain('migrations/ or src/storage/ changed — rebuilding');
  }, 30_000);
});
