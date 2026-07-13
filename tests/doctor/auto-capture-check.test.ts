/**
 * tests/doctor/auto-capture-check.test.ts
 *
 * FEAT-455 / ADR-012 decision 4: doctor's "Auto-capture" row. Being ON is
 * never itself a warning (ok:true, see checkAutoCapture's doc comment for
 * why this deliberately does NOT mirror checkServicePointer's ok:false
 * dev-pinned pattern) — but since the 2026-07-12 "wired, never fired" bug
 * class, the check now WARNs (ok:false) when ON + the daemon has real recent
 * content (>= MEANINGFUL_USAGE_THRESHOLD active memories in the trailing 7
 * days) yet 0 of them came through auto-capture.
 *
 * issue #217 (2026-07-13): the ORIGINAL version of this check counted
 * ALL-TIME, so once capture had EVER succeeded even once, the row stayed
 * green forever regardless of whether capture later broke. The tests in the
 * "recency window (#217)" describe block below exist specifically to prove
 * the fix: old capture history must NOT mask a live regression, and a
 * genuinely quiet recent window must NOT false-alarm.
 *
 * Uses a real on-disk memory.sqlite (same pattern as
 * tests/doctor/memory-health-check.test.ts) since the check opens
 * `join(dataDir, 'memory.sqlite')` via openProductionDbReadonly.
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
import { MemoryEventRepo } from '../../src/storage/memory-events.js';
import { SEVEN_DAYS_MS } from '../../src/doctor/checks/shared.js';

function findCheck(checks: ReturnType<typeof getChecks>, name: string) {
  const c = checks.find(c => c.name === name);
  if (!c) throw new Error(`check not found: ${name}`);
  return c;
}

/** Backdate a row's created_at past the check's 7-day window — InsertInput
 *  has no created_at override (it's always wall-clock at insert time), so
 *  tests that need "old" activity update it directly after the fact. */
function backdate(db: ReturnType<typeof openDb>, id: string, msAgo: number): void {
  db.prepare('UPDATE memories SET created_at = ? WHERE id = ?').run(Date.now() - msAgo, id);
}

