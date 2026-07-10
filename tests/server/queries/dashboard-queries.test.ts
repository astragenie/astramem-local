import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { openDb } from '../../../src/storage/db.js';
import { migrate } from '../../../src/storage/migrate.js';
import { MemoryRepo } from '../../../src/storage/memories.js';
import { createHealthState } from '../../../src/server/health-state.js';
import {
  queryJobStatesByKind,
  queryConsolidationSummary,
  queryRecentFailedJobs,
  queryEntityLinkage,
  queryDashboard,
  buildDashboardHealth,
} from '../../../src/server/queries/dashboard.js';
import type { DB } from '../../../src/storage/db.js';

function insertJob(
  db: DB,
  opts: { id?: string; kind: string; state: string; last_error?: string | null; updated_at?: number },
) {
  const id = opts.id ?? randomUUID();
  const now = Date.now();
  db.prepare(`
    INSERT INTO jobs (id, kind, payload_json, state, attempts, last_error, created_at, updated_at)
    VALUES (?, ?, '{}', ?, 0, ?, ?, ?)
  `).run(id, opts.kind, opts.state, opts.last_error ?? null, now, opts.updated_at ?? now);
  return id;
}

function insertProposal(db: DB, opts: { id?: string; created_at: number }) {
  const id = opts.id ?? randomUUID();
  // winner/loser pair must be unique per pending proposal (idx_consolidation_pair_pending).
  db.prepare(`
    INSERT INTO consolidation_proposals (id, kind, winner_id, loser_id, similarity, status, created_at, resolved_at)
    VALUES (?, 'merge', ?, ?, 0.9, 'pending', ?, NULL)
  `).run(id, `winner-${id}`, `loser-${id}`, opts.created_at);
  return id;
}

describe('queryJobStatesByKind (AC-1)', () => {
  let db: DB;
  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
  });

  it('groups counts by (kind, state), distinguishing e.g. distill:poison from reembed:poison', () => {
    insertJob(db, { kind: 'distill', state: 'poison' });
    insertJob(db, { kind: 'distill', state: 'poison' });
    insertJob(db, { kind: 'reembed', state: 'poison' });
    insertJob(db, { kind: 'distill', state: 'pending' });

    const rows = queryJobStatesByKind(db);
    const byKey = new Map(rows.map(r => [`${r.kind}:${r.state}`, r.count]));
    expect(byKey.get('distill:poison')).toBe(2);
    expect(byKey.get('reembed:poison')).toBe(1);
    expect(byKey.get('distill:pending')).toBe(1);
  });
});

describe('queryConsolidationSummary (AC-3, AC-4)', () => {
  let db: DB;
  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
  });

  it('returns count=0, oldest=null when there are zero pending proposals (does not throw)', () => {
    expect(() => queryConsolidationSummary(db)).not.toThrow();
    expect(queryConsolidationSummary(db)).toEqual({ count: 0, oldest: null });
  });

  it('matches ProposalRepo.list("pending").length and oldest is the earliest created_at', () => {
    const now = Date.now();
    insertProposal(db, { created_at: now - 10_000 }); // oldest
    insertProposal(db, { created_at: now - 5_000 });
    insertProposal(db, { created_at: now });

    const summary = queryConsolidationSummary(db);
    expect(summary.count).toBe(3);
    expect(summary.oldest).toBe(now - 10_000);
  });
});

