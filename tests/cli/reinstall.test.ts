/**
 * tests/cli/reinstall.test.ts
 *
 * FEAT-438 SLICE-417 review HIGH finding: `reinstallCommand` repoints
 * current.json at a freshly-materialized release BEFORE it has proven
 * itself healthy. Every failure branch that can occur after that repoint
 * (install-service throw, start-service throw, health-check timeout, a
 * served-version mismatch, and a /version fetch throw) MUST restore the
 * prior pointer — otherwise the PT5M keepalive restarts against a broken
 * pointer forever (the exact silent-daemon-down outage class this command
 * exists to close).
 *
 * `reinstallCommand` itself is not practically unit-testable in isolation
 * (it drives real installServiceFlow/schtasks, real fetch, real process
 * exit) — per the review's own note, the fix is to extract the one piece
 * that IS the restore *decision*: `restorePriorPointer(priorPointer,
 * pointerPath, platform)`. Every failure branch in reinstallCommand now
 * calls this exact function (see src/cli/reinstall.ts), so exhaustively
 * testing its behavior here covers the restore outcome for all five
 * failure branches — they differ only in *which* trigger fired, never in
 * what "restore" means once triggered.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { restorePriorPointer } from '../../src/cli/reinstall.js';
import { shimPaths, writePointer, type ShimPointer } from '../../src/service/shim.js';

describe('restorePriorPointer (FEAT-438 SLICE-417 review HIGH fix)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'astra-reinstall-restore-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('version-mismatch scenario: a valid prior pointer is restored on win32', () => {
    const paths = shimPaths(dir);
    const prior: ShimPointer = { nodeBin: 'node', entryJs: 'C:\\releases\\1.0.0+abc\\dist\\cli\\index.js', port: 7777 };
    writePointer(prior, paths.pointerPath);
    // Simulate reinstall having already repointed current.json at the new
    // (unproven) release before the version check ran.
    writePointer({ nodeBin: 'node', entryJs: 'C:\\releases\\2.0.0+def\\dist\\cli\\index.js', port: 7777 }, paths.pointerPath);

    const detail = restorePriorPointer(prior, paths.pointerPath, 'win32');

    expect(detail).toContain('prior pointer restored');
    expect(detail).toContain(prior.entryJs);
    const restored = JSON.parse(readFileSync(paths.pointerPath, 'utf8')) as ShimPointer;
    expect(restored).toEqual(prior);
  });

  it('install-service-throw scenario: restores the prior pointer identically to the mismatch case', () => {
    const paths = shimPaths(dir);
    const prior: ShimPointer = { nodeBin: 'node', entryJs: 'old-entry.js', port: 1 };
    writePointer(prior, paths.pointerPath);
    writePointer({ nodeBin: 'node', entryJs: 'new-entry.js', port: 1 }, paths.pointerPath);

    const detail = restorePriorPointer(prior, paths.pointerPath, 'win32');

    expect(detail).toContain('prior pointer restored → old-entry.js');
    const restored = JSON.parse(readFileSync(paths.pointerPath, 'utf8')) as ShimPointer;
    expect(restored.entryJs).toBe('old-entry.js');
  });

  it('start-service-throw scenario: restores the prior pointer identically to the mismatch case', () => {
    const paths = shimPaths(dir);
    const prior: ShimPointer = { nodeBin: 'node', entryJs: 'known-good.js', port: 2 };
    writePointer(prior, paths.pointerPath);
    writePointer({ nodeBin: 'node', entryJs: 'unverified.js', port: 2 }, paths.pointerPath);

    const detail = restorePriorPointer(prior, paths.pointerPath, 'win32');

    expect(detail).toContain('prior pointer restored → known-good.js');
    const restored = JSON.parse(readFileSync(paths.pointerPath, 'utf8')) as ShimPointer;
    expect(restored.entryJs).toBe('known-good.js');
  });

  it('health-timeout scenario: restores the prior pointer identically to the mismatch case', () => {
    const paths = shimPaths(dir);
    const prior: ShimPointer = { nodeBin: 'node', entryJs: 'last-healthy.js', port: 3 };
    writePointer(prior, paths.pointerPath);
    writePointer({ nodeBin: 'node', entryJs: 'never-answered.js', port: 3 }, paths.pointerPath);

    const detail = restorePriorPointer(prior, paths.pointerPath, 'win32');

    expect(detail).toContain('prior pointer restored → last-healthy.js');
    const restored = JSON.parse(readFileSync(paths.pointerPath, 'utf8')) as ShimPointer;
    expect(restored.entryJs).toBe('last-healthy.js');
  });

  it('no-prior-pointer (first install) scenario on win32: no-ops cleanly and reports honestly', () => {
    const paths = shimPaths(dir);
    // Nothing was ever written — pointerPath does not exist.
    expect(existsSync(paths.pointerPath)).toBe(false);

    const detail = restorePriorPointer(null, paths.pointerPath, 'win32');

    expect(detail).toBe('no prior pointer to restore (first install or unreadable current.json)');
    // Must not have fabricated a pointer file as a side effect.
    expect(existsSync(paths.pointerPath)).toBe(false);
  });

  it('non-Windows platform: message does not claim a restore was attempted (review MEDIUM accuracy fix)', () => {
    const paths = shimPaths(dir);
    const prior: ShimPointer = { nodeBin: 'node', entryJs: '/opt/astramem/dist/cli/index.js', port: 7777 };

    // Even if a caller somehow had a non-null priorPointer, non-win32 must
    // not claim to have restored anything — there is no pointer indirection
    // on that platform to begin with.
    const detail = restorePriorPointer(prior, paths.pointerPath, 'linux');

    expect(detail).toBe('no rollback pointer on this platform (current.json indirection is Windows-only)');
    expect(detail).not.toContain('restored');
    // Confirms it is a true no-op: no file was written.
    expect(existsSync(paths.pointerPath)).toBe(false);
  });

  it('restore-failure path: a writePointer error is surfaced, not swallowed', () => {
    const prior: ShimPointer = { nodeBin: 'node', entryJs: 'good.js', port: 7777 };

    // Force writePointer's mkdirSync(dirname(pointerPath), {recursive:true})
    // to throw by making a PATH SEGMENT a plain file instead of a directory
    // (ENOTDIR) — portable across win32/posix, no chmod/permission games.
    const blockerFile = join(dir, 'blocker');
    writeFileSync(blockerFile, 'not a directory', 'utf8');
    const unwritablePointerPath = join(blockerFile, 'nested', 'current.json');

    const detail = restorePriorPointer(prior, unwritablePointerPath, 'win32');

    expect(detail).toContain('restore FAILED');
    expect(detail).toContain('fix manually');
  });
});
