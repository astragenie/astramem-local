/**
 * tests/doctor/entity-name-quality-check.test.ts
 *
 * Issue #207: the doctor "Entity name quality" row measures the junk rate
 * already sitting in the `entities` table (bare issue/PR references, bare
 * numbers, names below the length floor — classifyJunkEntityName,
 * src/distill/stages/05-extract.ts) — the forward-only filterAtomEntities
 * guard added alongside this check does NOT retroactively clean existing
 * rows, so this canary exists to make that visible rather than silently
 * assuming clean-going-forward means clean overall (the exact "canary
 * measures the wrong thing" failure #200 documents).
 *
 * Uses a real on-disk memory.sqlite (same pattern as
 * tests/doctor/entity-relations-check.test.ts).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getChecks } from '../../src/doctor/checks.js';
import { openDb } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { EntityRepo } from '../../src/storage/entities.js';
import { recordEntityGuardDrops } from '../../src/storage/entity-guard-log.js';

function findCheck(checks: ReturnType<typeof getChecks>, name: string) {
  const c = checks.find(c => c.name === name);
  if (!c) throw new Error(`check not found: ${name}`);
  return c;
}

describe('doctor "Entity name quality" check (issue #207)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'astra-doctor-entity-name-quality-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function check() {
    return findCheck(
      getChecks({ dataDir: dir, encryptionEnabled: false }),
      'Entity name quality',
    );
  }

  it('no DB yet — ok:true, informational', async () => {
    const result = await check().run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('no DB yet');
  });

  it('DB exists but no entities yet — ok:true', async () => {
    const db = openDb(join(dir, 'memory.sqlite'));
    migrate(db);
    db.close();

    const result = await check().run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('no entities yet');
  });

  it('below the minimum-entity floor — ok:true even with some junk (too few to judge a rate)', async () => {
    const dbPath = join(dir, 'memory.sqlite');
    const db = openDb(dbPath);
    migrate(db);
    const entities = new EntityRepo(db);
    entities.upsert('#110', 'workitem');
    entities.upsert('Postgres', 'tech');
    db.close();

    const result = await check().run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('too few entities to judge a rate');
    expect(result.message).toContain('1/2 junk');
  });

  it('at/above the floor, zero junk — ok:true', async () => {
    const dbPath = join(dir, 'memory.sqlite');
    const db = openDb(dbPath);
    migrate(db);
    const entities = new EntityRepo(db);
    for (let i = 0; i < 20; i++) entities.upsert(`entity-${i}`, 'tech');
    db.close();

    const result = await check().run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('0/20 existing entities are junk');
  });

  it('at/above the floor, non-zero junk — WARN, reports rate and does not claim self-healing', async () => {
    const dbPath = join(dir, 'memory.sqlite');
    const db = openDb(dbPath);
    migrate(db);
    const entities = new EntityRepo(db);
    entities.upsert('#110', 'workitem');
    entities.upsert('#111', 'workitem');
    entities.upsert('123', 'other');
    for (let i = 0; i < 17; i++) entities.upsert(`entity-${i}`, 'tech');
    db.close();

    const result = await check().run();
    expect(result.ok).toBe(false);
    expect(result.message).toContain('3/20');
    expect(result.message).toContain('does not retroactively clean');
    expect(result.fix).toBeDefined();
  });

  it('surfaces recent entity_name_drops activity alongside the static junk-rate snapshot', async () => {
    const dbPath = join(dir, 'memory.sqlite');
    const db = openDb(dbPath);
    migrate(db);
    const entities = new EntityRepo(db);
    for (let i = 0; i < 20; i++) entities.upsert(`entity-${i}`, 'tech');
    recordEntityGuardDrops(db, [{ reason: 'bare_issue_ref', count: 5 }], 'seed-session');
    db.close();

    const result = await check().run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('5 guard-drop(s)');
  });
});
