import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { materializeRelease } from '../../src/service/release.js';

/** Builds a minimal fake checkout: package.json + a fake dist/cli/index.js
 * that answers `--version`, then runs a real `bun install` once to produce a
 * matching bun.lock. The one dependency is a `file:./dist/tiny-dep` local
 * package — it lives INSIDE dist/ so materializeRelease's plain `dist/` copy
 * carries it into the release tmp dir automatically, and bun install never
 * needs the network (no registry round-trip, fully offline-safe). */
function makeFixtureCheckout(dir: string, opts: { version?: string; brokenPackageJson?: boolean; versionScript?: string } = {}): void {
  const version = opts.version ?? '9.9.9';
  mkdirSync(join(dir, 'dist', 'cli'), { recursive: true });
  mkdirSync(join(dir, 'dist', 'tiny-dep'), { recursive: true });
  // migrations/ must exist in the checkout: materializeRelease copies it to the
  // release root because serve boot's migrate() reads <releaseRoot>/migrations.
  mkdirSync(join(dir, 'migrations'), { recursive: true });
  writeFileSync(join(dir, 'migrations', '001-init.sql'), 'CREATE TABLE IF NOT EXISTS _fixture (id INTEGER);\n', 'utf8');

  const entry =
    opts.versionScript ??
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === '--version' || args[0] === '-v') {
  console.log('${version}');
  process.exit(0);
}
console.log('fake-astramem-local-fixture');
`;
  writeFileSync(join(dir, 'dist', 'cli', 'index.js'), entry, 'utf8');
  writeFileSync(join(dir, 'dist', 'tiny-dep', 'package.json'), JSON.stringify({ name: 'tiny-dep', version: '1.0.0', main: 'index.js' }), 'utf8');
  writeFileSync(join(dir, 'dist', 'tiny-dep', 'index.js'), 'module.exports = {};\n', 'utf8');

  writeFileSync(
    join(dir, 'package.json'),
    opts.brokenPackageJson
      ? '{ this is not valid json'
      : JSON.stringify({ name: 'fake-release-fixture', version, private: true, dependencies: { 'tiny-dep': 'file:./dist/tiny-dep' } }, null, 2),
    'utf8',
  );

  if (!opts.brokenPackageJson) {
    // Generate a real, matching lockfile (setup only — not part of the code
    // under test).
    const res = spawnSync('bun', ['install'], { cwd: dir, encoding: 'utf8' });
    if (res.status !== 0) {
      throw new Error(`fixture setup: bun install failed: ${res.stdout}\n${res.stderr}`);
    }
  } else {
    // bun install would refuse to run against invalid JSON — write a
    // placeholder lockfile so the pre-flight existence check passes and the
    // failure surfaces from the actual install step inside materializeRelease
    // (exercising the quarantine path), not from our own guard clause.
    writeFileSync(join(dir, 'bun.lock'), '{}\n', 'utf8');
  }
}

// FEAT-471: every test here does 1-2 real `bun install` + a boot-verify
// `node ... --version` spawnSync round trip (via makeFixtureCheckout and/or
// materializeRelease itself — "is idempotent" and the self-heal test do
// TWO full rounds). On an idle box that's ~200-800ms total; under
// reproduced parallel load (~16-20 concurrent spawnSync-heavy test
// processes, simulating a second full suite run + eval daemons per the
// FEAT) the same tests measured 1.5-2.5x that, and vitest's un-widened
// 5000ms default testTimeout left near-zero margin. Every `it` below is
// given the same explicit budget already used in the sibling
// tests/scripts/post-merge-rebuild.test.ts for equivalent spawn-heavy work,
// rather than relying on the default tuned for an idle box.
const SPAWN_HEAVY_TIMEOUT_MS = 30_000;

describe('materializeRelease', () => {
  let root: string;
  let checkoutDir: string;
  let releasesRoot: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'astra-release-'));
    checkoutDir = join(root, 'checkout');
    releasesRoot = join(root, 'releases');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('AC-1: materializes dist/, package.json, lockfile, node_modules, and a release.json manifest', () => {
    makeFixtureCheckout(checkoutDir, { version: '9.9.9' });

    const { releaseDir, manifest } = materializeRelease({ checkoutDir, releasesRoot });

    expect(releaseDir).toBe(join(releasesRoot, '9.9.9+nogit'));
    expect(existsSync(join(releaseDir, 'dist', 'cli', 'index.js'))).toBe(true);
    // migrations/ MUST ship — omitting it crashed serve boot's migrate() and
    // silently forced dev-pin fallback on every reinstall (regression guard).
    expect(existsSync(join(releaseDir, 'migrations', '001-init.sql'))).toBe(true);
    expect(existsSync(join(releaseDir, 'package.json'))).toBe(true);
    expect(existsSync(join(releaseDir, 'bun.lock'))).toBe(true);
    expect(existsSync(join(releaseDir, 'node_modules'))).toBe(true);
    expect(existsSync(join(releaseDir, 'release.json'))).toBe(true);

    expect(manifest.pkgversion).toBe('9.9.9');
    expect(manifest.gitsha).toBe('nogit'); // fixture checkout is not a git repo
    expect(manifest.id).toBe('9.9.9+nogit');
    expect(typeof manifest.createdAt).toBe('string');
    expect(new Date(manifest.createdAt).toString()).not.toBe('Invalid Date');
    expect(manifest.nodeVersion).toBe(process.version);

    const onDisk = JSON.parse(readFileSync(join(releaseDir, 'release.json'), 'utf8'));
    expect(onDisk).toEqual(manifest);

    // No stray .tmp-* dirs left behind after a successful rename-to-final.
    const entries = readdirSync(releasesRoot);
    expect(entries.some(e => e.startsWith('.tmp-'))).toBe(false);
  }, SPAWN_HEAVY_TIMEOUT_MS);

  it('AC-2: boot-verify succeeds from outside the checkout — release dir is self-contained', () => {
    makeFixtureCheckout(checkoutDir, { version: '1.2.3' });
    const { releaseDir, manifest } = materializeRelease({ checkoutDir, releasesRoot });
    expect(manifest.pkgversion).toBe('1.2.3');

    // Delete the checkout entirely, then boot the release dir from a cwd
    // that is neither the checkout nor the release dir itself.
    rmSync(checkoutDir, { recursive: true, force: true });
    const res = spawnSync(process.execPath, [join(releaseDir, 'dist', 'cli', 'index.js'), '--version'], {
      cwd: tmpdir(),
      encoding: 'utf8',
    });
    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe('1.2.3');
  }, SPAWN_HEAVY_TIMEOUT_MS);

  it('AC-3: a broken package.json fails materialization, quarantines the partial dir, and leaves current.json untouched', () => {
    makeFixtureCheckout(checkoutDir, { version: '5.0.0', brokenPackageJson: true });

    // Simulate the shim's current.json living elsewhere, untouched by this module.
    const currentJsonPath = join(root, 'bin', 'current.json');
    mkdirSync(join(root, 'bin'), { recursive: true });
    const currentJsonContent = JSON.stringify({ nodeBin: 'node', entryJs: 'old-entry.js', port: 7777 });
    writeFileSync(currentJsonPath, currentJsonContent, 'utf8');

    expect(() => materializeRelease({ checkoutDir, releasesRoot })).toThrow();

    // current.json is out of this module's scope entirely — must be byte-identical.
    expect(readFileSync(currentJsonPath, 'utf8')).toBe(currentJsonContent);

    // No valid-looking release dir (bare `<version>+<sha>`, no .tmp/.failed
    // suffix) exists anywhere under releasesRoot.
    const entries = existsSync(releasesRoot) ? readdirSync(releasesRoot) : [];
    const validLooking = entries.filter(e => !e.startsWith('.tmp-') && !e.endsWith('.failed'));
    expect(validLooking).toEqual([]);

    // The quarantine path did run: a `.failed`-suffixed dir is left behind
    // for debugging rather than a silently vanished failure.
    const failed = entries.filter(e => e.endsWith('.failed'));
    expect(failed.length).toBe(1);
  }, SPAWN_HEAVY_TIMEOUT_MS);

  it('AC-3: a forced boot-verify mismatch also fails and quarantines, without a valid final dir', () => {
    // Entry script reports the WRONG version on --version, forcing the
    // boot-verify gate itself to reject the build.
    makeFixtureCheckout(checkoutDir, {
      version: '2.0.0',
      versionScript: `#!/usr/bin/env node
