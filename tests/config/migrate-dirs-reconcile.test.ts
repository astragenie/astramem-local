import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';

// The module under test resolves dirs from datadir.ts — stub those to point
// at a temp sandbox so the matrix is hermetic.
const sandbox = { legacy: '', canonical: '', legacyCfg: '', canonicalCfg: '' };

vi.mock('../../src/config/datadir.js', () => ({
  defaultDataDir: () => sandbox.canonical,
  legacyDataDir: () => sandbox.legacy,
  defaultConfigDir: () => sandbox.canonicalCfg,
  legacyConfigDir: () => sandbox.legacyCfg,
}));

const { migrateLegacyDirsIfPresent } = await import('../../src/config/migrate-dirs.js');

const isWin = platform() === 'win32';

describe.skipIf(!isWin)('migrate-dirs both-exist reconciliation (Windows)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'astra-dirs-'));
    sandbox.legacy = join(root, 'AstraMemory');
    sandbox.canonical = join(root, 'Astramem');
    sandbox.legacyCfg = join(root, 'cfg-AstraMemory');
    sandbox.canonicalCfg = join(root, 'cfg-Astramem');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('legacy-only → renames whole dir (original behavior)', () => {
    mkdirSync(sandbox.legacy, { recursive: true });
    writeFileSync(join(sandbox.legacy, 'memory.sqlite'), 'DB');
    const r = migrateLegacyDirsIfPresent();
    expect(r.dataMigrated).toBe(true);
    expect(existsSync(join(sandbox.canonical, 'memory.sqlite'))).toBe(true);
    expect(existsSync(sandbox.legacy)).toBe(false);
  });

  it('both exist, canonical lacks the DB → copies sqlite+wal from legacy (stranded-data rescue)', () => {
    mkdirSync(sandbox.legacy, { recursive: true });
    mkdirSync(sandbox.canonical, { recursive: true });
    writeFileSync(join(sandbox.legacy, 'memory.sqlite'), 'REAL-DATA');
    writeFileSync(join(sandbox.legacy, 'memory.sqlite-wal'), 'WAL');
    const r = migrateLegacyDirsIfPresent();
    expect(r.dataMigrated).toBe(true);
    expect(readFileSync(join(sandbox.canonical, 'memory.sqlite'), 'utf8')).toBe('REAL-DATA');
    expect(readFileSync(join(sandbox.canonical, 'memory.sqlite-wal'), 'utf8')).toBe('WAL');
    // copy, not move — legacy untouched
    expect(existsSync(join(sandbox.legacy, 'memory.sqlite'))).toBe(true);
  });

  it('both exist, both have DBs → copies nothing, warns loudly', () => {
    mkdirSync(sandbox.legacy, { recursive: true });
    mkdirSync(sandbox.canonical, { recursive: true });
    writeFileSync(join(sandbox.legacy, 'memory.sqlite'), 'LEGACY');
    writeFileSync(join(sandbox.canonical, 'memory.sqlite'), 'CANONICAL');
    const r = migrateLegacyDirsIfPresent();
    expect(readFileSync(join(sandbox.canonical, 'memory.sqlite'), 'utf8')).toBe('CANONICAL'); // never overwritten
    expect(r.warnings.some(w => w.includes('BOTH contain memory.sqlite'))).toBe(true);
  });

  it('both exist, canonical has only a stale WAL → copies nothing (mismatched WAL corrupts)', () => {
    mkdirSync(sandbox.legacy, { recursive: true });
    mkdirSync(sandbox.canonical, { recursive: true });
    writeFileSync(join(sandbox.legacy, 'memory.sqlite'), 'LEGACY');
    writeFileSync(join(sandbox.canonical, 'memory.sqlite-wal'), 'STALE-WAL');
    migrateLegacyDirsIfPresent();
    expect(existsSync(join(sandbox.canonical, 'memory.sqlite'))).toBe(false);
  });

  it('config pair copies per-file without overwriting', () => {
    mkdirSync(sandbox.legacyCfg, { recursive: true });
    mkdirSync(sandbox.canonicalCfg, { recursive: true });
    writeFileSync(join(sandbox.legacyCfg, 'secrets.env'), 'LEGACY-BEARER');
    writeFileSync(join(sandbox.legacyCfg, 'config.yaml'), 'LEGACY-CFG');
    writeFileSync(join(sandbox.canonicalCfg, 'config.yaml'), 'CANON-CFG');
    migrateLegacyDirsIfPresent();
    // missing file copied
    expect(readFileSync(join(sandbox.canonicalCfg, 'secrets.env'), 'utf8')).toBe('LEGACY-BEARER');
    // existing file never overwritten
    expect(readFileSync(join(sandbox.canonicalCfg, 'config.yaml'), 'utf8')).toBe('CANON-CFG');
  });

  it('neither exists → no-op', () => {
    const r = migrateLegacyDirsIfPresent();
    expect(r.warnings).toHaveLength(0);
    expect(r.dataMigrated).toBe(false);
  });
});
