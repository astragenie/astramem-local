/**
 * tests/doctor/entity-relations-check.test.ts
 *
 * FEAT-481 SLICE-430 AC-12: the "Entity relations extraction" doctor row —
 * the "built, wired, never invoked" canary for the entity-to-entity
 * relation pipeline (AtomRelationSchema in the extraction prompt ->
 * filterAtomRelations (05-extract.ts) -> stage 8's write into
 * `entity_relations`, see docs/specs/FEAT-481-design.md).
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
import { EntityRepo } from '../../src/storage/entities.js';
import { EntityRelationRepo } from '../../src/storage/entity-relations.js';
import { recordRelationGuardDrops } from '../../src/storage/relation-guard-log.js';

function findCheck(checks: ReturnType<typeof getChecks>, name: string) {
  const c = checks.find(c => c.name === name);
  if (!c) throw new Error(`check not found: ${name}`);
  return c;
}

function seedMemories(dbPath: string, n: number) {
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
      },
      events,
    );
  }
  db.close();
}

describe('doctor "Entity relations extraction" check (FEAT-481 SLICE-430 AC-12)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'astra-doctor-entity-relations-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function checkFor(extractProfile: 'engineering' | 'conversational' = 'engineering') {
    return findCheck(
      getChecks({ dataDir: dir, encryptionEnabled: false, extractProfile }),
      'Entity relations extraction',
    );
  }

  it('no DB yet — ok:true, informational', async () => {
    const result = await checkFor().run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('no DB yet');
  });

  it('DB exists but below MEANINGFUL_USAGE_THRESHOLD — ok:true, not enough activity to judge', async () => {
    seedMemories(join(dir, 'memory.sqlite'), 3);
    const result = await checkFor().run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('not enough distill activity');
    expect(result.message).toContain('3 memories');
  });

  it('>= threshold activity, 0 entity_relations rows, 0 guard drops — WARN: model never emits a relation', async () => {
    seedMemories(join(dir, 'memory.sqlite'), 25);
    const result = await checkFor().run();
    expect(result.ok).toBe(false);
    expect(result.message).toContain('relations extraction is wired but has never produced a row');
    expect(result.message).toContain('0 entity_relations rows');
    expect(result.message).toContain('0 guard-drop event(s)');
    expect(result.message.toLowerCase()).toContain('the model itself is not emitting');
    expect(result.fix).toBeDefined();
  });

  it('>= threshold activity, 0 entity_relations rows, guard drops > 0 — WARN: the guard is dropping every relation', async () => {
    const dbPath = join(dir, 'memory.sqlite');
    seedMemories(dbPath, 25);
    const db = openDb(dbPath);
    recordRelationGuardDrops(
      db,
      [{ reason: 'predicate_invalid', count: 4 }, { reason: 'no_hallucination_guard', count: 2 }],
      'seed-session',
    );
    db.close();

    const result = await checkFor().run();
    expect(result.ok).toBe(false);
    expect(result.message).toContain('relations extraction is wired but has never produced a row');
    expect(result.message).toContain('6 guard-drop event(s)');
    expect(result.message.toLowerCase()).toContain('the guard is dropping every one');
  });

  it('entity_relations rows exist — ok:true, reports total/7d/newest-age', async () => {
    const dbPath = join(dir, 'memory.sqlite');
    seedMemories(dbPath, 5);
    const db = openDb(dbPath);
    const memRepo = new MemoryRepo(db);
    const events = new MemoryEventRepo(db);
    const entityRepo = new EntityRepo(db);
    const relationRepo = new EntityRelationRepo(db);
    const memId = memRepo.insertWithCreateEvent(
      {
        type: 'fact', text: 'astramemory-local uses SQLite', normalized_text: 'astramemory-local uses SQLite',
        repo: 'r1', project: null, branch: null, agent: 'claude-code', session_id: null,
        hash: randomUUID(), source_hash: null,
      },
      events,
    ).id;
    const subjId = entityRepo.upsert('astramemory-local', 'project');
    const objId = entityRepo.upsert('SQLite', 'tech');
    relationRepo.insert({
      subjectEntityId: subjId, predicate: 'uses', objectEntityId: objId,
      evidenceMemoryId: memId, sourceExcerpt: 'astramemory-local uses SQLite', validFrom: Date.now(),
    });
    db.close();

    const result = await checkFor().run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('1 row(s) total');
  });

  it('conversational profile, >= threshold activity, 0 rows — stays ok:true (relations[] guidance is engineering-only, not a WARN-worthy gap)', async () => {
    seedMemories(join(dir, 'memory.sqlite'), 25);
    const result = await checkFor('conversational').run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('expected under the conversational extraction profile');
  });
});
