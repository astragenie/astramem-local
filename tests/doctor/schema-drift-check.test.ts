/**
 * tests/doctor/schema-drift-check.test.ts
 *
 * FEAT-439 AC-2/AC-5: doctor's "Schema drift" check compares the served
 * release's SCHEMA_VERSION against the live DB's migration counter
 * (MAX(version) FROM schema_version — the same table migrate.ts's own
 * boot-time drift guard reads, src/storage/migrate.ts:100) and FAILs with a
 * copy-pasteable fix command on mismatch (AC-2), staying GREEN with no side
 * effects when they match, even across repeated runs (AC-5).
 *
 * Uses `dataDir` + the existing `servicePointerPath`/`releasesRoot`
 * DoctorCheckOpts test seams (same ones "Service pointer" already uses) so
 * this never touches the real %LOCALAPPDATA%\Astramem paths.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getChecks } from '../../src/doctor/checks.js';
import { SCHEMA_VERSION } from '../../src/server/lib/wire-meta.js';

function findCheck(checks: ReturnType<typeof getChecks>, name: string) {
  const c = checks.find(c => c.name === name);
  if (!c) throw new Error(`check not found: ${name}`);
  return c;
}

/** Minimal DB with just the schema_version table this check reads —
 *  avoids paying for a full migrate() run in every test. */
async function makeDbWithSchemaVersion(dbPath: string, version: number | null): Promise<void> {
  const { default: Database } = await import('better-sqlite3-multiple-ciphers');
  const db = new Database(dbPath);
  if (version !== null) {
    db.exec(`CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)`);
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(version, Date.now());
  }
  db.close();
}

