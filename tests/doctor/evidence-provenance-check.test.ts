/**
 * tests/doctor/evidence-provenance-check.test.ts
 *
 * FEAT-485: the "Evidence provenance" doctor row — the "built, wired, never
 * invoked" canary for the evidence-requirement guard (requireEvidenceForRichTypes
 * in src/distill/stages/05-extract.ts -> evidence_guard_drops, migration 030).
 * Mirrors tests/doctor/entity-relations-check.test.ts's shape exactly (same
 * MEANINGFUL_USAGE_THRESHOLD gate, same guard-drop-counter split).
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
import { recordEvidenceGuardDrops } from '../../src/storage/evidence-guard-log.js';

function findCheck(checks: ReturnType<typeof getChecks>, name: string) {
  const c = checks.find(c => c.name === name);
  if (!c) throw new Error(`check not found: ${name}`);
  return c;
}

function seedRichTypeMemories(dbPath: string, n: number, withEvidence: number) {
  const db = openDb(dbPath);
  migrate(db);
  const repo = new MemoryRepo(db);
  const events = new MemoryEventRepo(db);
  for (let i = 0; i < n; i++) {
    repo.insertWithCreateEvent(
      {
        type: i % 2 === 0 ? 'decision' : 'lesson',
        text: `seed rich-type memory ${i}`,
        normalized_text: `seed rich-type memory ${i}`,
        repo: 'r1', project: null, branch: null, agent: 'claude-code', session_id: null,
        hash: randomUUID(), source_hash: null,
        evidence: i < withEvidence ? `verbatim excerpt for memory ${i}` : null,
      },
      events,
    );
  }
  db.close();
}

describe('doctor "Evidence provenance" check (FEAT-485)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'astra-doctor-evidence-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function checkFor() {
    return findCheck(getChecks({ dataDir: dir, encryptionEnabled: false }), 'Evidence provenance');
  }

  it('no DB yet — ok:true, informational', async () => {
    const result = await checkFor().run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('no DB yet');
  });

  it('below MEANINGFUL_USAGE_THRESHOLD lesson/decision memories — ok:true, not enough activity to judge', async () => {
    seedRichTypeMemories(join(dir, 'memory.sqlite'), 5, 0);
    const result = await checkFor().run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('not enough activity');
  });

  it('>= threshold, evidence rate below floor, 0 guard drops — WARN: predates FEAT-485 or non-distill path', async () => {
    seedRichTypeMemories(join(dir, 'memory.sqlite'), 25, 2); // 2/25 = 8% << 30% floor
    const result = await checkFor().run();
    expect(result.ok).toBe(false);
    expect(result.message).toContain('2/25');
    expect(result.message).toContain('0 atom(s) dropped');
    expect(result.message.toLowerCase()).toContain('predate the feat-485 evidence requirement');
    expect(result.fix).toBeDefined();
  });

  it('>= threshold, evidence rate below floor, guard drops > 0 — WARN: guard is actively dropping', async () => {
    const dbPath = join(dir, 'memory.sqlite');
    seedRichTypeMemories(dbPath, 25, 2);
    const db = openDb(dbPath);
    recordEvidenceGuardDrops(db, [{ reason: 'lesson', count: 3 }, { reason: 'decision', count: 1 }], 'seed-session');
    db.close();

    const result = await checkFor().run();
    expect(result.ok).toBe(false);
    expect(result.message).toContain('4 atom(s) dropped');
    expect(result.message.toLowerCase()).toContain('actively dropping them');
  });

  it('>= threshold, evidence rate at/above floor — ok:true', async () => {
    seedRichTypeMemories(join(dir, 'memory.sqlite'), 25, 20); // 80% >= 30% floor
    const result = await checkFor().run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('20/25');
  });
});
