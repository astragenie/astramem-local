/**
 * tests/doctor/auto-capture-check.test.ts
 *
 * FEAT-455 / ADR-012 decision 4: doctor's "Auto-capture" row — an
 * informational check (ok:true in both states, see checkAutoCapture's doc
 * comment for why this deliberately does NOT mirror checkServicePointer's
 * ok:false dev-pinned pattern). Uses a real on-disk memory.sqlite (same
 * pattern as tests/doctor/memory-health-check.test.ts) since the check opens
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
