/**
 * tests/doctor/entity-link-rate-check.test.ts
 *
 * issue #200: the "Entity relations extraction" canary reported GREEN for
 * weeks while ~87% of memories were receiving zero entities, because it
 * only asked "do relation rows exist at all" — the ~13% that DID work
 * could always answer yes. This is the canary that asks the question that
 * one never did: what FRACTION of recent memories actually got linked.
 *
 * Uses a real on-disk memory.sqlite (same pattern as
 * tests/doctor/entity-relations-check.test.ts) since the check opens
 * `join(dataDir, 'memory.sqlite')` via openProductionDbReadonly. `created_at`
 * is force-set via a direct UPDATE after insert (MemoryRepo has no
 * created_at override) so the most-recent-N tail window is deterministic
 * regardless of how fast the seeding loop runs.
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
import { recordEntityLinkDrops } from '../../src/storage/entity-link-log.js';
import type { DB } from '../../src/storage/db.js';

function findCheck(checks: ReturnType<typeof getChecks>, name: string) {
  const c = checks.find(c => c.name === name);
  if (!c) throw new Error(`check not found: ${name}`);
  return c;
}

/**
 * Inserts `n` memories at `createdAt`, linking an entity to each when
 * `linked` is true. Returns nothing — caller only needs the side effect.
 */
function seedBatch(
  db: DB,
  opts: { n: number; createdAt: number; linked: boolean; labelPrefix: string },
) {
  const memRepo = new MemoryRepo(db);
  const events = new MemoryEventRepo(db);
  const entityRepo = new EntityRepo(db);

  for (let i = 0; i < opts.n; i++) {
    const { id } = memRepo.insertWithCreateEvent(
      {
        type: 'fact',
        text: `${opts.labelPrefix} memory ${i}`,
        normalized_text: `${opts.labelPrefix} memory ${i}`,
        repo: 'r1', project: null, branch: null, agent: 'claude-code', session_id: null,
        hash: randomUUID(), source_hash: null,
      },
      events,
    );
    db.prepare('UPDATE memories SET created_at = ? WHERE id = ?').run(opts.createdAt, id);
    if (opts.linked) {
      const entityId = entityRepo.upsert(`${opts.labelPrefix}-entity-${i}`, 'other');
      entityRepo.link(id, entityId);
    }
  }
}

describe('doctor "Entity link rate" check (issue #200)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'astra-doctor-entity-link-rate-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function checkFor() {
    return findCheck(
      getChecks({ dataDir: dir, encryptionEnabled: false }),
      'Entity link rate',
    );
  }

  it('no DB yet — ok:true, informational', async () => {
    const result = await checkFor().run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('no DB yet');
  });

  // Architect review (2026-07-13, post-rebase onto #208): this check's own
  // catch block originally returned bare `ok: true` on a query failure —
  // indistinguishable from "verified healthy", the exact bug #200 exists to
  // fix, one layer deeper (the exception path the rate-vs-existence logic
  // fix didn't touch). Mirrors tests/doctor/entity-relations-check.test.ts's
  // equivalent case — a valid-but-unmigrated DB triggers the same "the query
  // itself failed" catch without a Windows file-handle quirk on opening a
  // non-SQLite file.
  it('DB file exists but has not been migrated (query hits a missing table) — inconclusive, not a clean bill of health', async () => {
    openDb(join(dir, 'memory.sqlite')).close();
    const result = await checkFor().run();
    expect(result.ok).toBe(true);
    expect(result.inconclusive).toBe(true);
    expect(result.message).toContain('check error (non-fatal)');
  });

  it('DB exists but below MEANINGFUL_USAGE_THRESHOLD — ok:true, not enough activity to judge', async () => {
    const dbPath = join(dir, 'memory.sqlite');
    const db = openDb(dbPath);
    migrate(db);
    seedBatch(db, { n: 5, createdAt: Date.now(), linked: false, labelPrefix: 'sparse' });
    db.close();

    const result = await checkFor().run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('not enough recent memories');
    expect(result.message).toContain('5 in the most-recent');
  });

  it('87% of recent memories unlinked — WARN (issue #200\'s actual broken rate)', async () => {
    const dbPath = join(dir, 'memory.sqlite');
    const db = openDb(dbPath);
    migrate(db);
    const now = Date.now();
    // 26 unlinked + 4 linked = 30 recent memories, 86.7% unlinked.
    seedBatch(db, { n: 26, createdAt: now, linked: false, labelPrefix: 'broken' });
    seedBatch(db, { n: 4, createdAt: now, linked: true, labelPrefix: 'broken-ok' });
    db.close();

    const result = await checkFor().run();
    expect(result.ok).toBe(false);
    expect(result.message).toContain('ZERO linked entities');
    expect(result.message).toContain('26/30');
    expect(result.fix).toBeDefined();
  });

  it('2% of recent memories unlinked — PASS (healthy)', async () => {
    const dbPath = join(dir, 'memory.sqlite');
    const db = openDb(dbPath);
    migrate(db);
    const now = Date.now();
    seedBatch(db, { n: 98, createdAt: now, linked: true, labelPrefix: 'healthy' });
    seedBatch(db, { n: 2, createdAt: now, linked: false, labelPrefix: 'healthy-miss' });
    db.close();

    const result = await checkFor().run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('healthy');
    expect(result.message).toContain('2/100');
  });

  it('11,032-style historical unlinked debt + healthy recent activity — PASS, not permanently red', async () => {
    const dbPath = join(dir, 'memory.sqlite');
    const db = openDb(dbPath);
    migrate(db);
    const longAgo = Date.now() - 1000 * 24 * 60 * 60 * 1000; // ~2.7 years back
    const now = Date.now();
    // Old debt: far more than the tail window, all unlinked, all old.
    seedBatch(db, { n: 300, createdAt: longAgo, linked: false, labelPrefix: 'historical' });
    // Recent activity: fully linked, all newer than the debt above, more
    // than the 100-row tail window so the window is entirely recent rows.
    seedBatch(db, { n: 150, createdAt: now, linked: true, labelPrefix: 'recent' });
    db.close();

    const result = await checkFor().run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('healthy');
    // The historical debt must be visible but non-gating.
    expect(result.message).toContain('300 all-time unlinked');
  });

  it('WARN + 0 guard drops — model itself is emitting no entities (issue #200 actual root cause)', async () => {
    const dbPath = join(dir, 'memory.sqlite');
    const db = openDb(dbPath);
    migrate(db);
    const now = Date.now();
    seedBatch(db, { n: 25, createdAt: now, linked: false, labelPrefix: 'truncated' });
    db.close();

    const result = await checkFor().run();
    expect(result.ok).toBe(false);
    expect(result.message).toContain('0 entity-link guard-drop event(s)');
    expect(result.message.toLowerCase()).toContain('the model itself is emitting no entities');
  });

  it('WARN + guard drops > 0 — entities are emitted but a write is failing', async () => {
    const dbPath = join(dir, 'memory.sqlite');
    const db = openDb(dbPath);
    migrate(db);
    const now = Date.now();
    seedBatch(db, { n: 25, createdAt: now, linked: false, labelPrefix: 'write-fail' });
    recordEntityLinkDrops(db, [{ reason: 'link_write_error', count: 7 }], 'seed-session');
    db.close();

    const result = await checkFor().run();
    expect(result.ok).toBe(false);
    expect(result.message).toContain('7 entity-link guard-drop event(s)');
    expect(result.message.toLowerCase()).toContain('a write is failing for some of them');
  });
});
