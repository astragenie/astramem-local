/**
 * Tests for migrateLegacyDirsIfPresent().
 *
 * Strategy: use vi.doMock (non-hoisted) + vi.resetModules() before each test
 * so we can control the platform() and the datadir paths independently per test.
 *
 * We stub the datadir module so migration uses fresh tmp dirs instead of the
 * real APPDATA — tests are fully hermetic.
 *
 * Five cases:
 * 1. Only legacy exists → rename to canonical, canonical is now populated.
 * 2. Only canonical exists → no-op.
 * 3. Both exist → no-op + warning emitted to stderr.
 * 4. Neither exists → no-op, no errors.
 * 5. Non-Windows (Linux) → immediate no-op (platform guard).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

function makeTmpDir(): string {
  const d = join(tmpdir(), `migrate-test-${randomUUID()}`);
  mkdirSync(d, { recursive: true });
  return d;
}

function makeTmpPath(): string {
  return join(tmpdir(), `migrate-test-${randomUUID()}`);
}

/** Stub the os + datadir modules and import migrate-dirs fresh. */
async function importMigration(opts: {
  platName: string;
  legacyConfig: string;
  canonicalConfig: string;
  legacyData: string;
  canonicalData: string;
}) {
  vi.doMock('node:os', async () => {
    const actual = await vi.importActual<typeof import('node:os')>('node:os');
    return { ...actual, platform: () => opts.platName };
  });
  vi.doMock('../../src/config/datadir.js', () => ({
    defaultConfigDir: () => opts.canonicalConfig,
    defaultDataDir: () => opts.canonicalData,
    legacyConfigDir: () => opts.legacyConfig,
    legacyDataDir: () => opts.legacyData,
  }));
  const mod = await import('../../src/config/migrate-dirs.js');
  return mod.migrateLegacyDirsIfPresent;
}

describe('migrateLegacyDirsIfPresent — Windows', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('case 1: only legacy exists → renames legacy config+data to canonical', async () => {
    const legacyConfig = makeTmpDir();
    const canonicalConfig = makeTmpPath(); // must not exist yet

    const legacyData = makeTmpDir();
    const canonicalData = makeTmpPath(); // must not exist yet

    // Write sentinel files to confirm contents move.
    writeFileSync(join(legacyConfig, 'secrets.env'), 'MEMORY_BEARER=testbearer\n');
    writeFileSync(join(legacyData, 'memory.sqlite'), 'sentinel-db\n');

    const migrateLegacyDirsIfPresent = await importMigration({
      platName: 'win32',
      legacyConfig,
      canonicalConfig,
      legacyData,
      canonicalData,
    });

    const result = migrateLegacyDirsIfPresent();

    expect(result.configMigrated).toBe(true);
    expect(result.dataMigrated).toBe(true);
    expect(result.warnings).toHaveLength(0);

    // Legacy dirs are gone.
    expect(existsSync(legacyConfig)).toBe(false);
    expect(existsSync(legacyData)).toBe(false);

    // Canonical dirs now contain the migrated files.
    expect(existsSync(canonicalConfig)).toBe(true);
    expect(existsSync(join(canonicalConfig, 'secrets.env'))).toBe(true);
    expect(existsSync(canonicalData)).toBe(true);
    expect(existsSync(join(canonicalData, 'memory.sqlite'))).toBe(true);

    // Cleanup
    rmSync(canonicalConfig, { recursive: true, force: true });
    rmSync(canonicalData, { recursive: true, force: true });
  });

  it('case 2: only canonical exists → no-op, nothing moved', async () => {
    const legacyConfig = makeTmpPath();   // does not exist
    const canonicalConfig = makeTmpDir(); // already there

    const legacyData = makeTmpPath();
    const canonicalData = makeTmpDir();

    writeFileSync(join(canonicalConfig, 'secrets.env'), 'MEMORY_BEARER=existingbearer\n');

    const migrateLegacyDirsIfPresent = await importMigration({
      platName: 'win32',
      legacyConfig,
      canonicalConfig,
      legacyData,
      canonicalData,
    });

    const result = migrateLegacyDirsIfPresent();

    expect(result.configMigrated).toBe(false);
    expect(result.dataMigrated).toBe(false);
    expect(result.warnings).toHaveLength(0);

    // Canonical still there with original content.
    expect(existsSync(canonicalConfig)).toBe(true);
    expect(existsSync(join(canonicalConfig, 'secrets.env'))).toBe(true);

    // Cleanup
    rmSync(canonicalConfig, { recursive: true, force: true });
    rmSync(canonicalData, { recursive: true, force: true });
  });

  it('case 3: both exist → no-op + warning printed, neither dir removed', async () => {
    const legacyConfig = makeTmpDir();
    const canonicalConfig = makeTmpDir();

    const legacyData = makeTmpDir();
    const canonicalData = makeTmpDir();

    writeFileSync(join(legacyConfig, 'secrets.env'), 'MEMORY_BEARER=legacybearer\n');
    writeFileSync(join(canonicalConfig, 'secrets.env'), 'MEMORY_BEARER=canonicalbearer\n');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const migrateLegacyDirsIfPresent = await importMigration({
      platName: 'win32',
      legacyConfig,
      canonicalConfig,
      legacyData,
      canonicalData,
    });

    const result = migrateLegacyDirsIfPresent();

    expect(result.configMigrated).toBe(false);
    expect(result.dataMigrated).toBe(false);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain('Two');

    // Both dirs survive.
    expect(existsSync(legacyConfig)).toBe(true);
    expect(existsSync(canonicalConfig)).toBe(true);

    // Warning was printed to console.
    expect(warnSpy).toHaveBeenCalled();

    // Cleanup
    rmSync(legacyConfig, { recursive: true, force: true });
    rmSync(canonicalConfig, { recursive: true, force: true });
    rmSync(legacyData, { recursive: true, force: true });
    rmSync(canonicalData, { recursive: true, force: true });
  });

  it('case 4: neither exists → no-op, no errors', async () => {
    const legacyConfig = makeTmpPath();
    const canonicalConfig = makeTmpPath();
    const legacyData = makeTmpPath();
    const canonicalData = makeTmpPath();

    const migrateLegacyDirsIfPresent = await importMigration({
      platName: 'win32',
      legacyConfig,
      canonicalConfig,
      legacyData,
      canonicalData,
    });

    const result = migrateLegacyDirsIfPresent();

    expect(result.configMigrated).toBe(false);
    expect(result.dataMigrated).toBe(false);
    expect(result.warnings).toHaveLength(0);
  });
});

describe('migrateLegacyDirsIfPresent — non-Windows', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns immediately with no migration on Linux', async () => {
    const migrateLegacyDirsIfPresent = await importMigration({
      platName: 'linux',
      legacyConfig: makeTmpPath(),
      canonicalConfig: makeTmpPath(),
      legacyData: makeTmpPath(),
      canonicalData: makeTmpPath(),
    });

    const result = migrateLegacyDirsIfPresent();

    expect(result.configMigrated).toBe(false);
    expect(result.dataMigrated).toBe(false);
    expect(result.warnings).toHaveLength(0);
  });
});
