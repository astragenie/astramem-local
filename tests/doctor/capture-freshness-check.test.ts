/**
 * tests/doctor/capture-freshness-check.test.ts
 *
 * FEAT-483 SLICE-7: doctor's "Capture-chain freshness" row. Extends the
 * sibling "Auto-capture" canary (auto-capture.ts) with the missing
 * freshness dimension — age of the most-recent successful capture
 * (capture_source IN ('auto_capture', 'hook_close')) vs a staleness
 * threshold, closing the "stale global CLI 0.3.4 silently killed the
 * capture chain for days" incident class: a rate-over-a-week metric alone
 * can stay nonzero even when the chain has been dead for days, as long as a
 * single capture landed early in the window.
 *
 * Uses a real on-disk memory.sqlite (same pattern as
 * tests/doctor/auto-capture-check.test.ts) since the check opens
 * `join(dataDir, 'memory.sqlite')` via openProductionDbReadonly.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
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

/** Backdate a row's created_at — InsertInput has no created_at override
 *  (it's always wall-clock at insert time), so tests that need "old"
 *  activity update it directly after the fact. Same helper shape as
 *  auto-capture-check.test.ts's. */
function backdate(db: ReturnType<typeof openDb>, id: string, msAgo: number): void {
  db.prepare('UPDATE memories SET created_at = ? WHERE id = ?').run(Date.now() - msAgo, id);
}