describe('doctor "Schema drift" check (FEAT-439 AC-2/AC-5)', () => {
  let dir: string;
  let dataDir: string;
  let pointerPath: string;
  let releasesRoot: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'astra-doctor-schemadrift-'));
    dataDir = join(dir, 'data');
    mkdirSync(dataDir, { recursive: true });
    pointerPath = join(dir, 'current.json');
    releasesRoot = join(dir, 'releases');
    mkdirSync(releasesRoot, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function checkFor() {
    return findCheck(
      getChecks({ dataDir, servicePointerPath: pointerPath, releasesRoot, encryptionEnabled: false }),
      'Schema drift',
    );
  }

  it('ok: no DB yet — nothing to compare', async () => {
    const res = await checkFor().run();
    expect(res.ok).toBe(true);
    expect(res.message).toContain('no DB yet');
  });

  it('ok: DB exists but has no schema_version table yet (unmigrated)', async () => {
    await makeDbWithSchemaVersion(join(dataDir, 'memory.sqlite'), null);
    const res = await checkFor().run();
    expect(res.ok).toBe(true);
    expect(res.message).toContain('not migrated yet');
  });

  it('ok (repo-working-tree fallback): no pointer installed yet, DB matches this process\'s own SCHEMA_VERSION — GREEN, and re-running stays GREEN (AC-5)', async () => {
    await makeDbWithSchemaVersion(join(dataDir, 'memory.sqlite'), SCHEMA_VERSION);
    const check = checkFor();
    const res1 = await check.run();
    expect(res1.ok).toBe(true);
    expect(res1.message).toContain('repo working tree');
    expect(res1.message).toContain(`SCHEMA_VERSION=${SCHEMA_VERSION}`);

    // Re-run immediately — read-only, no side effects, still GREEN.
    const res2 = await check.run();
    expect(res2.ok).toBe(true);
  });

  it('RED (repo-working-tree fallback): DB migration counter behind the running process\'s SCHEMA_VERSION', async () => {
    await makeDbWithSchemaVersion(join(dataDir, 'memory.sqlite'), SCHEMA_VERSION - 1);
    const res = await checkFor().run();
    expect(res.ok).toBe(false);
    expect(res.message).toContain(`SCHEMA_VERSION=${SCHEMA_VERSION}`);
    expect(res.message).toContain(`migration counter=${SCHEMA_VERSION - 1}`);
    expect(res.fix).toContain('reinstall');
  });

  it('ok: release-pinned pointer whose release SCHEMA_VERSION matches the live DB', async () => {
    // Fixture release exposes a compiled wire-meta.js with a known SCHEMA_VERSION.
    const releaseId = '1.2.3+abcdef';
    const releaseDir = join(releasesRoot, releaseId);
    mkdirSync(join(releaseDir, 'dist', 'cli'), { recursive: true });
    mkdirSync(join(releaseDir, 'dist', 'server', 'lib'), { recursive: true });
    writeFileSync(join(releaseDir, 'dist', 'cli', 'index.js'), '// fixture entry\n', 'utf8');
    writeFileSync(join(releaseDir, 'dist', 'server', 'lib', 'wire-meta.js'), 'export const SCHEMA_VERSION = 99;\n', 'utf8');
    const entryJs = join(releaseDir, 'dist', 'cli', 'index.js');
    writeFileSync(pointerPath, JSON.stringify({ nodeBin: 'node', entryJs, port: 7777 }), 'utf8');

    await makeDbWithSchemaVersion(join(dataDir, 'memory.sqlite'), 99);

    const res = await checkFor().run();
    expect(res.ok).toBe(true);
    expect(res.message).toContain(`release ${releaseId}`);
    expect(res.message).toContain('SCHEMA_VERSION=99');
  });

  it('RED: release-pinned pointer whose release SCHEMA_VERSION diverges from the live DB (2026-07-07 incident class)', async () => {
    const releaseId = '1.2.4+ffffff';
    const releaseDir = join(releasesRoot, releaseId);
    mkdirSync(join(releaseDir, 'dist', 'cli'), { recursive: true });
    mkdirSync(join(releaseDir, 'dist', 'server', 'lib'), { recursive: true });
    writeFileSync(join(releaseDir, 'dist', 'cli', 'index.js'), '// fixture entry\n', 'utf8');
    writeFileSync(join(releaseDir, 'dist', 'server', 'lib', 'wire-meta.js'), 'export const SCHEMA_VERSION = 21;\n', 'utf8');
    const entryJs = join(releaseDir, 'dist', 'cli', 'index.js');
    writeFileSync(pointerPath, JSON.stringify({ nodeBin: 'node', entryJs, port: 7777 }), 'utf8');

    // Live DB is AHEAD of the served release — exactly the stale-dist shape.
    await makeDbWithSchemaVersion(join(dataDir, 'memory.sqlite'), 22);

    const res = await checkFor().run();
    expect(res.ok).toBe(false);
    expect(res.message).toContain(`release ${releaseId}`);
    expect(res.message).toContain('SCHEMA_VERSION=21');
    expect(res.message).toContain('migration counter=22');
    expect(res.fix).toBe('astramem-local reinstall');
  });

  it('falls back to repo-working-tree when devPinned is true, even if entryJs would otherwise resolve', async () => {
    const releaseId = '9.9.9+wouldresolve';
    const releaseDir = join(releasesRoot, releaseId);
    mkdirSync(join(releaseDir, 'dist', 'cli'), { recursive: true });
    mkdirSync(join(releaseDir, 'dist', 'server', 'lib'), { recursive: true });
    writeFileSync(join(releaseDir, 'dist', 'cli', 'index.js'), '// fixture entry\n', 'utf8');
    writeFileSync(join(releaseDir, 'dist', 'server', 'lib', 'wire-meta.js'), 'export const SCHEMA_VERSION = 5;\n', 'utf8');
    const entryJs = join(releaseDir, 'dist', 'cli', 'index.js');
    writeFileSync(pointerPath, JSON.stringify({ nodeBin: 'node', entryJs, port: 7777, devPinned: true }), 'utf8');

    await makeDbWithSchemaVersion(join(dataDir, 'memory.sqlite'), SCHEMA_VERSION);

    const res = await checkFor().run();
    expect(res.ok).toBe(true);
    expect(res.message).toContain('repo working tree');
  });
});
