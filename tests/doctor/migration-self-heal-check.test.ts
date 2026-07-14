/**
 * tests/doctor/migration-self-heal-check.test.ts
 *
 * FEAT-495 item 1: the "Migration self-heal" doctor row surfaces past
 * self-heal actions from migration_self_heal_log (migration 045) — see
 * src/storage/migration-self-heal.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getChecks } from '../../src/doctor/checks.js';
import { openDb } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { recordSelfHealActions } from '../../src/storage/migration-self-heal.js';

function findCheck(checks: ReturnType<typeof getChecks>, name: string) {
  const c = checks.find(c => c.name === name);
  if (!c) throw new Error(`check not found: ${name}`);
  return c;
}

describe('doctor "Migration self-heal" check (FEAT-495)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'astra-doctor-migration-self-heal-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function checkFor() {
    return findCheck(getChecks({ dataDir: dir, encryptionEnabled: false }), 'Migration self-heal');
  }

  it('no DB yet — ok:true, informational', async () => {
    const result = await checkFor().run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('no DB yet');
  });

  it('DB exists, self-heal never fired — ok:true, "clean"', async () => {
    const db = openDb(join(dir, 'memory.sqlite'));
    migrate(db);
    db.close();

    const result = await checkFor().run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('clean');
  });

  it('a recent self-heal action — ok:true, message names the healed column and flags it as fresh', async () => {
    const db = openDb(join(dir, 'memory.sqlite'));
    migrate(db);
    recordSelfHealActions(db, [{ migrationFile: '004-provenance.sql', table: 'memories', column: 'evidence' }]);
    db.close();

    const result = await checkFor().run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('memories.evidence');
    expect(result.message).toContain('worth investigating');
  });

  it('an old self-heal action (>24h ago) — ok:true, message reports history without the fresh-anomaly wording', async () => {
    const db = openDb(join(dir, 'memory.sqlite'));
    migrate(db);
    const twoDaysAgo = Date.now() - 48 * 60 * 60 * 1000;
    recordSelfHealActions(db, [{ migrationFile: '004-provenance.sql', table: 'memories', column: 'evidence' }], twoDaysAgo);
    db.close();

    const result = await checkFor().run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('healed historically');
    expect(result.message).not.toContain('worth investigating');
  });

  it('DB file exists but has not been migrated — inconclusive, not a clean bill of health', async () => {
    openDb(join(dir, 'memory.sqlite')).close();
    const result = await checkFor().run();
    expect(result.ok).toBe(true);
    expect(result.inconclusive).toBe(true);
    expect(result.message).toContain('check error (non-fatal)');
  });
});
