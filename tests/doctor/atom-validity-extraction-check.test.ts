/**
 * tests/doctor/atom-validity-extraction-check.test.ts
 *
 * Issue #205 (AC-5): the "Atom validity extraction" doctor row — a RATE
 * canary (% of recent memories with validity_extracted = 1), not an
 * existence check, so it catches the pipeline silently producing zero real
 * coverage (issue #200's "green while broken" mistake) rather than just
 * "does at least one row have this flag."
 *
 * Uses a real on-disk memory.sqlite (same pattern as
 * tests/doctor/entity-relations-check.test.ts) since the check opens
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

function seedMemories(dbPath: string, n: number, validityExtracted: boolean) {
  const db = openDb(dbPath);
  migrate(db);
  const repo = new MemoryRepo(db);
  const events = new MemoryEventRepo(db);
  for (let i = 0; i < n; i++) {
    repo.insertWithCreateEvent(
      {
        type: 'fact', text: `seed memory ${i}`, normalized_text: `seed memory ${i}`,
        repo: 'r1', project: null, branch: null, agent: 'claude-code', session_id: null,
        hash: randomUUID(), source_hash: null,
        validity_extracted: validityExtracted,
      },
      events,
    );
  }
  db.close();
}

describe('doctor "Atom validity extraction" check (issue #205 AC-5)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'astra-doctor-validity-extracted-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function check() {
    return findCheck(
      getChecks({ dataDir: dir, encryptionEnabled: false }),
      'Atom validity extraction',
    );
  }

  it('no DB yet — ok:true, informational', async () => {
    const result = await check().run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('no DB yet');
  });

  it('DB exists but below MEANINGFUL_USAGE_THRESHOLD — ok:true, not enough activity to judge', async () => {
    seedMemories(join(dir, 'memory.sqlite'), 3, false);
    const result = await check().run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('not enough recent activity');
    expect(result.message).toContain('3 memories');
  });

  it('>= threshold activity, 0 validity_extracted rows — WARN: wired but never invoked', async () => {
    seedMemories(join(dir, 'memory.sqlite'), 25, false);
    const result = await check().run();
    expect(result.ok).toBe(false);
    expect(result.message).toContain('0/25 recent memories');
    expect(result.message.toLowerCase()).toContain('built, wired, never invoked');
    expect(result.fix).toBeDefined();
  });

  it('>= threshold activity, some validity_extracted rows — ok:true, reports the rate', async () => {
    const dbPath = join(dir, 'memory.sqlite');
    seedMemories(dbPath, 20, true);
    seedMemories(dbPath, 10, false);
    const result = await check().run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('20/30');
    expect(result.message).toContain('66.7%');
  });

  it('all recent memories have validity_extracted = 1 — ok:true, 100%', async () => {
    seedMemories(join(dir, 'memory.sqlite'), 25, true);
    const result = await check().run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('25/25');
    expect(result.message).toContain('100.0%');
  });

  // THE TEST WHOSE ABSENCE LET THE BUG SHIP.
  //
  // The original gate was `extracted === 0` — it only went red when NOTHING
  // worked. A pipeline regression that collapsed coverage from 100% to 2% would
  // have reported ok:true forever, because 2% is not 0%.
  //
  // That is the identical shape of issue #200, the bug this very check was
  // written to prevent: a canary that was green for weeks while ~87% of
  // memories got zero entities, because it only asked "does ANY success exist?"
  // The fix for #205 rebuilt it.
  //
  // ADR-015, strengthened: a canary MUST measure the RATE of the failure, not
  // the EXISTENCE of a success. The old suite could not tell 66.7% from 100%
  // and had no case at all for a collapse — so the defect was invisible to it.
  it('coverage COLLAPSES to 2% — WARN, not a green "well, it is not zero"', async () => {
    const dbPath = join(dir, 'memory.sqlite');
    seedMemories(dbPath, 2, true);   // a couple still work...
    seedMemories(dbPath, 98, false); // ...while the pipeline is 98% broken
    const result = await check().run();
    expect(result.ok).toBe(false);
    expect(result.message).toContain('2/100');
    expect(result.message).toContain('2.0%');
  });
});