describe('doctor "Auto-capture" check (FEAT-455 / ADR-012 decision 4)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'astra-doctor-autocapture-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function checkFor(autoCaptureEnabled: boolean) {
    return findCheck(
      getChecks({ dataDir: dir, encryptionEnabled: false, autoCaptureEnabled }),
      'Auto-capture',
    );
  }

  // Silent-error audit (2026-07-13): a query error inside this check used to
  // return ok:true indistinguishably from a genuinely healthy count.
  it('DB file exists but has not been migrated (query hits a missing table) — inconclusive, not a clean bill of health', async () => {
    // A valid-but-unmigrated DB (rather than a corrupt file) triggers the
    // same "the query itself failed" catch without a Windows file-handle
    // quirk on opening a non-SQLite file.
    openDb(join(dir, 'memory.sqlite')).close();
    const result = await checkFor(true).run();
    expect(result.ok).toBe(true);
    expect(result.inconclusive).toBe(true);
    expect(result.message).toContain('check error (non-fatal)');
  });

  it('defaults to off when autoCaptureEnabled is omitted, and is always ok', async () => {
    const check = findCheck(getChecks({ dataDir: dir, encryptionEnabled: false }), 'Auto-capture');
    const result = await check.run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('off');
    expect(result.message).toContain('default');
  });

  it('reports off verbatim when disabled, never touching the DB', async () => {
    const result = await checkFor(false).run();
    expect(result.ok).toBe(true);
    expect(result.message).toBe('auto-capture: off (default)');
  });

  it('enabled, no DB yet — ok:true, 0 count', async () => {
    const result = await checkFor(true).run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('ON');
    expect(result.message).toContain('0');
  });

  it('enabled, DB exists but recent activity is below the floor — ok:true, real-zero (quiet, not broken)', async () => {
    const dbPath = join(dir, 'memory.sqlite');
    const db = openDb(dbPath);
    migrate(db);
    new MemoryRepo(db).insert({
      type: 'fact', text: 'a manually captured fact', normalized_text: 'a manually captured fact',
      repo: 'r1', project: null, branch: null, agent: 'claude-code', session_id: null,
      hash: randomUUID(), source_hash: null,
    });
    db.close();

    const result = await checkFor(true).run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('not enough recent activity');
  });

  it('enabled, >= threshold recent memories with a healthy capture rate — ok:true, reports K of N', async () => {
    const dbPath = join(dir, 'memory.sqlite');
    const db = openDb(dbPath);
    migrate(db);
    const repo = new MemoryRepo(db);
    repo.insert({
      type: 'fact', text: 'auto atom one', normalized_text: 'auto atom one',
      repo: 'r1', project: null, branch: null, agent: 'claude-code', session_id: null,
      hash: randomUUID(), source_hash: null, capture_source: 'auto_capture',
    });
    repo.insert({
      type: 'fact', text: 'auto atom two', normalized_text: 'auto atom two',
      repo: 'r1', project: null, branch: null, agent: 'claude-code', session_id: null,
      hash: randomUUID(), source_hash: null, capture_source: 'auto_capture',
    });
    for (let i = 0; i < 18; i++) {
      repo.insert({
        type: 'fact', text: `manual atom ${i}`, normalized_text: `manual atom ${i}`,
        repo: 'r1', project: null, branch: null, agent: 'claude-code', session_id: null,
        hash: randomUUID(), source_hash: null,
      });
    }
    db.close();

    const result = await checkFor(true).run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('2 of 20');
  });

  // 2026-07-12 provenance-mismatch fix: 'hook_close' (the ordinary
  // close-capture hook — the only capture path that fires today) must count
  // toward the same total as 'auto_capture', or a user who enables
  // auto-capture but relies solely on ordinary close-capture would see a
  // permanent false-positive WARN below despite capture working perfectly.
  it('enabled, >= threshold recent memories with ONLY hook_close atoms (no auto_capture atoms) — ok:true, counted', async () => {
    const dbPath = join(dir, 'memory.sqlite');
    const db = openDb(dbPath);
    migrate(db);
    const repo = new MemoryRepo(db);
    repo.insert({
      type: 'fact', text: 'close-capture atom one', normalized_text: 'close-capture atom one',
      repo: 'r1', project: null, branch: null, agent: 'claude-code', session_id: null,
      hash: randomUUID(), source_hash: null, capture_source: 'hook_close',
    });
    for (let i = 0; i < 19; i++) {
      repo.insert({
        type: 'fact', text: `manual atom ${i}`, normalized_text: `manual atom ${i}`,
        repo: 'r1', project: null, branch: null, agent: 'claude-code', session_id: null,
        hash: randomUUID(), source_hash: null,
      });
    }
    db.close();

    const result = await checkFor(true).run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('1 of 20');
  });

  it('enabled, >= threshold recent memories from other sources but 0 recent capture — WARN (wired, never fired)', async () => {
    const dbPath = join(dir, 'memory.sqlite');
    const db = openDb(dbPath);
    migrate(db);
    const repo = new MemoryRepo(db);
    for (let i = 0; i < 20; i++) {
      repo.insert({
        type: 'fact', text: `manually captured fact ${i}`, normalized_text: `manually captured fact ${i}`,
        repo: 'r1', project: null, branch: null, agent: 'claude-code', session_id: null,
        hash: randomUUID(), source_hash: null,
      });
    }
    db.close();

    const result = await checkFor(true).run();
    expect(result.ok).toBe(false);
    expect(result.message).toContain('never firing');
    expect(result.message).toContain('0 of the 20');
    expect(result.fix).toBeDefined();
  });

  it('enabled, just below the threshold (19 recent memories), 0 recent capture — stays ok:true (no false alarm)', async () => {
    const dbPath = join(dir, 'memory.sqlite');
    const db = openDb(dbPath);
    migrate(db);
    const repo = new MemoryRepo(db);
    for (let i = 0; i < 19; i++) {
      repo.insert({
        type: 'fact', text: `manually captured fact ${i}`, normalized_text: `manually captured fact ${i}`,
        repo: 'r1', project: null, branch: null, agent: 'claude-code', session_id: null,
        hash: randomUUID(), source_hash: null,
      });
    }
    db.close();

    const result = await checkFor(true).run();
    expect(result.ok).toBe(true);
  });

  it('enabled — an invalidated (valid_to set) auto-captured atom is excluded from the recent count', async () => {
    const dbPath = join(dir, 'memory.sqlite');
    const db = openDb(dbPath);
    migrate(db);
    const repo = new MemoryRepo(db);
    const events = new MemoryEventRepo(db);
    const id = repo.insert({
      type: 'fact', text: 'invalidated auto atom', normalized_text: 'invalidated auto atom',
      repo: 'r1', project: null, branch: null, agent: 'claude-code', session_id: null,
      hash: randomUUID(), source_hash: null, capture_source: 'auto_capture',
    });
    events.invalidate(id, 'test');
    db.close();

    const result = await checkFor(true).run();
    expect(result.ok).toBe(true);
    // Invalidated -> valid_to set -> excluded from totalRecent too -> falls
    // through to the "not enough recent activity" real-zero branch, not a
    // reported rate.
    expect(result.message).toContain('not enough recent activity');
  });

  // ─── issue #217: recency window, not an all-time count ──────────────────
  describe('recency window (#217) — old capture history must not mask a live regression', () => {
    it('RED: capture worked 10 days ago, but the last 7 days show real activity with ZERO capture — WARNs', async () => {
      const dbPath = join(dir, 'memory.sqlite');
      const db = openDb(dbPath);
      migrate(db);
      const repo = new MemoryRepo(db);

      // Old, healthy capture history — this is exactly the state that made
      // the pre-fix all-time count stay green forever.
      const oldId = repo.insert({
        type: 'fact', text: 'old captured atom', normalized_text: 'old captured atom',
        repo: 'r1', project: null, branch: null, agent: 'claude-code', session_id: null,
        hash: randomUUID(), source_hash: null, capture_source: 'auto_capture',
      });
      backdate(db, oldId, SEVEN_DAYS_MS + 3 * 24 * 60 * 60 * 1000); // 10 days ago

      // Real recent activity (this week), crossing the floor, but every
      // single one is a manual atom — capture has silently stopped firing.
      for (let i = 0; i < 20; i++) {
        repo.insert({
          type: 'fact', text: `recent manual atom ${i}`, normalized_text: `recent manual atom ${i}`,
          repo: 'r1', project: null, branch: null, agent: 'claude-code', session_id: null,
          hash: randomUUID(), source_hash: null,
        });
      }
      db.close();

      const result = await checkFor(true).run();
      expect(result.ok).toBe(false);
      expect(result.message).toContain('0 of the 20');
      expect(result.message).toContain('issue #217');
    });

    it('GREEN: capture worked 10 days ago, and the last 7 days are genuinely quiet — stays green (real-zero, not broken-zero)', async () => {
      const dbPath = join(dir, 'memory.sqlite');
      const db = openDb(dbPath);
      migrate(db);
      const repo = new MemoryRepo(db);

      const oldId = repo.insert({
        type: 'fact', text: 'old captured atom', normalized_text: 'old captured atom',
        repo: 'r1', project: null, branch: null, agent: 'claude-code', session_id: null,
        hash: randomUUID(), source_hash: null, capture_source: 'auto_capture',
      });
      backdate(db, oldId, SEVEN_DAYS_MS + 3 * 24 * 60 * 60 * 1000); // 10 days ago
      db.close();

      const result = await checkFor(true).run();
      expect(result.ok).toBe(true);
      expect(result.message).toContain('not enough recent activity');
    });
  });
});