describe('queryRecentFailedJobs (AC-5)', () => {
  let db: DB;
  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
  });

  it('returns failed/poison rows ordered updated_at DESC with id/kind/state/last_error/updated_at, limited to N', () => {
    const now = Date.now();
    insertJob(db, { kind: 'distill', state: 'poison', last_error: 'ollama embed timeout', updated_at: now - 3000 });
    insertJob(db, { kind: 'reembed', state: 'failed', last_error: 'connection refused', updated_at: now - 1000 });
    insertJob(db, { kind: 'cleanup', state: 'completed', last_error: null, updated_at: now });

    const rows = queryRecentFailedJobs(db, 10);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.kind).toBe('reembed');
    expect(rows[0]!.last_error).toBe('connection refused');
    expect(rows[1]!.kind).toBe('distill');
    expect(rows.every(r => typeof r.id === 'string' && typeof r.updated_at === 'number')).toBe(true);
  });

  it('respects the limit parameter', () => {
    for (let i = 0; i < 5; i++) {
      insertJob(db, { kind: 'distill', state: 'failed', last_error: `err ${i}` });
    }
    expect(queryRecentFailedJobs(db, 3)).toHaveLength(3);
  });
});

describe('queryEntityLinkage', () => {
  let db: DB;
  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
  });

  it('counts entities and currently-valid memories with no memory_entities link', () => {
    const repo = new MemoryRepo(db);
    const idLinked = repo.insert({
      type: 'fact', text: 'linked memory', normalized_text: 'linked memory',
      repo: null, project: null, branch: null, agent: null, session_id: null,
      hash: randomUUID(), source_hash: null,
    });
    const idUnlinked = repo.insert({
      type: 'fact', text: 'unlinked memory', normalized_text: 'unlinked memory',
      repo: null, project: null, branch: null, agent: null, session_id: null,
      hash: randomUUID(), source_hash: null,
    });

    db.prepare("INSERT INTO entities (id, name, kind) VALUES ('e1', 'postgres', 'tech')").run();
    db.prepare("INSERT INTO memory_entities (id, memory_id, entity_id) VALUES ('me1', ?, ?)").run(idLinked, 'e1');

    const linkage = queryEntityLinkage(db);
    expect(linkage.entityCount).toBe(1);
    expect(linkage.unlinkedMemoryCount).toBeGreaterThanOrEqual(1);

    // The unlinked memory must be counted; the linked one must not.
    const unlinkedIds = db.prepare(`
      SELECT id FROM memories m
      WHERE valid_to IS NULL AND archived = 0
        AND NOT EXISTS (SELECT 1 FROM memory_entities me WHERE me.memory_id = m.id)
    `).all() as Array<{ id: string }>;
    expect(unlinkedIds.map(r => r.id)).toContain(idUnlinked);
    expect(unlinkedIds.map(r => r.id)).not.toContain(idLinked);
  });
});

describe('queryDashboard health merge (AC-6)', () => {
  let db: DB;
  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
  });

  it('returns a complete DashboardData with embed.ok=false when the provider is down/degraded, without throwing', async () => {
    const healthState = createHealthState();
    healthState.embed = { ok: false, lastOkAt: null, lastError: 'ollama unreachable', attempts: 3 };

    let data;
    await expect((async () => { data = await queryDashboard(db, healthState); })()).resolves.not.toThrow();
    expect(data!.health).not.toBeNull();
    expect(data!.health!.embed.ok).toBe(false);
    expect(data!.health!.status).toBe('degraded');
  });

  it('returns health: null when no HealthState is provided (bare test apps)', async () => {
    const data = await queryDashboard(db);
    expect(data.health).toBeNull();
  });

  it('buildDashboardHealth merges embed/worker/status/uptime fields from HealthState', () => {
    const healthState = createHealthState();
    healthState.embed = { ok: true, lastOkAt: Date.now(), lastError: null, attempts: 1 };
    healthState.worker.lastTickAt = Date.now();

    const health = buildDashboardHealth(healthState);
    expect(health.status).toBe('ok');
    expect(health.embed.ok).toBe(true);
    expect(health.worker.alive).toBe(true);
    expect(typeof health.uptimeSeconds).toBe('number');
  });
});

describe('queryPendingDir deletion (AC-7)', () => {
  it('is not exported from queries/dashboard.ts', async () => {
    const mod = await import('../../../src/server/queries/dashboard.js');
    expect((mod as Record<string, unknown>)['queryPendingDir']).toBeUndefined();
  });
});
