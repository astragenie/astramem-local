/**
 * tests/doctor/service-pointer-check.test.ts
 *
 * FEAT-438 SLICE-418 AC-4: doctor's "Service pointer" check must WARN loudly
 * when current.json is `--dev`-pinned (src/cli/reinstall.ts's
 * `reinstallDev`), report "release-pinned: <id>" ONLY when entryJs actually
 * resolves to a real release dir, and otherwise WARN "not release-pinned" —
 * a fresh `init` / `service install` (install-flow.ts with no
 * entryJsOverride) points current.json straight at the checkout's dist/
 * WITHOUT ever setting devPinned, so "devPinned falsy" alone must NOT be
 * read as "release-pinned" (review MEDIUM fix on this slice).
 *
 * Uses `servicePointerPath` + `releasesRoot` (test-only seams on
 * DoctorCheckOpts — see src/doctor/checks.ts) to point the check at a
 * fixture current.json / fixture releases dir instead of the real
 * %LOCALAPPDATA%\Astramem\bin\current.json / \releases.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getChecks } from '../../src/doctor/checks.js';

function findCheck(checks: ReturnType<typeof getChecks>, name: string) {
  const c = checks.find(c => c.name === name);
  if (!c) throw new Error(`check not found: ${name}`);
  return c;
}

describe('doctor "Service pointer" check (FEAT-438 SLICE-418 AC-4)', () => {
  let dir: string;
  let pointerPath: string;
  let releasesRoot: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'astra-doctor-pointer-'));
    pointerPath = join(dir, 'current.json');
    releasesRoot = join(dir, 'releases');
    mkdirSync(releasesRoot, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function checkFor(pointerPathOverride: string, releasesRootOverride: string = releasesRoot) {
    return findCheck(
      getChecks({ servicePointerPath: pointerPathOverride, releasesRoot: releasesRootOverride }),
      'Service pointer',
    );
  }

  function makeFixtureRelease(id: string): string {
    const releaseDir = join(releasesRoot, id);
    mkdirSync(join(releaseDir, 'dist', 'cli'), { recursive: true });
    writeFileSync(join(releaseDir, 'dist', 'cli', 'index.js'), '// fixture\n', 'utf8');
    writeFileSync(
      join(releaseDir, 'release.json'),
      JSON.stringify({ id, pkgversion: id.split('+')[0], gitsha: 'fixture', createdAt: new Date().toISOString(), nodeVersion: process.version }),
      'utf8',
    );
    return join(releaseDir, 'dist', 'cli', 'index.js');
  }

  it('ok: no current.json yet (fresh / not-yet-installed)', async () => {
    const res = await checkFor(join(dir, 'does-not-exist.json')).run();
    expect(res.ok).toBe(true);
    expect(res.message).toContain('not installed yet');
  });

  it('WARN: devPinned true — loud message + fix hint (takes priority over id resolution)', async () => {
    // Even if entryJs happens to look like a real release path, devPinned
    // must win — it's an explicit, authoritative marker set only by
    // reinstallDev.
    const entryJs = makeFixtureRelease('9.9.9+wouldresolve');
    writeFileSync(pointerPath, JSON.stringify({ nodeBin: 'node', entryJs, port: 7777, devPinned: true }), 'utf8');

    const res = await checkFor(pointerPath).run();
    expect(res.ok).toBe(false);
    expect(res.message).toContain('DEV-PINNED');
    expect(res.message).toContain('not a release');
    expect(res.fix).toContain('reinstall');
  });

  it('ok: release-pinned pointer with a fixture release on disk reports "release-pinned: <id>"', async () => {
    const entryJs = makeFixtureRelease('1.2.3+abcdef');
    writeFileSync(pointerPath, JSON.stringify({ nodeBin: 'node', entryJs, port: 7777 }), 'utf8');

    const res = await checkFor(pointerPath).run();
    expect(res.ok).toBe(true);
    expect(res.message).toBe('service is release-pinned: 1.2.3+abcdef');
  });

  it('ok: release-pinned pointer with devPinned explicitly false behaves like release-pinned', async () => {
    const entryJs = makeFixtureRelease('2.0.0+ffffff');
    writeFileSync(pointerPath, JSON.stringify({ nodeBin: 'node', entryJs, port: 7777, devPinned: false }), 'utf8');

    const res = await checkFor(pointerPath).run();
    expect(res.ok).toBe(true);
    expect(res.message).toBe('service is release-pinned: 2.0.0+ffffff');
  });

  it('WARN (review MEDIUM fix): devPinned falsy but entryJs does NOT resolve to any release — must NOT claim release-pinned', async () => {
    // This is the exact fresh `init` / `service install` shape: entryJs
    // points at the checkout's own dist/, devPinned is never set at all.
    // The pre-fix code returned {ok:true, message: "...release-pinned..."}
    // here — a false positive that undermined AC-4.
    const entryJs = join(dir, 'checkout', 'dist', 'cli', 'index.js');
    writeFileSync(pointerPath, JSON.stringify({ nodeBin: 'node', entryJs, port: 7777 }), 'utf8');

    const res = await checkFor(pointerPath).run();
    expect(res.ok).toBe(false);
    expect(res.message).toContain('not release-pinned');
    expect(res.message).not.toContain('is release-pinned');
    expect(res.fix).toContain('reinstall');
  });

  it('fails gracefully (not throws) when current.json is unparseable', async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(pointerPath, '{ not valid json', 'utf8');

    const res = await checkFor(pointerPath).run();
    expect(res.ok).toBe(false);
    expect(res.message).toContain('unreadable');
  });
});