console.log('0.0.1-wrong');
process.exit(0);
`,
    });

    expect(() => materializeRelease({ checkoutDir, releasesRoot })).toThrow(/boot-verify failed/);

    const entries = existsSync(releasesRoot) ? readdirSync(releasesRoot) : [];
    const validLooking = entries.filter(e => !e.startsWith('.tmp-') && !e.endsWith('.failed'));
    expect(validLooking).toEqual([]);
    expect(entries.some(e => e.endsWith('.failed'))).toBe(true);
  }, SPAWN_HEAVY_TIMEOUT_MS);

  it('is idempotent: re-materializing the same version+sha reuses the existing verified release', () => {
    makeFixtureCheckout(checkoutDir, { version: '3.3.3' });
    const first = materializeRelease({ checkoutDir, releasesRoot });
    const second = materializeRelease({ checkoutDir, releasesRoot });

    expect(second.releaseDir).toBe(first.releaseDir);
    expect(second.manifest).toEqual(first.manifest);

    // Only one final release dir should exist — no duplicate or stray tmp dirs.
    const entries = readdirSync(releasesRoot);
    const validLooking = entries.filter(e => !e.startsWith('.tmp-') && !e.endsWith('.failed'));
    expect(validLooking).toEqual(['3.3.3+nogit']);
  }, SPAWN_HEAVY_TIMEOUT_MS);

  it('AC-3 (SLICE-417 carry-forward): re-verifies a pre-existing same-id release dir instead of trusting it blindly, and self-heals if it is corrupted', () => {
    makeFixtureCheckout(checkoutDir, { version: '4.4.4' });
    const first = materializeRelease({ checkoutDir, releasesRoot });

    // Corrupt the already-materialized release dir's entry so it reports the
    // WRONG version — simulating a partial deletion / tampering / bit-rot
    // that happened to the on-disk dir since it was first verified.
    writeFileSync(
      join(first.releaseDir, 'dist', 'cli', 'index.js'),
      `#!/usr/bin/env node\nconsole.log('corrupted');\nprocess.exit(0);\n`,
      'utf8',
    );

    // Re-materializing the SAME checkout (same version+sha → same manifest
    // id) must not blindly reuse the now-broken existing dir. It should
    // detect the re-verify failure and self-heal by promoting a freshly
    // rebuilt + freshly boot-verified release into that same directory.
    const second = materializeRelease({ checkoutDir, releasesRoot });

    expect(second.releaseDir).toBe(first.releaseDir);
    // Same id (version+sha), but a genuinely NEW manifest — proof the
    // self-heal actually rebuilt rather than reusing the corrupted dir's
    // stale release.json.
    expect(second.manifest.id).toBe(first.manifest.id);
    expect(second.manifest.pkgversion).toBe(first.manifest.pkgversion);
    expect(second.manifest.createdAt).not.toBe(first.manifest.createdAt);

    // The self-healed dir's entry now reports the correct version again —
    // proof the corrupted entry was actually replaced, not left in place.
    const res = spawnSync(process.execPath, [join(second.releaseDir, 'dist', 'cli', 'index.js'), '--version'], {
      encoding: 'utf8',
    });
    expect(res.stdout.trim()).toBe('4.4.4');

    // Still exactly one valid-looking release dir — no stray tmp/failed left.
    const entries = readdirSync(releasesRoot);
    const validLooking = entries.filter(e => !e.startsWith('.tmp-') && !e.endsWith('.failed'));
    expect(validLooking).toEqual(['4.4.4+nogit']);
  }, SPAWN_HEAVY_TIMEOUT_MS);
});
