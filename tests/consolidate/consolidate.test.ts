// Wave 4b — consolidation stage 9 (ADR-004): merge-as-supersede + propose-only.

import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { MemoryRepo } from '../../src/storage/memories.js';
import { MemoryEventRepo } from '../../src/storage/memory-events.js';
import { SqliteVecStore } from '../../src/vector/sqlite-vec.js';
import { recordRecallUsed } from '../../src/storage/usefulness.js';
import { runConsolidation, mergeAsSupersede } from '../../src/consolidate/consolidate.js';
import { ProposalRepo } from '../../src/consolidate/proposals.js';
import { buildApp } from '../../src/server/app.js';

/** Unit vector with all mass on one axis, tilted toward a second axis by `tilt`. */
function vecAt(axis: number, tilt = 0, tiltAxis = 1): Float32Array {
  const v = new Float32Array(1024);
  v[axis] = 1;
  if (tilt > 0) v[tiltAxis] = tilt;
  return v;
}

async function seedEmbedded(
  db: DB, text: string, hash: string, vec: Float32Array,
  opts: { type?: 'fact' | 'decision'; repo?: string; importance?: number } = {},
): Promise<string> {
  const id = new MemoryRepo(db).insert({
    type: opts.type ?? 'fact', text, normalized_text: text.toLowerCase(),
    repo: opts.repo ?? 'r1', project: null, branch: null, agent: null,
    session_id: null, hash, source_hash: null, importance: opts.importance,
  });
  await new SqliteVecStore(db).upsert(id, vec);
  return id;
}

describe('runConsolidation (stage 9)', () => {
  let db: DB;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
  });

  it('auto-merges near-identical pairs as supersede with derived_from lineage', async () => {
    // Same direction ± tiny tilt → cosine ≈ 0.999
    const a = await seedEmbedded(db, 'port is 7777', 'h-c-1', vecAt(0, 0.01));
    const b = await seedEmbedded(db, 'the port is 7777', 'h-c-2', vecAt(0, 0.02));
    recordRecallUsed(db, { atomId: b, surface: 'rest', signal: 'explicit' }); // b wins

    const summary = runConsolidation(db);
    expect(summary.merged).toHaveLength(1);
    expect(summary.merged[0]).toMatchObject({ winner: b, loser: a });

    const repo = new MemoryRepo(db);
    const loser = repo.get(a)!;
    expect(loser.valid_to).not.toBeNull();          // superseded, not deleted (W4)
    expect(loser.superseded_by).toBe(b);
    const winner = repo.get(b)!;
    expect(winner.derived_from).toEqual([a]);        // lineage
    const events = new MemoryEventRepo(db).listForAtom(a).map(e => e.event_type);
    expect(events).toContain('supersede');
  });

  it('borderline similarity becomes a pending proposal, never an auto-merge', async () => {
    // cos = 0.45/(1·~1.09) ≈ 0.90 — inside [0.85, 0.95)
    const a = await seedEmbedded(db, 'deploys run at midnight', 'h-c-3', vecAt(0));
    const b = await seedEmbedded(db, 'deploys run nightly', 'h-c-4', vecAt(0, 0.45));

    const summary = runConsolidation(db);
    expect(summary.merged).toHaveLength(0);
    expect(summary.proposed).toHaveLength(1);

    const pending = new ProposalRepo(db).list('pending');
    expect(pending).toHaveLength(1);
    expect(pending[0]!.kind).toBe('merge');
    // Both atoms untouched until the user decides.
    expect(new MemoryRepo(db).get(a)!.valid_to).toBeNull();
    expect(new MemoryRepo(db).get(b)!.valid_to).toBeNull();
  });

  it('re-running does not duplicate a pending proposal for the same pair', async () => {
    await seedEmbedded(db, 'x', 'h-c-5', vecAt(0));
    await seedEmbedded(db, 'y', 'h-c-6', vecAt(0, 0.45));
    runConsolidation(db);
    const second = runConsolidation(db);
    expect(second.proposed).toHaveLength(0);
    expect(new ProposalRepo(db).list('pending')).toHaveLength(1);
  });

  it('never compares across (repo, type) groups and skips dissimilar pairs', async () => {
    await seedEmbedded(db, 'same vector, other repo', 'h-c-7', vecAt(0), { repo: 'r1' });
    await seedEmbedded(db, 'same vector, other repo', 'h-c-8', vecAt(0), { repo: 'r2' });
    await seedEmbedded(db, 'orthogonal', 'h-c-9', vecAt(5), { repo: 'r1' });

    const summary = runConsolidation(db);
    expect(summary.merged).toHaveLength(0);
    expect(summary.proposed).toHaveLength(0);
  });

  it('oversized groups are skipped and reported, not silently truncated', async () => {
    await seedEmbedded(db, 'a', 'h-c-10', vecAt(0));
    await seedEmbedded(db, 'b', 'h-c-11', vecAt(0, 0.01));
    await seedEmbedded(db, 'c', 'h-c-12', vecAt(0, 0.02));
    const summary = runConsolidation(db, { maxGroupSize: 2 });
    expect(summary.groupsSkipped).toHaveLength(1);
    expect(summary.groupsSkipped[0]).toMatchObject({ repo: 'r1', type: 'fact', size: 3 });
    expect(summary.merged).toHaveLength(0);
  });
});

