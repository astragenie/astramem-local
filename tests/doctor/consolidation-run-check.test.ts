/**
 * tests/doctor/consolidation-run-check.test.ts
 *
 * P2.1 stabilization: the "Consolidation group coverage" doctor row. Closes
 * the reviewer MEDIUM finding (20260715T1640Z
 * review-stabilization-plan-architect-reviewer.md) — `groupsSkipped` used
 * to be computed by `runConsolidation` and read nowhere. Same pattern as
 * tests/doctor/consolidation-judge-check.test.ts (real on-disk
 * memory.sqlite, since the check opens `join(dataDir, 'memory.sqlite')`
 * via openProductionDbReadonly).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getChecks } from '../../src/doctor/checks.js';
import { openDb } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { recordConsolidationRun } from '../../src/storage/consolidation-run-log.js';

function findCheck(checks: ReturnType<typeof getChecks>, name: string) {
  const c = checks.find(c => c.name === name);
  if (!c) throw new Error(`check not found: ${name}`);
  return c;
}

describe('doctor "Consolidation group coverage" check (P2.1)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'astra-doctor-consolidation-run-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function checkFor() {
    return findCheck(
      getChecks({ dataDir: dir, encryptionEnabled: false }),
      'Consolidation group coverage',
    );
  }

  it('no DB yet — ok:true, informational', async () => {
    const result = await checkFor().run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('no DB yet');
  });

  it('DB exists, consolidation never run — ok:true, "never run"', async () => {
    const db = openDb(join(dir, 'memory.sqlite'));
    migrate(db);
    db.close();

    const result = await checkFor().run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('never run');
  });

  it('a recorded run with zero groups skipped — ok:true, reports scanned count', async () => {
    const db = openDb(join(dir, 'memory.sqlite'));
    migrate(db);
    recordConsolidationRun(db, {
      candidateSelection: 'full', groupsScanned: 12, groupsSkippedCount: 0,
      groupsSkippedAtoms: 0, mergedCount: 3, proposedCount: 5,
    });
    db.close();

    const result = await checkFor().run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('candidateSelection=full');
    expect(result.message).toContain('12 group(s) scanned, 0 skipped');
  });

  it('a recorded run that skipped groups — ok:false, names the count and a fix', async () => {
    const db = openDb(join(dir, 'memory.sqlite'));
    migrate(db);
    recordConsolidationRun(db, {
      candidateSelection: 'full', groupsScanned: 8, groupsSkippedCount: 2,
      groupsSkippedAtoms: 1_340, mergedCount: 0, proposedCount: 0,
    });
    db.close();

    const result = await checkFor().run();
    expect(result.ok).toBe(false);
    expect(result.message).toContain('skipped 2 group(s)');
    expect(result.message).toContain('1340 atoms');
    expect(result.fix).toBeDefined();
    expect(result.fix).toContain("'knn'");
  });

  it("'knn' mode never skips — a recorded knn run reports 0 skipped even for a huge scan", async () => {
    const db = openDb(join(dir, 'memory.sqlite'));
    migrate(db);
    recordConsolidationRun(db, {
      candidateSelection: 'knn', groupsScanned: 40, groupsSkippedCount: 0,
      groupsSkippedAtoms: 0, mergedCount: 10, proposedCount: 20,
    });
    db.close();

    const result = await checkFor().run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('candidateSelection=knn');
  });

  it('multiple recorded runs — reports the MOST RECENT one, not the first', async () => {
    const db = openDb(join(dir, 'memory.sqlite'));
    migrate(db);
    recordConsolidationRun(db, {
      candidateSelection: 'full', groupsScanned: 1, groupsSkippedCount: 1,
      groupsSkippedAtoms: 501, mergedCount: 0, proposedCount: 0,
    });
    recordConsolidationRun(db, {
      candidateSelection: 'knn', groupsScanned: 5, groupsSkippedCount: 0,
      groupsSkippedAtoms: 0, mergedCount: 2, proposedCount: 1,
    });
    db.close();

    const result = await checkFor().run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('candidateSelection=knn');
  });

  it('DB file exists but has not been migrated (query hits a missing table) — inconclusive', async () => {
    openDb(join(dir, 'memory.sqlite')).close();
    const result = await checkFor().run();
    expect(result.ok).toBe(true);
    expect(result.inconclusive).toBe(true);
    expect(result.message).toContain('check error (non-fatal)');
  });
});
