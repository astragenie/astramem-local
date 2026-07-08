/**
 * tests/service/release-retention.test.ts
 *
 * FEAT-438 SLICE-418 AC-3: retention (`listReleases` / `pruneReleases` in
 * src/service/release.ts). Uses lightweight fixture release dirs (a
 * hand-written release.json + a stub dist/cli/index.js) rather than running
 * materializeRelease's real `bun install` — these two functions only ever
 * read/delete on-disk release directories, they never boot-verify anything.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync as realRmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The mocked rmSync below deliberately does NOT delegate to `actual.rmSync`
// for recursive deletes: on this runtime, `actual.rmSync` and the live
// 'node:fs' export binding are the same underlying object, so a naive
// `vi.fn(actual.rmSync)` recurses into ITSELF for every nested file/dir and
// blows the call stack the moment a release fixture has more than one path
// segment (dist/cli/index.js). Implementing the passthrough manually with
// lstatSync/readdirSync/unlinkSync/rmdirSync (none of which recurse through
// the mocked rmSync binding) sidesteps that entirely while still giving
// individual tests a hook to force a specific path to fail (the soft-fail
// scenario pruneReleases must tolerate).
const forcedFailurePaths = new Set<string>();

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();

  function manualDelete(path: string): void {
    let stat;
    try {
      stat = actual.lstatSync(path);
    } catch {
      return; // already gone — rmSync's own `force: true` semantics
    }
    if (stat.isDirectory()) {
      for (const entry of actual.readdirSync(path)) {
        manualDelete(`${path}/${entry}`);
      }
      actual.rmdirSync(path);
    } else {
      actual.unlinkSync(path);
    }
  }

  return {
    ...actual,
    rmSync: vi.fn((path: unknown) => {
      const p = String(path);
      if (forcedFailurePaths.has(p)) {
        throw new Error('EBUSY: resource busy or locked (simulated)');
      }
      manualDelete(p);
    }),
  };
});

import { rmSync } from 'node:fs';
import { listReleases, pruneReleases, releaseIdFromEntryJs } from '../../src/service/release.js';

function makeFakeRelease(releasesRoot: string, id: string, createdAt: string): string {
  const dir = join(releasesRoot, id);
  mkdirSync(join(dir, 'dist', 'cli'), { recursive: true });
  writeFileSync(join(dir, 'dist', 'cli', 'index.js'), '// fake release entry\n', 'utf8');
  const [pkgversion, gitsha] = id.split('+');
  writeFileSync(
    join(dir, 'release.json'),
    JSON.stringify({ id, pkgversion, gitsha: gitsha ?? 'nogit', createdAt, nodeVersion: process.version }, null, 2),
    'utf8',
  );
  return dir;
}

describe('listReleases', () => {
  let root: string;
  let releasesRoot: string;

  beforeEach(() => {
    vi.mocked(rmSync).mockClear();
    root = mkdtempSync(join(tmpdir(), 'astra-release-retention-'));
    releasesRoot = join(root, 'releases');
    mkdirSync(releasesRoot, { recursive: true });
  });

  afterEach(() => {
    realRmSync(root, { recursive: true, force: true });
  });

  it('returns [] when releasesRoot does not exist', () => {
    expect(listReleases(join(root, 'nope'))).toEqual([]);
  });

  it('returns [] when releasesRoot exists but is empty', () => {
    expect(listReleases(releasesRoot)).toEqual([]);
  });

  it('sorts newest-first by createdAt', () => {
    makeFakeRelease(releasesRoot, '1.0.0+aaa', '2026-01-01T00:00:00.000Z');
    makeFakeRelease(releasesRoot, '3.0.0+ccc', '2026-03-01T00:00:00.000Z');
    makeFakeRelease(releasesRoot, '2.0.0+bbb', '2026-02-01T00:00:00.000Z');

    const releases = listReleases(releasesRoot);
    expect(releases.map(r => r.id)).toEqual(['3.0.0+ccc', '2.0.0+bbb', '1.0.0+aaa']);
  });

  it('tie-breaks identical createdAt by id descending (deterministic)', () => {
    makeFakeRelease(releasesRoot, '1.0.0+aaa', '2026-01-01T00:00:00.000Z');
    makeFakeRelease(releasesRoot, '1.0.0+zzz', '2026-01-01T00:00:00.000Z');
    makeFakeRelease(releasesRoot, '1.0.0+mmm', '2026-01-01T00:00:00.000Z');

    const releases = listReleases(releasesRoot);
    expect(releases.map(r => r.id)).toEqual(['1.0.0+zzz', '1.0.0+mmm', '1.0.0+aaa']);
  });

  it('skips .tmp-* and *.failed dirs', () => {
    makeFakeRelease(releasesRoot, '1.0.0+aaa', '2026-01-01T00:00:00.000Z');
    mkdirSync(join(releasesRoot, '.tmp-somebuild'), { recursive: true });
    writeFileSync(join(releasesRoot, '.tmp-somebuild', 'release.json'), JSON.stringify({ id: 'x', createdAt: '2026-06-01T00:00:00.000Z' }), 'utf8');
    mkdirSync(join(releasesRoot, '2.0.0+bbb.failed'), { recursive: true });
    writeFileSync(join(releasesRoot, '2.0.0+bbb.failed', 'release.json'), JSON.stringify({ id: '2.0.0+bbb', createdAt: '2026-05-01T00:00:00.000Z' }), 'utf8');

    const releases = listReleases(releasesRoot);
    expect(releases.map(r => r.id)).toEqual(['1.0.0+aaa']);
  });

  it('skips a dir with no release.json', () => {
    makeFakeRelease(releasesRoot, '1.0.0+aaa', '2026-01-01T00:00:00.000Z');
    mkdirSync(join(releasesRoot, '9.9.9+nomanifest'), { recursive: true });

    const releases = listReleases(releasesRoot);
    expect(releases.map(r => r.id)).toEqual(['1.0.0+aaa']);
  });

  it('skips a dir with unparseable release.json instead of throwing', () => {
    makeFakeRelease(releasesRoot, '1.0.0+aaa', '2026-01-01T00:00:00.000Z');
    const dir = join(releasesRoot, '9.9.9+broken');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'release.json'), '{ not valid json', 'utf8');

    expect(() => listReleases(releasesRoot)).not.toThrow();
    const releases = listReleases(releasesRoot);
    expect(releases.map(r => r.id)).toEqual(['1.0.0+aaa']);
  });

  it('skips a dir whose release.json is missing id/createdAt fields', () => {
    makeFakeRelease(releasesRoot, '1.0.0+aaa', '2026-01-01T00:00:00.000Z');
    const dir = join(releasesRoot, '9.9.9+incomplete');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'release.json'), JSON.stringify({ pkgversion: '9.9.9' }), 'utf8');

    const releases = listReleases(releasesRoot);
    expect(releases.map(r => r.id)).toEqual(['1.0.0+aaa']);
  });

  it('skips a plain file sitting directly in releasesRoot', () => {
    makeFakeRelease(releasesRoot, '1.0.0+aaa', '2026-01-01T00:00:00.000Z');
    writeFileSync(join(releasesRoot, 'stray-file.txt'), 'not a release', 'utf8');

    const releases = listReleases(releasesRoot);
    expect(releases.map(r => r.id)).toEqual(['1.0.0+aaa']);
  });
});

describe('pruneReleases', () => {
  let root: string;
  let releasesRoot: string;

  beforeEach(() => {
    vi.mocked(rmSync).mockClear();
    forcedFailurePaths.clear();
    root = mkdtempSync(join(tmpdir(), 'astra-release-prune-'));
    releasesRoot = join(root, 'releases');
    mkdirSync(releasesRoot, { recursive: true });
  });

  afterEach(() => {
    forcedFailurePaths.clear();
    realRmSync(root, { recursive: true, force: true });
  });

  it('keeps the newest `keep` releases and prunes the rest', () => {
    const dirs = {
      r1: makeFakeRelease(releasesRoot, '1.0.0+r1', '2026-01-01T00:00:00.000Z'),
      r2: makeFakeRelease(releasesRoot, '2.0.0+r2', '2026-02-01T00:00:00.000Z'),
      r3: makeFakeRelease(releasesRoot, '3.0.0+r3', '2026-03-01T00:00:00.000Z'),
      r4: makeFakeRelease(releasesRoot, '4.0.0+r4', '2026-04-01T00:00:00.000Z'),
    };

    const result = pruneReleases(releasesRoot, 2, []);

    expect(result.kept).toEqual(['4.0.0+r4', '3.0.0+r3']);
    expect(result.pruned).toEqual(['2.0.0+r2', '1.0.0+r1']);
    expect(existsSync(dirs.r4)).toBe(true);
    expect(existsSync(dirs.r3)).toBe(true);
    expect(existsSync(dirs.r2)).toBe(false);
    expect(existsSync(dirs.r1)).toBe(false);
  });

  it('never prunes an id in protectIds, even when older than the retention window', () => {
    const dirs = {
      r1: makeFakeRelease(releasesRoot, '1.0.0+r1', '2026-01-01T00:00:00.000Z'),
      r2: makeFakeRelease(releasesRoot, '2.0.0+r2', '2026-02-01T00:00:00.000Z'),
      r3: makeFakeRelease(releasesRoot, '3.0.0+r3', '2026-03-01T00:00:00.000Z'),
      r4: makeFakeRelease(releasesRoot, '4.0.0+r4', '2026-04-01T00:00:00.000Z'),
    };

    // keep=1 would normally only retain r4, but r1 is protected (e.g. the
    // release current.json is still pointed at) so it must survive too.
    const result = pruneReleases(releasesRoot, 1, ['1.0.0+r1']);

    expect(result.kept.sort()).toEqual(['1.0.0+r1', '4.0.0+r4'].sort());
    expect(result.pruned.sort()).toEqual(['2.0.0+r2', '3.0.0+r3'].sort());
    expect(existsSync(dirs.r1)).toBe(true);
    expect(existsSync(dirs.r4)).toBe(true);
    expect(existsSync(dirs.r2)).toBe(false);
    expect(existsSync(dirs.r3)).toBe(false);
  });

  it('soft-fails on an undeletable release dir: recorded in pruned, run does not throw, dir survives', () => {
    const dirs = {
      r1: makeFakeRelease(releasesRoot, '1.0.0+r1', '2026-01-01T00:00:00.000Z'),
      r2: makeFakeRelease(releasesRoot, '2.0.0+r2', '2026-02-01T00:00:00.000Z'),
    };

    forcedFailurePaths.add(dirs.r1);

    let result: ReturnType<typeof pruneReleases> | undefined;
    expect(() => {
      result = pruneReleases(releasesRoot, 0, []);
    }).not.toThrow();

    expect(result!.kept).toEqual([]);
    expect(result!.pruned.some(p => p.startsWith('1.0.0+r1') && p.includes('delete failed'))).toBe(true);
    expect(result!.pruned).toContain('2.0.0+r2');
    // The mocked delete "failed" — nothing actually deleted it on disk.
    expect(existsSync(dirs.r1)).toBe(true);
  });

  it('returns empty kept/pruned when there are no releases', () => {
    const result = pruneReleases(releasesRoot, 2, []);
    expect(result).toEqual({ pruned: [], kept: [] });
  });
});

describe('releaseIdFromEntryJs (FEAT-438 SLICE-418 AC-3/AC-4)', () => {
  // Paths built with join() so separators are native on both win32 and posix
  // — releaseIdFromEntryJs uses path.relative/isAbsolute, which are
  // platform-specific, so hardcoded 'C:\\…' literals only parse on Windows.
  it('extracts the release id when entryJs lives under releasesRoot', () => {
    const releasesRoot = join('base', 'Astramem', 'releases');
    const entryJs = join(releasesRoot, '1.2.3+abcdef', 'dist', 'cli', 'index.js');
    expect(releaseIdFromEntryJs(entryJs, releasesRoot)).toBe('1.2.3+abcdef');
  });

  it('returns null for a --dev-pinned pointer (checkout dist/, not under releasesRoot)', () => {
    const releasesRoot = join('base', 'Astramem', 'releases');
    const entryJs = join('base', 'checkout', 'astramemory-local', 'dist', 'cli', 'index.js');
    expect(releaseIdFromEntryJs(entryJs, releasesRoot)).toBeNull();
  });

  it('returns null for an empty/identical path (entryJs === releasesRoot)', () => {
    const releasesRoot = join('base', 'Astramem', 'releases');
    expect(releaseIdFromEntryJs(releasesRoot, releasesRoot)).toBeNull();
  });
});
