/**
 * Unit tests for deriveSchemaVersion (B4, docs/specs/20260713-stability-
 * wave-plan.md). These exercise the pure algorithm against SYNTHETIC
 * fixture directories with a known, arbitrary set of filenames — the point
 * is to prove the derivation logic is correct without pinning the current
 * real migrations/ directory's count (that cross-check already lives in
 * tests/storage/migration-renumber.test.ts's "SCHEMA_VERSION equals the
 * highest migration number" test, which computes its own independent max
 * and compares against the derived SCHEMA_VERSION — neither file hardcodes
 * today's number).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveSchemaVersion } from '../../src/storage/schema-version.js';

const tempDirs: string[] = [];

function fixtureDir(filenames: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'astra-schema-version-'));
  tempDirs.push(dir);
  for (const f of filenames) {
    writeFileSync(join(dir, f), '-- test fixture\n');
  }
  return dir;
}

afterEach(() => {
  while (tempDirs.length) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('deriveSchemaVersion', () => {
  it('returns the highest NNN- prefix among a synthetic set of migration files', () => {
    const dir = fixtureDir(['001-a.sql', '002-b.sql', '005-c.sql']);
    expect(deriveSchemaVersion(dir)).toBe(5);
  });

  it('is unaffected by file listing order', () => {
    const dir = fixtureDir(['009-z.sql', '001-a.sql', '004-m.sql']);
    expect(deriveSchemaVersion(dir)).toBe(9);
  });

  it('ignores non-.sql files in the same directory', () => {
    const dir = fixtureDir(['001-a.sql', '002-b.sql', 'README.md', 'manifest.json']);
    expect(deriveSchemaVersion(dir)).toBe(2);
  });

  it('ignores .sql files with no parseable NNN- prefix', () => {
    const dir = fixtureDir(['001-a.sql', 'not-numbered.sql', '003-c.sql']);
    expect(deriveSchemaVersion(dir)).toBe(3);
  });

  it('throws — not 0 or undefined — for a directory with no parseable migration files (ADR-015: never let "nothing" look like a valid version)', () => {
    const dir = fixtureDir(['README.md']);
    expect(() => deriveSchemaVersion(dir)).toThrow(/no parseable/);
  });

  it('throws for an empty directory', () => {
    const dir = fixtureDir([]);
    expect(() => deriveSchemaVersion(dir)).toThrow(/no parseable/);
  });

  it('a duplicate version number does not affect the max — that is migrate()\'s job to reject, not this function\'s', () => {
    const dir = fixtureDir(['001-a.sql', '003-b.sql', '003-collides.sql']);
    expect(deriveSchemaVersion(dir)).toBe(3);
  });
});
