import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../../src/storage/db.js';
import { migrate } from '../../../src/storage/migrate.js';
import { cleanupHandler } from '../../../src/pipeline/handlers/cleanup.js';
import { defaultConfig } from '../../../src/config/config.js';
import { MemoryRepo } from '../../../src/storage/memories.js';
import { MemoryEventRepo } from '../../../src/storage/memory-events.js';
import { defaultArtifactsDir, readSweepStats } from '../../../src/storage/retention.js';
import type { DB } from '../../../src/storage/db.js';
import type { HandlerCtx } from '../../../src/pipeline/handler.js';
import type { CleanupPayload } from '../../../src/contracts/index.js';

function insertCompletedJob(db: DB, id: string, updatedAt: number): void {
  db.prepare(`
    INSERT INTO jobs (id, kind, payload_json, state, attempts, last_error, created_at, updated_at)
    VALUES (?, 'cleanup', '{"kind":"cleanup","older_than_days":30}', 'completed', 0, NULL, ?, ?)
  `).run(id, updatedAt, updatedAt);
}

function insertPendingJob(db: DB, id: string, updatedAt: number): void {
  db.prepare(`
    INSERT INTO jobs (id, kind, payload_json, state, attempts, last_error, created_at, updated_at)
    VALUES (?, 'distill', '{"kind":"distill","transcript_id":"t1","session_id":"s1"}', 'pending', 0, NULL, ?, ?)
  `).run(id, updatedAt, updatedAt);
}

