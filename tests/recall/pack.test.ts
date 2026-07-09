import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { MemoryRepo } from '../../src/storage/memories.js';
import { MemoryEventRepo } from '../../src/storage/memory-events.js';
import { selectPack, renderPack, estimateTokens } from '../../src/recall/pack.js';
import { buildApp } from '../../src/server/app.js';

const DAY = 24 * 60 * 60 * 1000;

// atom@2 repo/project consolidation (plan 20260709): selectPack now filters
// on `project`, not `repo` — real ingest always derives `project` from
// `repo` when one is given (src/pipeline/derive-project.ts), so this test
// double mirrors that instead of leaving `project` null the way raw
// MemoryRepo.insert callers legally can.
function seed(db: DB, type: string, text: string, importance: number, repo = 'r1') {
  new MemoryRepo(db).insert({
    type: type as never, text, normalized_text: text.toLowerCase(),
    repo, project: repo, branch: null, agent: null, session_id: null,
    hash: `h-${type}-${text.slice(0, 24)}`, source_hash: null, importance,
  });
}

describe('selectPack (KF-B)', () => {
  let db: DB;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
  });

  it('filters by repo and ranks decisions above commands at equal importance', () => {
    seed(db, 'decision', 'Use SQLite not Postgres', 0.8);
    seed(db, 'command', 'npm test -- --reporter=verbose', 0.8);
    seed(db, 'decision', 'other repo decision', 0.9, 'other-repo');

    const pack = selectPack(db, { repo: 'r1', now: Date.now() });
    expect(pack).toHaveLength(2);
    expect(pack[0]?.type).toBe('decision');   // type weight 1.0 beats command 0.6
    expect(pack.every(m => m.text !== 'other repo decision')).toBe(true);
  });

  // atom@2 repo/project consolidation AC (plan 20260709): "pack recall
  // returns same rows for repo==project data; divergent worktree rows
  // follow project semantics (intended change, documented)".
  it('repo==project data: identical results whether selectPack is called with only repo or only project', () => {
    seed(db, 'decision', 'Use SQLite not Postgres', 0.8);
    const byRepo = selectPack(db, { repo: 'r1', now: Date.now() });
    const byProject = selectPack(db, { repo: 'unused-fallback', project: 'r1', now: Date.now() });
    expect(byRepo).toHaveLength(1);
    expect(byProject).toHaveLength(1);
    expect(byProject[0]?.id).toBe(byRepo[0]?.id);
  });

  it('divergent worktree data: an explicit project wins over repo (worktree-scoped grouping, not the old repo-column behavior)', () => {
    // Simulates a git worktree: ingest recorded the canonical repo name but
    // a distinct derived project (worktree dir basename).
    new MemoryRepo(db).insert({
      type: 'decision', text: 'worktree-scoped decision', normalized_text: 'worktree-scoped decision',
      repo: 'memory', project: 'memory-worktree-atom2', branch: null, agent: null, session_id: null,
      hash: 'h-worktree-1', source_hash: null, importance: 0.8,
    });

    // Old repo-column behavior would have matched on repo='memory'; the new
    // project-column behavior requires the worktree-specific project value.
    expect(selectPack(db, { repo: 'memory', now: Date.now() })).toHaveLength(0);
    expect(selectPack(db, { repo: 'memory', project: 'memory-worktree-atom2', now: Date.now() })).toHaveLength(1);
  });

  it('respects the token budget (keeps best, drops overflow)', () => {
    for (let i = 0; i < 50; i++) {
      seed(db, 'fact', `fact number ${i} — ${'x'.repeat(200)}`, 0.5);
    }
    const pack = selectPack(db, { repo: 'r1', budgetTokens: 200, now: Date.now() });
    const total = pack.reduce((sum, m) => sum + estimateTokens(m.text), 0);
    expect(total).toBeLessThanOrEqual(200);
    expect(pack.length).toBeGreaterThan(0);
  });

  it('budget smaller than any single memory → single best memory still returned', () => {
    seed(db, 'decision', 'a decision text well over the tiny budget '.repeat(4), 0.9);
    const pack = selectPack(db, { repo: 'r1', budgetTokens: 5, now: Date.now() });
    expect(pack).toHaveLength(1);
  });

  it('empty repo → empty pack, renderPack → empty string', () => {
    const pack = selectPack(db, { repo: 'empty-repo', now: Date.now() });
    expect(pack).toEqual([]);
    expect(renderPack(pack)).toBe('');
  });

  it('renderPack groups by type with memory ids', () => {
    seed(db, 'decision', 'Use SQLite', 0.9);
    seed(db, 'lesson', 'Bun lacks better-sqlite3 on Windows', 0.8);
    const md = renderPack(selectPack(db, { repo: 'r1', now: Date.now() }));
    expect(md).toContain('## Decisions');
    expect(md).toContain('## Lessons');
    expect(md).toContain('Use SQLite');
  });
});

describe('POST /recall/pack (KF-B endpoint)', () => {
  it('returns markdown pack + memory list; empty repo → 200 with empty pack', async () => {
    const db = openDb(':memory:');
    migrate(db);
    seed(db, 'decision', 'Use SQLite', 0.9);
    const app = await buildApp({ db, token: 't' });

    const hit = await app.inject({
      method: 'POST', url: '/recall/pack',
      headers: { authorization: 'Bearer t' },
      payload: { repo: 'r1' },
    });
    expect(hit.statusCode).toBe(200);
    expect(hit.json().pack).toContain('Use SQLite');

    const miss = await app.inject({
      method: 'POST', url: '/recall/pack',
      headers: { authorization: 'Bearer t' },
      payload: { repo: 'no-such-repo' },
    });
    expect(miss.statusCode).toBe(200);
    expect(miss.json()).toEqual({ pack: '', memories: [] });
  });

  it('bad body → 400', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const app = await buildApp({ db, token: 't' });
    const res = await app.inject({
      method: 'POST', url: '/recall/pack',
      headers: { authorization: 'Bearer t' },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  // ADR-010 (2e): every memory returned in the pack gets a recall_served usefulness event.
  it('records a recall_served usefulness event per packed memory', async () => {
    const db = openDb(':memory:');
    migrate(db);
    seed(db, 'decision', 'Use SQLite for the pack test', 0.9);
    const app = await buildApp({ db, token: 't' });

    const res = await app.inject({
      method: 'POST', url: '/recall/pack',
      headers: { authorization: 'Bearer t' },
      payload: { repo: 'r1' },
    });
    const memories = res.json().memories as Array<{ id: string }>;
    expect(memories.length).toBeGreaterThan(0);

    const events = new MemoryEventRepo(db);
    for (const m of memories) {
      const served = events.listForAtom(m.id).filter(e => e.event_type === 'usefulness');
      expect(served.length).toBeGreaterThanOrEqual(1);
      const payload = JSON.parse(served[0]?.payload_json ?? '{}');
      expect(payload).toMatchObject({ family: 'recall_served', surface: 'rest', mode: 'pack' });
    }
  });
});