describe('doctor "Capture-chain freshness" check (FEAT-483 SLICE-7)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'astra-doctor-capture-freshness-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function check() {
    return findCheck(getChecks({ dataDir: dir, encryptionEnabled: false }), 'Capture-chain freshness');
  }

  it('no DB yet — ok:true, informational', async () => {
    const result = await check().run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('no DB yet');
  });

  it('DB file exists but has not been migrated (query hits a missing table) — inconclusive, not a clean bill of health', async () => {
    openDb(join(dir, 'memory.sqlite')).close();
    const result = await check().run();
    expect(result.ok).toBe(true);
    expect(result.inconclusive).toBe(true);
    expect(result.message).toContain('check error (non-fatal)');
  });

  it('below MEANINGFUL_USAGE_THRESHOLD recent activity — ok:true, not enough activity to judge (no false alarm on a quiet box)', async () => {
    const dbPath = join(dir, 'memory.sqlite');
    const db = openDb(dbPath);
    migrate(db);
    const repo = new MemoryRepo(db);
    for (let i = 0; i < 5; i++) {
      repo.insert({
        type: 'fact', text: `manual atom ${i}`, normalized_text: `manual atom ${i}`,
        repo: 'r1', project: null, branch: null, agent: 'claude-code', session_id: null,
        hash: randomUUID(), source_hash: null,
      });
    }
    db.close();

    const result = await check().run();
    expect(result.ok).toBe(true);
    expect(result.inconclusive).toBe(true);
    expect(result.message).toContain('not enough recent activity');
  });

  it('active box (>= threshold recent activity) but capture has NEVER fired — RED, chain looks dead', async () => {
    const dbPath = join(dir, 'memory.sqlite');
    const db = openDb(dbPath);
    migrate(db);
    const repo = new MemoryRepo(db);
    for (let i = 0; i < 20; i++) {
      repo.insert({
        type: 'fact', text: `manual atom ${i}`, normalized_text: `manual atom ${i}`,
        repo: 'r1', project: null, branch: null, agent: 'claude-code', session_id: null,
        hash: randomUUID(), source_hash: null,
      });
    }
    db.close();

    const result = await check().run();
    expect(result.ok).toBe(false);
    expect(result.message).toContain('no capture');
    expect(result.message).toContain('EVER been recorded');
    expect(result.fix).toBeDefined();
  });

  it('active box, most recent capture is FRESH (within 48h) — GREEN, reports age + last-capture timestamp', async () => {
    const dbPath = join(dir, 'memory.sqlite');
    const db = openDb(dbPath);
    migrate(db);
    const repo = new MemoryRepo(db);
    const captureId = repo.insert({
      type: 'fact', text: 'recent captured atom', normalized_text: 'recent captured atom',
      repo: 'r1', project: null, branch: null, agent: 'claude-code', session_id: null,
      hash: randomUUID(), source_hash: null, capture_source: 'hook_close',
    });
    backdate(db, captureId, 2 * 60 * 60 * 1000); // 2h ago — well within the 48h floor
    for (let i = 0; i < 19; i++) {
      repo.insert({
        type: 'fact', text: `manual atom ${i}`, normalized_text: `manual atom ${i}`,
        repo: 'r1', project: null, branch: null, agent: 'claude-code', session_id: null,
        hash: randomUUID(), source_hash: null,
      });
    }
    db.close();

    const result = await check().run();
    expect(result.ok).toBe(true);
    expect(result.inconclusive).toBeFalsy();
    expect(result.message).toContain('2.0h ago');
    expect(result.message).toContain('within the 48h staleness threshold');
  });

  it('active box, most recent capture is STALE (> 48h) — RED, the capture chain has gone silent', async () => {
    const dbPath = join(dir, 'memory.sqlite');
    const db = openDb(dbPath);
    migrate(db);
    const repo = new MemoryRepo(db);
    const captureId = repo.insert({
      type: 'fact', text: 'stale captured atom', normalized_text: 'stale captured atom',
      repo: 'r1', project: null, branch: null, agent: 'claude-code', session_id: null,
      hash: randomUUID(), source_hash: null, capture_source: 'auto_capture',
    });
    backdate(db, captureId, 72 * 60 * 60 * 1000); // 72h ago — past the 48h threshold
    // Recent (non-capture) activity crossing the floor, backdated within
    // the 7d window so it still counts toward totalRecent.
    for (let i = 0; i < 20; i++) {
      const id = repo.insert({
        type: 'fact', text: `manual atom ${i}`, normalized_text: `manual atom ${i}`,
        repo: 'r1', project: null, branch: null, agent: 'claude-code', session_id: null,
        hash: randomUUID(), source_hash: null,
      });
      backdate(db, id, 60 * 60 * 1000); // 1h ago — comfortably recent
    }
    db.close();

    const result = await check().run();
    expect(result.ok).toBe(false);
    expect(result.message).toContain('72.0h ago');
    expect(result.message).toContain('exceeding the 48h staleness threshold');
    expect(result.message).toContain('FEAT-483');
    expect(result.fix).toBeDefined();
  });

  it('most recent capture is old (> 48h) but the box is genuinely quiet (below the activity floor) — stays inconclusive, not RED', async () => {
    const dbPath = join(dir, 'memory.sqlite');
    const db = openDb(dbPath);
    migrate(db);
    const repo = new MemoryRepo(db);
    const captureId = repo.insert({
      type: 'fact', text: 'old captured atom', normalized_text: 'old captured atom',
      repo: 'r1', project: null, branch: null, agent: 'claude-code', session_id: null,
      hash: randomUUID(), source_hash: null, capture_source: 'auto_capture',
    });
    backdate(db, captureId, 72 * 60 * 60 * 1000);
    db.close();

    const result = await check().run();
    expect(result.ok).toBe(true);
    expect(result.inconclusive).toBe(true);
    expect(result.message).toContain('not enough recent activity');
  });

  it('an invalidated (valid_to set) capture atom is excluded from both the freshness read and the activity floor', async () => {
    const dbPath = join(dir, 'memory.sqlite');
    const db = openDb(dbPath);
    migrate(db);
    const repo = new MemoryRepo(db);
    const events = new MemoryEventRepo(db);
    const id = repo.insert({
      type: 'fact', text: 'invalidated capture atom', normalized_text: 'invalidated capture atom',
      repo: 'r1', project: null, branch: null, agent: 'claude-code', session_id: null,
      hash: randomUUID(), source_hash: null, capture_source: 'hook_close',
    });
    events.invalidate(id, 'test');
    db.close();

    const result = await check().run();
    expect(result.ok).toBe(true);
    expect(result.inconclusive).toBe(true);
    expect(result.message).toContain('not enough recent activity');
  });

  it('7-day window boundary (#217-style): old capture history alone must not read as fresh once outside the window — RED when recent activity has no capture', async () => {
    const dbPath = join(dir, 'memory.sqlite');
    const db = openDb(dbPath);
    migrate(db);
    const repo = new MemoryRepo(db);

    // Capture worked long ago (outside the 7d activity window, and past the
    // 48h staleness threshold either way).
    const oldId = repo.insert({
      type: 'fact', text: 'old captured atom', normalized_text: 'old captured atom',
      repo: 'r1', project: null, branch: null, agent: 'claude-code', session_id: null,
      hash: randomUUID(), source_hash: null, capture_source: 'auto_capture',
    });
    backdate(db, oldId, SEVEN_DAYS_MS + 3 * 24 * 60 * 60 * 1000); // 10 days ago

    // Real recent activity, all non-capture.
    for (let i = 0; i < 20; i++) {
      repo.insert({
        type: 'fact', text: `recent manual atom ${i}`, normalized_text: `recent manual atom ${i}`,
        repo: 'r1', project: null, branch: null, agent: 'claude-code', session_id: null,
        hash: randomUUID(), source_hash: null,
      });
    }
    db.close();

    const result = await check().run();
    expect(result.ok).toBe(false);
    expect(result.message).toContain('exceeding the 48h staleness threshold');
  });
});