describe('cleanupHandler', () => {
  let db: DB;
  let ctx: HandlerCtx;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    ctx = { db, config: defaultConfig() };
  });

  it('removes completed jobs older than older_than_days', async () => {
    const DAY_MS = 24 * 60 * 60 * 1000;
    const now = Date.now();
    const oldTs = now - 31 * DAY_MS;  // 31 days ago — should be pruned
    const newTs = now - 1 * DAY_MS;   // 1 day ago — should be kept

    insertCompletedJob(db, 'old-job', oldTs);
    insertCompletedJob(db, 'new-job', newTs);

    const payload: CleanupPayload = { kind: 'cleanup', older_than_days: 30 };
    await cleanupHandler.handle(payload, ctx);

    const remaining = db.prepare("SELECT id FROM jobs WHERE state = 'completed'").all() as { id: string }[];
    const ids = remaining.map(r => r.id);
    expect(ids).not.toContain('old-job');
    expect(ids).toContain('new-job');
  });

  it('does not remove non-completed jobs regardless of age', async () => {
    const DAY_MS = 24 * 60 * 60 * 1000;
    const oldTs = Date.now() - 60 * DAY_MS; // very old

    insertPendingJob(db, 'old-pending', oldTs);

    const payload: CleanupPayload = { kind: 'cleanup', older_than_days: 30 };
    await cleanupHandler.handle(payload, ctx);

    const remaining = db.prepare("SELECT id FROM jobs").all() as { id: string }[];
    const ids = remaining.map(r => r.id);
    expect(ids).toContain('old-pending');
  });

  it('removes zero rows when nothing is old enough', async () => {
    const DAY_MS = 24 * 60 * 60 * 1000;
    const recentTs = Date.now() - 5 * DAY_MS; // only 5 days old

    insertCompletedJob(db, 'recent-job', recentTs);

    const payload: CleanupPayload = { kind: 'cleanup', older_than_days: 30 };
    await cleanupHandler.handle(payload, ctx);

    const remaining = db.prepare("SELECT id FROM jobs WHERE state = 'completed'").all() as { id: string }[];
    expect(remaining.map(r => r.id)).toContain('recent-job');
  });

  it('handles empty table gracefully', async () => {
    const payload: CleanupPayload = { kind: 'cleanup', older_than_days: 30 };
    await expect(cleanupHandler.handle(payload, ctx)).resolves.toBeUndefined();
  });

  it('uses older_than_days from payload', async () => {
    const DAY_MS = 24 * 60 * 60 * 1000;
    const now = Date.now();

    insertCompletedJob(db, 'three-days-old', now - 3 * DAY_MS);
    insertCompletedJob(db, 'eight-days-old', now - 8 * DAY_MS);

    // prune only jobs older than 7 days
    const payload: CleanupPayload = { kind: 'cleanup', older_than_days: 7 };
    await cleanupHandler.handle(payload, ctx);

    const remaining = db.prepare("SELECT id FROM jobs WHERE state = 'completed'").all() as { id: string }[];
    const ids = remaining.map(r => r.id);
    expect(ids).toContain('three-days-old');
    expect(ids).not.toContain('eight-days-old');
  });

  describe('ingest_idempotency retention (FEAT-432)', () => {
    const DAY_MS = 24 * 60 * 60 * 1000;

    function insertIdempotencyRow(id: string, createdAt: number): void {
      db.prepare(`
        INSERT INTO ingest_idempotency (key, body_hash, summary_memory_id, created_at)
        VALUES (?, 'hash', ?, ?)
      `).run(id, id, createdAt);
    }

    it('prunes rows older than config.ingestIdempotency.retentionDays and keeps recent ones', async () => {
      const now = Date.now();
      insertIdempotencyRow('old-key', now - 8 * DAY_MS);   // older than default 7d — pruned
      insertIdempotencyRow('recent-key', now - 1 * DAY_MS); // within window — kept

      const payload: CleanupPayload = { kind: 'cleanup', older_than_days: 30 };
      await cleanupHandler.handle(payload, ctx);

      const remaining = db.prepare('SELECT key FROM ingest_idempotency').all() as { key: string }[];
      const keys = remaining.map(r => r.key);
      expect(keys).not.toContain('old-key');
      expect(keys).toContain('recent-key');
    });

    it('keeps a row that is still within the configured retention window (replay stays safe)', async () => {
      const now = Date.now();
      const withinWindowTs = now - 6 * DAY_MS; // within default 7-day TTL
      insertIdempotencyRow('within-window-key', withinWindowTs);

      const payload: CleanupPayload = { kind: 'cleanup', older_than_days: 30 };
      await cleanupHandler.handle(payload, ctx);

      const row = db.prepare('SELECT key, body_hash, summary_memory_id FROM ingest_idempotency WHERE key = ?')
        .get('within-window-key') as { key: string; body_hash: string; summary_memory_id: string } | undefined;

      // Row survives the prune, so a replay within the TTL still resolves —
      // idempotent-replay behavior is unchanged for anything inside the window.
      expect(row).toBeDefined();
      expect(row?.summary_memory_id).toBe('within-window-key');
    });

    it('respects a configured retentionDays value other than the default', async () => {
      const now = Date.now();
      insertIdempotencyRow('three-days-old', now - 3 * DAY_MS);
      insertIdempotencyRow('eight-days-old', now - 8 * DAY_MS);

      const customCtx: HandlerCtx = {
        db,
        config: { ...defaultConfig(), ingestIdempotency: { retentionDays: 5 } },
      };
      const payload: CleanupPayload = { kind: 'cleanup', older_than_days: 30 };
      await cleanupHandler.handle(payload, customCtx);

      const remaining = db.prepare('SELECT key FROM ingest_idempotency').all() as { key: string }[];
      const keys = remaining.map(r => r.key);
      expect(keys).toContain('three-days-old');
      expect(keys).not.toContain('eight-days-old');
    });
  });

  describe('memory_events recall_served retention (Wave-3 storage+perf track)', () => {
    const DAY_MS = 24 * 60 * 60 * 1000;

    function insertMemWithScope(hash: string, scope: 'private' | 'team' | 'org'): string {
      return new MemoryRepo(db).insert({
        type: 'fact', text: 'cleanup retention test memory', normalized_text: 'cleanup retention test memory',
        repo: 'r1', project: null, branch: null, agent: null, session_id: null,
        hash, source_hash: null, scope,
      });
    }

    function insertRecallServedEvent(atomId: string, createdAt: number, syncedAt: number | null): void {
      db.prepare(`
        INSERT INTO memory_events (event_id, event_type, atom_id, payload_json, created_at, synced_at)
        VALUES (?, 'usefulness', ?, '{"family":"recall_served","query_hash":"q"}', ?, ?)
      `).run(`ev-${atomId}`, atomId, createdAt, syncedAt);
    }

    it('prunes old+synced (team/org) and old+unsynced (private) rows; keeps old+unsynced (team/org) and recent rows', async () => {
      const now = Date.now();
      const oldSyncedTeam = insertMemWithScope('old-synced-team', 'team');
      const oldUnsyncedPrivate = insertMemWithScope('old-unsynced-private', 'private');
      const oldUnsyncedTeam = insertMemWithScope('old-unsynced-team', 'team');
      const recentSyncedTeam = insertMemWithScope('recent-synced-team', 'team');

      insertRecallServedEvent(oldSyncedTeam, now - 40 * DAY_MS, now - 39 * DAY_MS);      // pruned — already shipped
      insertRecallServedEvent(oldUnsyncedPrivate, now - 40 * DAY_MS, null);              // pruned — never ship-eligible (private)
      insertRecallServedEvent(oldUnsyncedTeam, now - 40 * DAY_MS, null);                 // kept — shipper may still need it
      insertRecallServedEvent(recentSyncedTeam, now - 1 * DAY_MS, now);                  // kept — not old enough

      const payload: CleanupPayload = { kind: 'cleanup', older_than_days: 30 };
      await cleanupHandler.handle(payload, ctx);

      const remaining = db.prepare('SELECT atom_id FROM memory_events WHERE event_type = \'usefulness\'').all() as { atom_id: string }[];
      const atomIds = remaining.map(r => r.atom_id);
      expect(atomIds).not.toContain(oldSyncedTeam);
      expect(atomIds).not.toContain(oldUnsyncedPrivate);
      expect(atomIds).toContain(oldUnsyncedTeam);
      expect(atomIds).toContain(recentSyncedTeam);
    });

    it('respects a configured recallServedRetentionDays value other than the default', async () => {
      const now = Date.now();
      const threeDaysOld = insertMemWithScope('three-days-old', 'team');
      const eightDaysOld = insertMemWithScope('eight-days-old', 'team');
      insertRecallServedEvent(threeDaysOld, now - 3 * DAY_MS, now - 2 * DAY_MS);
      insertRecallServedEvent(eightDaysOld, now - 8 * DAY_MS, now - 7 * DAY_MS);

      const customCtx: HandlerCtx = {
        db,
        config: { ...defaultConfig(), memoryEvents: { recallServedRetentionDays: 5 } },
      };
      const payload: CleanupPayload = { kind: 'cleanup', older_than_days: 30 };
      await cleanupHandler.handle(payload, customCtx);

      const remaining = db.prepare('SELECT atom_id FROM memory_events WHERE event_type = \'usefulness\'').all() as { atom_id: string }[];
      const atomIds = remaining.map(r => r.atom_id);
      expect(atomIds).toContain(threeDaysOld);
      expect(atomIds).not.toContain(eightDaysOld);
    });
  });

  // Issue #209: the durable safety net behind the write-time retry-job
  // enqueue — every memory still flagged needs_vec_index gets a `reembed`
  // job on this same 24h tick (ADR-015 §4: reuse the existing cadence
  // rather than a new timer).
  describe('vec-index sweep (issue #209)', () => {
    function insertMemory(db: DB, id: string, needsVecIndex: boolean): void {
      const now = Date.now();
      db.prepare(`
        INSERT INTO memories
          (id, type, text, normalized_text, hash, importance, confidence,
           created_at, updated_at, valid_from, scope, needs_vec_index)
        VALUES (?, 'fact', 'x', 'x', ?, 0.5, 0.5, ?, ?, ?, 'private', ?)
      `).run(id, id, now, now, now, needsVecIndex ? 1 : 0);
    }

    it('enqueues a reembed job for every needs_vec_index=1 memory', async () => {
      insertMemory(db, 'mem-flagged-1', true);
      insertMemory(db, 'mem-flagged-2', true);
      insertMemory(db, 'mem-not-flagged', false);

      const payload: CleanupPayload = { kind: 'cleanup', older_than_days: 30 };
      await cleanupHandler.handle(payload, ctx);

      const jobs = db.prepare("SELECT payload_json FROM jobs WHERE kind = 'reembed'").all() as { payload_json: string }[];
      const enqueuedIds = jobs.map(j => (JSON.parse(j.payload_json) as { memory_id: string }).memory_id).sort();
      expect(enqueuedIds).toEqual(['mem-flagged-1', 'mem-flagged-2']);
    });

    it('does not enqueue anything when no memory is flagged', async () => {
      insertMemory(db, 'mem-clean-1', false);

      const payload: CleanupPayload = { kind: 'cleanup', older_than_days: 30 };
      await cleanupHandler.handle(payload, ctx);

      const count = (db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind = 'reembed'").get() as { n: number }).n;
      expect(count).toBe(0);
    });

    it('caps the sweep at VEC_INDEX_SWEEP_LIMIT (500) per pass', async () => {
      for (let i = 0; i < 501; i++) insertMemory(db, `mem-bulk-${i}`, true);

      const payload: CleanupPayload = { kind: 'cleanup', older_than_days: 30 };
      await cleanupHandler.handle(payload, ctx);

      const count = (db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind = 'reembed'").get() as { n: number }).n;
      expect(count).toBe(500);
    });
  });

  // issue #190 build-sequence phase 3 / AC-5: implicit positive-usefulness
  // sweep runs on this same cadence, gated behind
  // config.search.usefulness.implicitPositive.enabled (default TRUE since
  // 2026-07-18 — eval-evidence gate satisfied, see RECORDED_EVAL_EVIDENCE).
  describe('implicit positive-usefulness sweep (issue #190)', () => {
    function insertFact(db: DB, hash: string): string {
      return new MemoryRepo(db).insert({
        type: 'fact', text: 'x', normalized_text: 'x',
        repo: 'r1', project: null, branch: null, agent: null, session_id: null,
        hash, source_hash: null,
      });
    }

    function servedTwice(db: DB, atomId: string): void {
      const events = new MemoryEventRepo(db);
      events.append({ event_type: 'usefulness', atom_id: atomId, payload: { family: 'recall_served', query_hash: 'q1', score: null, surface: 'rest', mode: null } });
      events.append({ event_type: 'usefulness', atom_id: atomId, payload: { family: 'recall_served', query_hash: 'q2', score: null, surface: 'rest', mode: null } });
    }

    // AC-5: explicit opt-out is a true no-op — a fixture that would otherwise
    // qualify gets no grant, and no heuristic recall_used event appears.
    // (Was "default off" until the 2026-07-18 flip; the off-case is now
    // exercised via an explicit enabled:false ctx, mirroring the enabled:true
    // ctx below, so the test no longer depends on which way the default points.)
    it('AC-5: enabled:false (explicit opt-out) never invokes the pass — a qualifying atom gets no grant', async () => {
      const atomId = insertFact(db, 'implicit-cleanup-off');
      servedTwice(db, atomId);

      const disabledCtx: HandlerCtx = {
        db,
        config: {
          ...defaultConfig(),
          search: {
            ...defaultConfig().search,
            usefulness: { implicitPositive: { ...defaultConfig().search.usefulness.implicitPositive, enabled: false } },
          },
        },
      };
      const payload: CleanupPayload = { kind: 'cleanup', older_than_days: 30 };
      await cleanupHandler.handle(payload, disabledCtx);

      const grants = new MemoryEventRepo(db).listForAtom(atomId).filter(e => {
        const p = JSON.parse(e.payload_json ?? '{}');
        return p.family === 'recall_used';
      });
      expect(grants).toHaveLength(0);
    });

    it('enabled:true grants a heuristic recall_used event for a qualifying atom', async () => {
      const atomId = insertFact(db, 'implicit-cleanup-on');
      servedTwice(db, atomId);

      const enabledCtx: HandlerCtx = {
        db,
        config: {
          ...defaultConfig(),
          search: {
            ...defaultConfig().search,
            usefulness: { implicitPositive: { ...defaultConfig().search.usefulness.implicitPositive, enabled: true } },
          },
        },
      };
      const payload: CleanupPayload = { kind: 'cleanup', older_than_days: 30 };
      await cleanupHandler.handle(payload, enabledCtx);

      const grant = new MemoryEventRepo(db).listForAtom(atomId).find(e => {
        const p = JSON.parse(e.payload_json ?? '{}');
        return p.family === 'recall_used';
      });
      expect(grant).toBeDefined();
      const payloadJson = JSON.parse(grant?.payload_json ?? '{}');
      expect(payloadJson.signal).toBe('heuristic');
    });
  });

  // FEAT-493: tiered disk-artifact retention runs on this same cadence,
  // gated behind config.retention.mode !== 'off' (default). Un-clamped from
  // the #317 scaffolding — 'enabled' now actually deletes files.
  describe('disk-artifact retention (FEAT-493)', () => {
    const DAY_MS = 24 * 60 * 60 * 1000;
    let dataDir: string;

    function writeArtifact(kind: string, name: string, sizeBytes: number, mtimeMs: number): string {
      const kindDir = join(defaultArtifactsDir(dataDir), kind);
      mkdirSync(kindDir, { recursive: true });
      const filePath = join(kindDir, name);
      writeFileSync(filePath, Buffer.alloc(sizeBytes));
      const mtimeSec = mtimeMs / 1000;
      utimesSync(filePath, mtimeSec, mtimeSec);
      return filePath;
    }

    beforeEach(() => {
      dataDir = mkdtempSync(join(tmpdir(), 'astramem-cleanup-retention-test-'));
    });

    afterEach(() => {
      rmSync(dataDir, { recursive: true, force: true });
    });

    it("mode 'off' (default) never touches the filesystem — artifact survives a cleanup pass", async () => {
      const filePath = writeArtifact('audio-raw', 'a1.wav', 2 * 1024 * 1024, Date.now() - 120 * DAY_MS);
      const offCtx: HandlerCtx = { db, config: { ...defaultConfig(), dataDir } };

      await cleanupHandler.handle({ kind: 'cleanup', older_than_days: 30 }, offCtx);

      expect(existsSync(filePath)).toBe(true);
      expect(readSweepStats(dataDir)).toBeNull(); // no sweep even attempted
    });

    it("mode 'enabled' reclaims a matching heavy artifact and persists the sweep result", async () => {
      const filePath = writeArtifact('audio-raw', 'a1.wav', 2 * 1024 * 1024, Date.now() - 120 * DAY_MS);
      const enabledCtx: HandlerCtx = {
        db,
        config: {
          ...defaultConfig(),
          dataDir,
          retention: {
            ...defaultConfig().retention,
            mode: 'enabled',
            tier: 'media',
            heavyArtifact: { minSizeBytes: 1024, types: ['audio-raw'] },
            tierScope: { media: ['audio-raw'], lean: [] },
          },
        },
      };

      await cleanupHandler.handle({ kind: 'cleanup', older_than_days: 30 }, enabledCtx);

      expect(existsSync(filePath)).toBe(false);
      const stats = readSweepStats(dataDir);
      expect(stats).toMatchObject({ tier: 'media', mode: 'enabled', deletedCount: 1 });
    });

    it("mode 'enabled' never deletes a memory row, even with distilled memories present", async () => {
      new MemoryRepo(db).insert({
        type: 'fact', text: 'a distilled memory', normalized_text: 'a distilled memory',
        repo: 'r1', project: null, branch: null, agent: null, session_id: null,
        hash: 'retention-boundary-hash', source_hash: null,
      });
      const before = (db.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number }).n;
      writeArtifact('audio-raw', 'a1.wav', 2 * 1024 * 1024, Date.now() - 120 * DAY_MS);

      const enabledCtx: HandlerCtx = {
        db,
        config: {
          ...defaultConfig(),
          dataDir,
          retention: {
            ...defaultConfig().retention,
            mode: 'enabled',
            tier: 'all',
            heavyArtifact: { minSizeBytes: 1024, types: ['audio-raw'] },
          },
        },
      };

      await cleanupHandler.handle({ kind: 'cleanup', older_than_days: 30 }, enabledCtx);

      const after = (db.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number }).n;
      expect(after).toBe(before); // memory row axis untouched by the retention pass
    });
  });
});
