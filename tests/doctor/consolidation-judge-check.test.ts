/**
 * tests/doctor/consolidation-judge-check.test.ts
 *
 * FEAT-482: the "Consolidation judge" doctor row. Neither shipped LLM
 * provider (Ollama, codex-subscription) reports non-zero `usage.usd`, so the
 * contradiction judge's real cost — call count and wall-clock time — can't
 * be bounded by a dollar cap and must instead be made VISIBLE here. See
 * src/consolidate/contradiction-judge.ts's doc comment and migrations/
 * 030-consolidation-judge-runs.sql for the full incident/rationale.
 *
 * Uses a real on-disk memory.sqlite (same pattern as
 * tests/doctor/entity-relations-check.test.ts) since the check opens
 * `join(dataDir, 'memory.sqlite')` via openProductionDbReadonly.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getChecks } from '../../src/doctor/checks.js';
import { openDb } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { recordConsolidationJudgeRun } from '../../src/storage/consolidation-judge-log.js';

function findCheck(checks: ReturnType<typeof getChecks>, name: string) {
  const c = checks.find(c => c.name === name);
  if (!c) throw new Error(`check not found: ${name}`);
  return c;
}

describe('doctor "Consolidation judge" check (FEAT-482)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'astra-doctor-consolidation-judge-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function checkFor() {
    return findCheck(
      getChecks({ dataDir: dir, encryptionEnabled: false }),
      'Consolidation judge',
    );
  }

  it('no DB yet — ok:true, informational', async () => {
    const result = await checkFor().run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('no DB yet');
  });

  it('DB exists, contradiction detection never run — ok:true, "never run"', async () => {
    const db = openDb(join(dir, 'memory.sqlite'));
    migrate(db);
    db.close();

    const result = await checkFor().run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('never run');
  });

  it('a recorded run with neither cap hit — reports mode, call count, elapsed seconds', async () => {
    const db = openDb(join(dir, 'memory.sqlite'));
    migrate(db);
    recordConsolidationJudgeRun(db, {
      mode: 'enabled', judgeCalls: 42, elapsedMs: 12_340, capReached: false, wallClockCapReached: false,
    });
    db.close();

    const result = await checkFor().run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('mode: enabled');
    expect(result.message).toContain('42 judge call(s)');
    expect(result.message).toContain('12.3s elapsed');
    expect(result.message).not.toContain('cap reached');
  });

  it('a recorded run that hit the wall-clock cap — message names it', async () => {
    const db = openDb(join(dir, 'memory.sqlite'));
    migrate(db);
    recordConsolidationJudgeRun(db, {
      mode: 'dry-run', judgeCalls: 5, elapsedMs: 300_000, capReached: false, wallClockCapReached: true,
    });
    db.close();

    const result = await checkFor().run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('wall-clock cap (maxWallClockMs) reached');
  });

  it('a recorded run that hit the call-count cap — message names it', async () => {
    const db = openDb(join(dir, 'memory.sqlite'));
    migrate(db);
    recordConsolidationJudgeRun(db, {
      mode: 'enabled', judgeCalls: 200, elapsedMs: 8_000, capReached: true, wallClockCapReached: false,
    });
    db.close();

    const result = await checkFor().run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('call-count cap (maxPerRun) reached');
  });

  it('multiple recorded runs — reports the MOST RECENT one, not the first', async () => {
    const db = openDb(join(dir, 'memory.sqlite'));
    migrate(db);
    recordConsolidationJudgeRun(db, {
      mode: 'dry-run', judgeCalls: 1, elapsedMs: 100, capReached: false, wallClockCapReached: false,
    });
    recordConsolidationJudgeRun(db, {
      mode: 'enabled', judgeCalls: 99, elapsedMs: 5_000, capReached: false, wallClockCapReached: false,
    });
    db.close();

    const result = await checkFor().run();
    expect(result.message).toContain('mode: enabled');
    expect(result.message).toContain('99 judge call(s)');
  });
});
