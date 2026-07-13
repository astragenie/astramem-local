/**
 * tests/doctor/memory-health-check.test.ts
 *
 * FEAT-444 AC-1: doctor's "Memory health" row. Uses `getChecks({ dataDir,
 * encryptionEnabled: false })` + a real on-disk memory.sqlite (same pattern
 * as tests/doctor/service-pointer-check.test.ts's `getChecks(...)` +
 * `findCheck` helper) rather than an in-memory DB, since the check opens
 * `join(dataDir, 'memory.sqlite')` via openProductionDbReadonly — exactly
 * what a real doctor invocation does.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getChecks } from '../../src/doctor/checks.js';
import { openDb } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { MemoryRepo } from '../../src/storage/memories.js';
import { JobRepo } from '../../src/pipeline/job-repo.js';

function findCheck(checks: ReturnType<typeof getChecks>, name: string) {
  const c = checks.find(c => c.name === name);
  if (!c) throw new Error(`check not found: ${name}`);
  return c;
}

describe('doctor "Memory health" check (FEAT-444 AC-1)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'astra-doctor-memhealth-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function checkFor() {
    return findCheck(getChecks({ dataDir: dir, encryptionEnabled: false }), 'Memory health');
  }

  // Silent-error audit (2026-07-13): a query error inside this check used to
  // return ok:true indistinguishably from a genuinely healthy result.
  it('DB file exists but has not been migrated (query hits a missing table) — inconclusive, not a clean bill of health', async () => {
    // A valid-but-unmigrated DB (rather than a corrupt file) triggers the
    // same "the query itself failed" catch without a Windows file-handle
    // quirk on opening a non-SQLite file.
    openDb(join(dir, 'memory.sqlite')).close();
    const result = await checkFor().run();
    expect(result.ok).toBe(true);
    expect(result.inconclusive).toBe(true);
    expect(result.message).toContain('check error (non-fatal)');
  });

  it('no DB file yet — clean "no data yet" state, ok:true (AC-4)', async () => {
    const result = await checkFor().run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('no DB yet');
  });

  it('DB exists but zero active memories — clean "no data yet" state (AC-4)', async () => {
    const dbPath = join(dir, 'memory.sqlite');
    const db = openDb(dbPath);
    migrate(db);
    db.close();

    const result = await checkFor().run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('no data yet');
  });

  it('populated store — reports active/archived counts, coverage, correction rate, staleness (AC-1)', async () => {
    const dbPath = join(dir, 'memory.sqlite');
    const db = openDb(dbPath);
    migrate(db);
    const repo = new MemoryRepo(db);
    repo.insert({
      type: 'fact', text: 'a fact worth remembering', normalized_text: 'a fact worth remembering',
      repo: 'r1', project: null, branch: null, agent: null, session_id: null,
      hash: randomUUID(), source_hash: null,
    });
    repo.insert({
      type: 'lesson', text: 'a lesson learned the hard way', normalized_text: 'a lesson learned the hard way',
      repo: 'r1', project: null, branch: null, agent: null, session_id: null,
      hash: randomUUID(), source_hash: null,
    });
    db.close();

    const result = await checkFor().run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('2 active');
    expect(result.message).toContain('memory health');
  });

  it('never mutates memories/memory_events/consolidation_proposals (read-only, AC-1)', async () => {
    const dbPath = join(dir, 'memory.sqlite');
    const seedDb = openDb(dbPath);
    migrate(seedDb);
    new MemoryRepo(seedDb).insert({
      type: 'fact', text: 'untouched fact', normalized_text: 'untouched fact',
      repo: 'r1', project: null, branch: null, agent: null, session_id: null,
      hash: randomUUID(), source_hash: null,
    });
    const before = {
      memories: (seedDb.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number }).n,
      events: (seedDb.prepare('SELECT COUNT(*) AS n FROM memory_events').get() as { n: number }).n,
      proposals: (seedDb.prepare('SELECT COUNT(*) AS n FROM consolidation_proposals').get() as { n: number }).n,
    };
    seedDb.close();

    await checkFor().run();

    const verifyDb = openDb(dbPath);
    const after = {
      memories: (verifyDb.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number }).n,
      events: (verifyDb.prepare('SELECT COUNT(*) AS n FROM memory_events').get() as { n: number }).n,
      proposals: (verifyDb.prepare('SELECT COUNT(*) AS n FROM consolidation_proposals').get() as { n: number }).n,
    };
    verifyDb.close();

    expect(after).toEqual(before);
  });

  // A2-lite (ADR-015 rule 6/2): checkMemoryHealth previously had exactly one
  // return path, {ok: true} — a 100% poison rate reported "memory health:
  // OK". These four cases prove the new branch goes red on a genuine
  // failure rate AND stays green both below the volume floor and below the
  // rate floor — the "cries wolf on a fresh/quiet install" failure mode the
  // MEANINGFUL_USAGE_THRESHOLD gate exists to prevent.

  /** Seeds `n` distill jobs, each a distinct session, `poisonCount` of them
   *  permanently poisoned and the rest completed. */
  function seedDistillSessions(db: ReturnType<typeof openDb>, n: number, poisonCount: number): void {
    const repo = new JobRepo(db);
    for (let i = 0; i < n; i++) {
      const id = repo.enqueue('distill', { session_id: `s${i}` });
      if (i < poisonCount) repo.markPoison(id);
      else repo.complete(id);
    }
  }

  it('high poison rate with enough volume — RED (ok:false), states the K-of-N denominator', async () => {
    const dbPath = join(dir, 'memory.sqlite');
    const db = openDb(dbPath);
    migrate(db);
    // 20 terminal sessions (== MEANINGFUL_USAGE_THRESHOLD), 6 poisoned = 30%,
    // above the 25% POISON_RATE_ALARM floor.
    seedDistillSessions(db, 20, 6);
    db.close();

    const result = await checkFor().run();
    expect(result.ok).toBe(false);
    expect(result.message).toContain('6 of 20 terminal distill sessions');
    expect(result.message).toContain('30.0%');
  });

  it('same 100% poison rate but below the volume floor — stays GREEN (no cry-wolf on a quiet install)', async () => {
    const dbPath = join(dir, 'memory.sqlite');
    const db = openDb(dbPath);
    migrate(db);
    // Only 3 terminal sessions, all poisoned — below MEANINGFUL_USAGE_THRESHOLD
    // (20), so there isn't enough volume yet for a rate to mean anything.
    seedDistillSessions(db, 3, 3);
    db.close();

    const result = await checkFor().run();
    expect(result.ok).toBe(true);
  });

  it('plenty of volume but a low poison rate — stays GREEN (occasional failures are normal noise)', async () => {
    const dbPath = join(dir, 'memory.sqlite');
    const db = openDb(dbPath);
    migrate(db);
    // 25 terminal sessions, 2 poisoned = 8%, below the 25% alarm floor.
    seedDistillSessions(db, 25, 2);
    db.close();

    const result = await checkFor().run();
    expect(result.ok).toBe(true);
  });

  it('genuinely quiet/empty install (0 distill activity at all) — stays GREEN', async () => {
    const dbPath = join(dir, 'memory.sqlite');
    const db = openDb(dbPath);
    migrate(db);
    db.close();

    const result = await checkFor().run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('no data yet');
  });
});
