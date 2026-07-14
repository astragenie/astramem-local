/**
 * tests/doctor/handler-run-log-check.test.ts
 *
 * FEAT-495 item 4a: the "Pipeline handler run-log" doctor row surfaces
 * per-handler last-run status from handler_runs (migration 046) — see
 * src/storage/handler-run-log.ts and src/pipeline/worker.ts's wiring.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getChecks } from '../../src/doctor/checks.js';
import { openDb } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { recordHandlerRun } from '../../src/storage/handler-run-log.js';

function findCheck(checks: ReturnType<typeof getChecks>, name: string) {
  const c = checks.find(c => c.name === name);
  if (!c) throw new Error(`check not found: ${name}`);
  return c;
}

describe('doctor "Pipeline handler run-log" check (FEAT-495)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'astra-doctor-handler-run-log-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function checkFor() {
    return findCheck(getChecks({ dataDir: dir, encryptionEnabled: false }), 'Pipeline handler run-log');
  }

  it('no DB yet — ok:true, informational', async () => {
    const result = await checkFor().run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('no DB yet');
  });

  it('DB exists, no handler runs recorded yet — ok:true', async () => {
    const db = openDb(join(dir, 'memory.sqlite'));
    migrate(db);
    db.close();

    const result = await checkFor().run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('no handler runs recorded yet');
  });

  it('all recorded handlers succeeded — ok:true, names never-invoked known handlers', async () => {
    const db = openDb(join(dir, 'memory.sqlite'));
    migrate(db);
    recordHandlerRun(db, { handler: 'cleanup', status: 'success', durationMs: 12 });
    db.close();

    const result = await checkFor().run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('cleanup: success');
    expect(result.message).toContain('never invoked');
    expect(result.message).toContain('reembed');
  });

  it('a handler whose most recent run failed — ok:false, names it', async () => {
    const db = openDb(join(dir, 'memory.sqlite'));
    migrate(db);
    recordHandlerRun(db, { handler: 'distill', status: 'success', durationMs: 10 }, 1000);
    recordHandlerRun(db, { handler: 'distill', status: 'failed', durationMs: 20, errorType: 'deterministic', errorMessage: 'bad json' }, 2000);
    db.close();

    const result = await checkFor().run();
    expect(result.ok).toBe(false);
    expect(result.message).toContain('distill');
    expect(result.message).toContain('deterministic');
    expect(result.fix).toBeDefined();
  });

  it('DB file exists but has not been migrated — inconclusive, not a clean bill of health', async () => {
    openDb(join(dir, 'memory.sqlite')).close();
    const result = await checkFor().run();
    expect(result.ok).toBe(true);
    expect(result.inconclusive).toBe(true);
    expect(result.message).toContain('check error (non-fatal)');
  });
});
