/**
 * tests/doctor/auto-capture-check.test.ts
 *
 * FEAT-455 / ADR-012 decision 4: doctor's "Auto-capture" row. Being ON is
 * never itself a warning (ok:true, see checkAutoCapture's doc comment for
 * why this deliberately does NOT mirror checkServicePointer's ok:false
 * dev-pinned pattern) — but since the 2026-07-12 "wired, never fired" bug
 * class, the check now WARNs (ok:false) when ON + the daemon has real
 * content (>= MEANINGFUL_USAGE_THRESHOLD active memories) yet 0 of them ever
 * came through auto-capture. Uses a real on-disk memory.sqlite (same pattern
 * as tests/doctor/memory-health-check.test.ts) since the check opens
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

function findCheck(checks: ReturnType<typeof getChecks>, name: string) {
  const c = checks.find(c => c.name === name);
  if (!c) throw new Error(`check not found: ${name}`);
  return c;
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

  it('enabled, DB exists with zero auto-captured memories — ok:true, 0 count', async () => {
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
    expect(result.message).toContain('0');
  });

  it('enabled, populated store — reports the auto-captured count, ignoring manual atoms (ok:true, deliberate — an intentional opt-in, not a misconfiguration)', async () => {
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
    repo.insert({
      type: 'fact', text: 'manual atom', normalized_text: 'manual atom',
      repo: 'r1', project: null, branch: null, agent: 'claude-code', session_id: null,
      hash: randomUUID(), source_hash: null,
    });
    db.close();

    const result = await checkFor(true).run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('2 auto-captured memories');
  });

  // 2026-07-12 provenance-mismatch fix: 'hook_close' (the ordinary
  // close-capture hook — the only capture path that fires today) must count
  // toward the same total as 'auto_capture', or a user who enables
  // auto-capture but relies solely on ordinary close-capture would see a
  // permanent false-positive WARN below despite capture working perfectly.
  it('enabled, populated store with ONLY hook_close atoms (no auto_capture atoms) — ok:true, counted', async () => {
    const dbPath = join(dir, 'memory.sqlite');
    const db = openDb(dbPath);
    migrate(db);
    const repo = new MemoryRepo(db);
    repo.insert({
      type: 'fact', text: 'close-capture atom one', normalized_text: 'close-capture atom one',
      repo: 'r1', project: null, branch: null, agent: 'claude-code', session_id: null,
      hash: randomUUID(), source_hash: null, capture_source: 'hook_close',
    });
    repo.insert({
      type: 'fact', text: 'manual atom', normalized_text: 'manual atom',
      repo: 'r1', project: null, branch: null, agent: 'claude-code', session_id: null,
      hash: randomUUID(), source_hash: null,
    });
    db.close();

    const result = await checkFor(true).run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('1 auto-captured memory');
  });

  it('enabled, >= threshold active memories from other sources but 0 auto-captured — WARN (wired, never fired)', async () => {
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
    expect(result.message).toContain('20 active');
    expect(result.fix).toBeDefined();
  });

  it('enabled, just below the threshold (19 active memories), 0 auto-captured — stays ok:true (no false alarm)', async () => {
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

  it('enabled — an invalidated (valid_to set) auto-captured atom is excluded from the count', async () => {
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
    expect(result.message).toContain('0 auto-captured memories');
  });
});