describe('ProposalRepo accept/reject', () => {
  let db: DB;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
  });

  it('accept executes the merge; reject leaves both atoms valid', async () => {
    const a1 = await seedEmbedded(db, 'p1', 'h-p-1', vecAt(0));
    const b1 = await seedEmbedded(db, 'p2', 'h-p-2', vecAt(0, 0.45));
    runConsolidation(db);
    const repo = new ProposalRepo(db);
    const [p] = repo.list('pending');

    const accepted = repo.accept(p!.id);
    expect(accepted.status).toBe('accepted');
    const mems = new MemoryRepo(db);
    const loser = mems.get(p!.loser_id)!;
    expect(loser.superseded_by).toBe(p!.winner_id);
    expect(mems.get(p!.winner_id)!.derived_from).toEqual([p!.loser_id]);
    void a1; void b1;

    // Double-resolve → conflict
    expect(() => repo.accept(p!.id)).toThrow(/already accepted/);
    expect(() => repo.reject(p!.id)).toThrow(/already accepted/);
  });

  it('reject resolves without touching memories', async () => {
    await seedEmbedded(db, 'p3', 'h-p-3', vecAt(0));
    await seedEmbedded(db, 'p4', 'h-p-4', vecAt(0, 0.45));
    runConsolidation(db);
    const repo = new ProposalRepo(db);
    const [p] = repo.list('pending');
    expect(repo.reject(p!.id).status).toBe('rejected');
    const mems = new MemoryRepo(db);
    expect(mems.get(p!.winner_id)!.valid_to).toBeNull();
    expect(mems.get(p!.loser_id)!.valid_to).toBeNull();
  });

  it('mergeAsSupersede is idempotent on lineage', async () => {
    const w = await seedEmbedded(db, 'w', 'h-p-5', vecAt(0));
    const l1 = await seedEmbedded(db, 'l1', 'h-p-6', vecAt(1));
    const l2 = await seedEmbedded(db, 'l2', 'h-p-7', vecAt(2));
    mergeAsSupersede(db, w, l1);
    mergeAsSupersede(db, w, l2);
    expect(new MemoryRepo(db).get(w)!.derived_from).toEqual([l1, l2]);
  });
});

describe('consolidation REST surface', () => {
  it('run + list + accept roundtrip; auth enforced; bad thresholds rejected', async () => {
    const db = openDb(':memory:');
    migrate(db);
    await seedEmbedded(db, 'r1 text', 'h-r-1', vecAt(0));
    await seedEmbedded(db, 'r2 text', 'h-r-2', vecAt(0, 0.45));
    const app = await buildApp({ db, token: 't' });
    const auth = { authorization: 'Bearer t' };

    const run = await app.inject({ method: 'POST', url: '/consolidation/run', headers: auth, payload: {} });
    expect(run.statusCode).toBe(200);
    expect(run.json().proposed).toHaveLength(1);

    const list = await app.inject({ method: 'GET', url: '/consolidation/proposals?status=pending', headers: auth });
    expect(list.statusCode).toBe(200);
    const [p] = list.json().proposals;

    const accept = await app.inject({ method: 'POST', url: `/consolidation/proposals/${p.id}/accept`, headers: auth });
    expect(accept.statusCode).toBe(200);
    expect(accept.json().status).toBe('accepted');

    const again = await app.inject({ method: 'POST', url: `/consolidation/proposals/${p.id}/reject`, headers: auth });
    expect(again.statusCode).toBe(409);

    const missing = await app.inject({ method: 'POST', url: '/consolidation/proposals/nope/accept', headers: auth });
    expect(missing.statusCode).toBe(404);

    const badBody = await app.inject({
      method: 'POST', url: '/consolidation/run', headers: auth,
      payload: { merge_threshold: 0.8, propose_threshold: 0.9 },
    });
    expect(badBody.statusCode).toBe(400);

    const unauthed = await app.inject({ method: 'POST', url: '/consolidation/run', payload: {} });
    expect(unauthed.statusCode).toBe(401);
  });
});
