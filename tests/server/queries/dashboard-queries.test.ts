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
  queryRecentMemories,
  queryProjectOptions,
  queryProfileOptions,
  parseMemoryFilterParam,
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

// Dashboard "project" + "profile" columns/filters — project is a real
// memories.project column; profile is derived from the memory's session's
// most recent transcripts.extract_profile row (queryExtractProfilesBySession).
describe('project + profile columns and filters (dashboard memory-listing surfaces)', () => {
  let db: DB;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
  });

  function insertSession(db: DB, id: string): void {
    db.prepare('INSERT INTO sessions (id, started_at) VALUES (?, ?)').run(id, Date.now());
  }

  function insertTranscript(db: DB, opts: { id?: string; session_id: string; extract_profile: string | null; ingested_at?: number }): void {
    const id = opts.id ?? randomUUID();
    db.prepare(`
      INSERT INTO transcripts (id, session_id, source, content, ingested_at, extract_profile)
      VALUES (?, ?, 'test', 'content', ?, ?)
    `).run(id, opts.session_id, opts.ingested_at ?? Date.now(), opts.extract_profile);
  }

  function insertMemory(db: DB, opts: { project: string | null; session_id: string | null }): string {
    return new MemoryRepo(db).insert({
      type: 'fact', text: `memory for ${opts.project ?? 'no-project'}`, normalized_text: 'x',
      repo: null, project: opts.project, branch: null, agent: null,
      session_id: opts.session_id, hash: randomUUID(), source_hash: null,
    });
  }

  describe('queryRecentMemories — project column + filter', () => {
    it('SELECTs the real memories.project column with no extra query', () => {
      insertMemory(db, { project: 'astramemory-local', session_id: null });
      const rows = queryRecentMemories(db);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.project).toBe('astramemory-local');
    });

    it('filters to an exact project match', () => {
      insertMemory(db, { project: 'repo-a', session_id: null });
      insertMemory(db, { project: 'repo-b', session_id: null });

      const rows = queryRecentMemories(db, { project: 'repo-a' });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.project).toBe('repo-a');
    });

    it('the null filter selection matches rows with project IS NULL', () => {
      insertMemory(db, { project: null, session_id: null });
      insertMemory(db, { project: 'repo-a', session_id: null });

      const rows = queryRecentMemories(db, { project: null });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.project).toBeNull();
    });
  });

  describe('queryRecentMemories — derived profile column + filter', () => {
    it('derives profile from the memory session\'s most recent transcript row', () => {
      insertSession(db, 's1');
      insertTranscript(db, { session_id: 's1', extract_profile: 'conversational' });
      const memId = insertMemory(db, { project: null, session_id: 's1' });

      const rows = queryRecentMemories(db);
      const row = rows.find(r => r.id === memId)!;
      expect(row.profile).toBe('conversational');
    });

    it('picks the MOST RECENT transcript\'s extract_profile when a session has more than one', () => {
      insertSession(db, 's1');
      const now = Date.now();
      insertTranscript(db, { session_id: 's1', extract_profile: 'engineering', ingested_at: now - 10_000 });
      insertTranscript(db, { session_id: 's1', extract_profile: 'conversational', ingested_at: now });
      const memId = insertMemory(db, { project: null, session_id: 's1' });

      const rows = queryRecentMemories(db);
      expect(rows.find(r => r.id === memId)!.profile).toBe('conversational');
    });

    it('profile is null when the memory has no session_id', () => {
      const memId = insertMemory(db, { project: null, session_id: null });
      const rows = queryRecentMemories(db);
      expect(rows.find(r => r.id === memId)!.profile).toBeNull();
    });

    it('profile is null when the session has no transcript row', () => {
      insertSession(db, 's-orphan');
      const memId = insertMemory(db, { project: null, session_id: 's-orphan' });
      const rows = queryRecentMemories(db);
      expect(rows.find(r => r.id === memId)!.profile).toBeNull();
    });

    it('filters to an exact profile match via the transcripts join', () => {
      insertSession(db, 's1');
      insertTranscript(db, { session_id: 's1', extract_profile: 'conversational' });
      const convId = insertMemory(db, { project: null, session_id: 's1' });

      insertSession(db, 's2');
      insertTranscript(db, { session_id: 's2', extract_profile: 'engineering' });
      insertMemory(db, { project: null, session_id: 's2' });

      const rows = queryRecentMemories(db, { profile: 'conversational' });
      expect(rows.map(r => r.id)).toEqual([convId]);
    });

    it('the null filter selection matches memories with no derivable profile (no session, no transcript, or null extract_profile)', () => {
      const noSessionId = insertMemory(db, { project: null, session_id: null });

      insertSession(db, 's-orphan');
      const orphanId = insertMemory(db, { project: null, session_id: 's-orphan' });

      insertSession(db, 's-null-profile');
      insertTranscript(db, { session_id: 's-null-profile', extract_profile: null });
      const nullProfileId = insertMemory(db, { project: null, session_id: 's-null-profile' });

      insertSession(db, 's-has-profile');
      insertTranscript(db, { session_id: 's-has-profile', extract_profile: 'engineering' });
      insertMemory(db, { project: null, session_id: 's-has-profile' });

      const rows = queryRecentMemories(db, { profile: null });
      const ids = rows.map(r => r.id).sort();
      expect(ids).toEqual([noSessionId, nullProfileId, orphanId].sort());
    });
  });

  describe('queryProjectOptions / queryProfileOptions', () => {
    it('returns distinct non-null project values, sorted', () => {
      insertMemory(db, { project: 'repo-b', session_id: null });
      insertMemory(db, { project: 'repo-a', session_id: null });
      insertMemory(db, { project: 'repo-a', session_id: null });
      insertMemory(db, { project: null, session_id: null });

      expect(queryProjectOptions(db)).toEqual(['repo-a', 'repo-b']);
    });

    it('returns distinct non-null extract_profile values, sorted, independent of the recentMemories window', () => {
      insertSession(db, 's1');
      insertTranscript(db, { session_id: 's1', extract_profile: 'engineering' });
      insertSession(db, 's2');
      insertTranscript(db, { session_id: 's2', extract_profile: 'conversational' });
      insertSession(db, 's3');
      insertTranscript(db, { session_id: 's3', extract_profile: null });

      expect(queryProfileOptions(db)).toEqual(['conversational', 'engineering']);
    });
  });

  describe('parseMemoryFilterParam', () => {
    it('undefined/blank -> undefined (no filter)', () => {
      expect(parseMemoryFilterParam(undefined)).toBeUndefined();
      expect(parseMemoryFilterParam('')).toBeUndefined();
      expect(parseMemoryFilterParam('   ')).toBeUndefined();
    });

    it('"none" (case-insensitive) -> null', () => {
      expect(parseMemoryFilterParam('none')).toBeNull();
      expect(parseMemoryFilterParam('NONE')).toBeNull();
      expect(parseMemoryFilterParam(' None ')).toBeNull();
    });

    it('any other value -> the trimmed literal string', () => {
      expect(parseMemoryFilterParam('astramemory-local')).toBe('astramemory-local');
      expect(parseMemoryFilterParam('  engineering  ')).toBe('engineering');
    });
  });

  describe('queryDashboard threads memoryFilters through end-to-end', () => {
    it('applies a project filter and echoes it back on memoryFilters', async () => {
      insertMemory(db, { project: 'repo-a', session_id: null });
      insertMemory(db, { project: 'repo-b', session_id: null });

      const data = await queryDashboard(db, undefined, { project: 'repo-a' });
      expect(data.recentMemories.every(m => m.project === 'repo-a')).toBe(true);
      expect(data.memoryFilters).toEqual({ project: 'repo-a' });
    });

    it('defaults to no filter and populates filterOptions from the full dataset', async () => {
      insertMemory(db, { project: 'repo-a', session_id: null });
      const data = await queryDashboard(db);
      expect(data.memoryFilters).toEqual({});
      expect(data.filterOptions.projects).toContain('repo-a');
    });
  });
});
