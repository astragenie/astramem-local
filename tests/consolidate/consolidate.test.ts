// Wave 4b — consolidation stage 9 (ADR-004): merge-as-supersede + propose-only.

import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { MemoryRepo } from '../../src/storage/memories.js';
import { MemoryEventRepo } from '../../src/storage/memory-events.js';
import { SqliteVecStore } from '../../src/vector/sqlite-vec.js';
import { recordRecallUsed } from '../../src/storage/usefulness.js';
import { runConsolidation, mergeAsSupersede } from '../../src/consolidate/consolidate.js';
import { ProposalRepo, parseContradictionMetadata, parseDupJudgeMetadata } from '../../src/consolidate/proposals.js';
import { buildApp } from '../../src/server/app.js';
import { defaultConfig } from '../../src/config/config.js';
import { makeMockProviders } from '../../src/pipeline/mock-providers.js';
import { latestConsolidationJudgeRun } from '../../src/storage/consolidation-judge-log.js';
import type { LLMProvider, ChatMsg, ChatOpts, ChatResult, LLMHealth } from '../../src/contracts/index.js';

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

    const summary = await runConsolidation(db);
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
    // cos = 0.45/(1·~1.09) ≈ 0.90 — inside [0.85, 0.92)
    const a = await seedEmbedded(db, 'deploys run at midnight', 'h-c-3', vecAt(0));
    const b = await seedEmbedded(db, 'deploys run nightly', 'h-c-4', vecAt(0, 0.45));

    const summary = await runConsolidation(db);
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
    await runConsolidation(db);
    const second = await runConsolidation(db);
    expect(second.proposed).toHaveLength(0);
    expect(new ProposalRepo(db).list('pending')).toHaveLength(1);
  });

  it('never compares across (repo, type) groups and skips dissimilar pairs', async () => {
    await seedEmbedded(db, 'same vector, other repo', 'h-c-7', vecAt(0), { repo: 'r1' });
    await seedEmbedded(db, 'same vector, other repo', 'h-c-8', vecAt(0), { repo: 'r2' });
    await seedEmbedded(db, 'orthogonal', 'h-c-9', vecAt(5), { repo: 'r1' });

    const summary = await runConsolidation(db);
    expect(summary.merged).toHaveLength(0);
    expect(summary.proposed).toHaveLength(0);
  });

  it('oversized groups are skipped and reported, not silently truncated', async () => {
    await seedEmbedded(db, 'a', 'h-c-10', vecAt(0));
    await seedEmbedded(db, 'b', 'h-c-11', vecAt(0, 0.01));
    await seedEmbedded(db, 'c', 'h-c-12', vecAt(0, 0.02));
    const summary = await runConsolidation(db, { maxGroupSize: 2 });
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
    await runConsolidation(db);
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

  // FEAT-437 residual: `consolidate accept --all` distinct provenance.
  it('accept with bulkAccepted marks the supersede event distinctly from a plain manual accept', async () => {
    const a1 = await seedEmbedded(db, 'p5', 'h-p-9', vecAt(0));
    const b1 = await seedEmbedded(db, 'p6', 'h-p-10', vecAt(0, 0.45));
    await runConsolidation(db);
    const repo = new ProposalRepo(db);
    const [p] = repo.list('pending');

    const accepted = repo.accept(p!.id, undefined, { bulkAccepted: true });
    expect(accepted.status).toBe('accepted');

    const supersedeEvent = new MemoryEventRepo(db).listForAtom(p!.loser_id)
      .find(e => e.event_type === 'supersede')!;
    const payload = JSON.parse(supersedeEvent.payload_json ?? '{}');
    expect(payload).toMatchObject({ bulk_accepted: true, superseded_by: p!.winner_id });
    expect(payload.auto_accepted).toBeUndefined(); // bulk =/= auto
    void a1; void b1;
  });

  it('reject resolves without touching memories', async () => {
    await seedEmbedded(db, 'p3', 'h-p-3', vecAt(0));
    await seedEmbedded(db, 'p4', 'h-p-4', vecAt(0, 0.45));
    await runConsolidation(db);
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
    mergeAsSupersede(db, w, l1, undefined, 'consolidation_auto');
    mergeAsSupersede(db, w, l2, undefined, 'consolidation_auto');
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

  // FEAT-437 residual: POST .../accept { bulk: true } (the `consolidate
  // accept --all` CLI path) marks the resulting supersede event distinctly
  // from a plain accept with no body.
  it('POST /consolidation/proposals/:id/accept { bulk: true } marks the event bulk_accepted', async () => {
    const db = openDb(':memory:');
    migrate(db);
    await seedEmbedded(db, 'bulk winner', 'h-bulk-1', vecAt(0));
    await seedEmbedded(db, 'bulk loser', 'h-bulk-2', vecAt(0, 0.45));
    const app = await buildApp({ db, token: 't' });
    const auth = { authorization: 'Bearer t' };

    await app.inject({ method: 'POST', url: '/consolidation/run', headers: auth, payload: {} });
    const list = await app.inject({ method: 'GET', url: '/consolidation/proposals?status=pending', headers: auth });
    const [p] = list.json().proposals;

    const accept = await app.inject({
      method: 'POST', url: `/consolidation/proposals/${p.id}/accept`, headers: auth, payload: { bulk: true },
    });
    expect(accept.statusCode).toBe(200);

    const supersedeEvent = new MemoryEventRepo(db).listForAtom(p.loser_id)
      .find((e: { event_type: string }) => e.event_type === 'supersede')!;
    const payload = JSON.parse(supersedeEvent.payload_json ?? '{}');
    expect(payload.bulk_accepted).toBe(true);
    expect(payload.auto_accepted).toBeUndefined();
  });

  // FEAT-456 SLICE-2: `kind` is an optional second filter on the list
  // route (design §2.4/§9's `?status=accepted&kind=contradiction` audit
  // query) — additive alongside `status`, no change to existing callers.
  it('GET /consolidation/proposals?kind= filters by proposal kind', async () => {
    const db = openDb(':memory:');
    migrate(db);
    await seedEmbedded(db, 'merge winner', 'h-kind-1', vecAt(0));
    await seedEmbedded(db, 'merge loser', 'h-kind-2', vecAt(0, 0.45));
    // A different, unrelated pair for the contradiction row — the unique
    // pending-pair index (idx_consolidation_pair_pending) has no `kind`
    // predicate, so a contradiction proposal for the SAME pair the merge
    // run just proposed would collide with it (§2.3).
    const cw = await seedEmbedded(db, 'default port is now 8888', 'h-kind-3', vecAt(3));
    const cl = await seedEmbedded(db, 'default port is 7777', 'h-kind-4', vecAt(4));
    const app = await buildApp({ db, token: 't' });
    const auth = { authorization: 'Bearer t' };
    await app.inject({ method: 'POST', url: '/consolidation/run', headers: auth, payload: {} });

    db.prepare(`
      INSERT INTO consolidation_proposals (id, kind, winner_id, loser_id, similarity, status, created_at, metadata_json)
      VALUES ('prop-kind-contra', 'contradiction', ?, ?, ?, 'pending', ?, ?)
    `).run(cw, cl, 0.7, Date.now(), JSON.stringify({ verdict: 'contradicts', confidence: 0.9, winner_excerpt: 'x', loser_excerpt: 'y' }));

    const both = await app.inject({ method: 'GET', url: '/consolidation/proposals?status=pending', headers: auth });
    expect(both.json().proposals).toHaveLength(2);

    const mergeOnly = await app.inject({ method: 'GET', url: '/consolidation/proposals?status=pending&kind=merge', headers: auth });
    const mergeList = mergeOnly.json().proposals as Array<{ kind: string }>;
    expect(mergeList).toHaveLength(1);
    expect(mergeList[0]!.kind).toBe('merge');

    const contraOnly = await app.inject({ method: 'GET', url: '/consolidation/proposals?status=pending&kind=contradiction', headers: auth });
    const contraList = contraOnly.json().proposals as Array<{ kind: string }>;
    expect(contraList).toHaveLength(1);
    expect(contraList[0]!.kind).toBe('contradiction');
  });

  // #372/#171: GET /consolidation/proposals ignored ?limit entirely — always
  // returned the full pending set. limit/offset/min_confidence are additive
  // query params backed by ProposalRepo's new pagination opts; `total`
  // reflects status/kind/min_confidence but not the limit/offset slice.
  it('GET /consolidation/proposals?limit=&offset=&min_confidence= paginates and filters (#171/#372)', async () => {
    const db = openDb(':memory:');
    migrate(db);
    // Five independent near-duplicate pairs -> five pending merge proposals,
    // similarity controlled via `tilt` so min_confidence has something to
    // filter (proposalConfidence == similarity for kind=merge).
    for (let i = 0; i < 5; i++) {
      await seedEmbedded(db, `topic ${i} winner`, `h-page-w${i}`, vecAt(10 + i));
      await seedEmbedded(db, `topic ${i} loser`, `h-page-l${i}`, vecAt(10 + i, 0.45));
    }
    const app = await buildApp({ db, token: 't' });
    const auth = { authorization: 'Bearer t' };
    await app.inject({ method: 'POST', url: '/consolidation/run', headers: auth, payload: {} });

    const all = await app.inject({ method: 'GET', url: '/consolidation/proposals?status=pending', headers: auth });
    expect(all.json().proposals).toHaveLength(5);
    expect(all.json().total).toBe(5);

    const page1 = await app.inject({ method: 'GET', url: '/consolidation/proposals?status=pending&limit=2', headers: auth });
    expect(page1.json().proposals).toHaveLength(2);
    expect(page1.json().total).toBe(5); // total is NOT clamped by limit

    const page2 = await app.inject({ method: 'GET', url: '/consolidation/proposals?status=pending&limit=2&offset=2', headers: auth });
    expect(page2.json().proposals).toHaveLength(2);
    const overlap = new Set([
      ...(page1.json().proposals as Array<{ id: string }>).map(p => p.id),
      ...(page2.json().proposals as Array<{ id: string }>).map(p => p.id),
    ]);
    expect(overlap.size).toBe(4); // no duplicate rows across pages

    // Every seeded pair sits at the same borderline similarity band, so a
    // floor above that band excludes all of them and total drops to 0 too.
    const filtered = await app.inject({
      method: 'GET', url: '/consolidation/proposals?status=pending&min_confidence=0.999', headers: auth,
    });
    expect(filtered.json().proposals).toEqual([]);
    expect(filtered.json().total).toBe(0);

    const badLimit = await app.inject({ method: 'GET', url: '/consolidation/proposals?status=pending&limit=0', headers: auth });
    expect(badLimit.statusCode).toBe(400); // limit must be positive
  });

  // #372 scope update (2026-07-16): consolidation.candidateSelection=knn is
  // now LIVE in prod (shipped default stays 'full'). POST /consolidation/run
  // reads candidateSelection from the app's Config, not the request body
  // (src/server/routes/consolidation.ts), so exercising knn over HTTP means
  // building the app with a knn-configured Config — same pagination/total
  // assertions as the 'full'-mode test above, proving the route wiring is
  // unaffected by which mode actually produced the proposals.
  it('GET /consolidation/proposals paginates identically when the app is configured for candidateSelection=knn (#372)', async () => {
    const db = openDb(':memory:');
    migrate(db);
    for (let i = 0; i < 5; i++) {
      await seedEmbedded(db, `knn topic ${i} winner`, `h-knn-page-w${i}`, vecAt(30 + i));
      await seedEmbedded(db, `knn topic ${i} loser`, `h-knn-page-l${i}`, vecAt(30 + i, 0.45));
    }
    const knnConfig = {
      ...defaultConfig(),
      consolidation: { ...defaultConfig().consolidation, candidateSelection: 'knn' as const, knnK: 3 },
    };
    const app = await buildApp({ db, token: 't', config: knnConfig });
    const auth = { authorization: 'Bearer t' };
    const run = await app.inject({ method: 'POST', url: '/consolidation/run', headers: auth, payload: {} });
    expect((run.json() as { proposed: unknown[] }).proposed).toHaveLength(5); // knn found every seeded pair

    const all = await app.inject({ method: 'GET', url: '/consolidation/proposals?status=pending', headers: auth });
    expect(all.json().proposals).toHaveLength(5);
    expect(all.json().total).toBe(5);

    const page1 = await app.inject({ method: 'GET', url: '/consolidation/proposals?status=pending&limit=2', headers: auth });
    const page2 = await app.inject({ method: 'GET', url: '/consolidation/proposals?status=pending&limit=2&offset=2', headers: auth });
    const page3 = await app.inject({ method: 'GET', url: '/consolidation/proposals?status=pending&limit=2&offset=4', headers: auth });
    const paged = [
      ...(page1.json().proposals as Array<{ id: string }>),
      ...(page2.json().proposals as Array<{ id: string }>),
      ...(page3.json().proposals as Array<{ id: string }>),
    ];
    expect(paged.map(p => p.id)).toEqual((all.json().proposals as Array<{ id: string }>).map(p => p.id));
  });
});

describe('containment auto-merge (FEAT-410 follow-up)', () => {
  let db: DB;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
  });

  it('auto-merges a normalized-subset pair with the SUPERSET text as winner, reason contained', async () => {
    // Similar vectors (proposal band ~0.90) but text containment → auto-merge.
    const short = await seedEmbedded(db, 'Port 7777 is the default.', 'h-ct-1', vecAt(0));
    const long = await seedEmbedded(db, 'port 7777 is the default for API endpoints', 'h-ct-2', vecAt(0, 0.45));
    // Give the SHORT one the usefulness win — containment must override it.
    recordRecallUsed(db, { atomId: short, surface: 'rest', signal: 'explicit' });

    const summary = await runConsolidation(db);
    expect(summary.proposed).toHaveLength(0);
    expect(summary.merged).toHaveLength(1);
    expect(summary.merged[0]).toMatchObject({ winner: long, loser: short, reason: 'contained' });
    expect(new MemoryRepo(db).get(short)!.superseded_by).toBe(long);
  });

  it('treats case/punctuation-only variants as equal and merges by the usual winner rules', async () => {
    const a = await seedEmbedded(db, 'Use SQLite, not Postgres', 'h-ct-3', vecAt(0));
    const b = await seedEmbedded(db, 'use SQLite not Postgres.', 'h-ct-4', vecAt(0, 0.45));
    recordRecallUsed(db, { atomId: b, surface: 'rest', signal: 'explicit' });

    const summary = await runConsolidation(db);
    expect(summary.merged).toHaveLength(1);
    expect(summary.merged[0]).toMatchObject({ winner: b, loser: a, reason: 'contained' });
  });

  it('autoMergeContained:false keeps contained pairs as manual proposals', async () => {
    await seedEmbedded(db, 'Port 7777 is the default.', 'h-ct-5', vecAt(0));
    await seedEmbedded(db, 'port 7777 is the default for API endpoints', 'h-ct-6', vecAt(0, 0.45));

    const summary = await runConsolidation(db, { autoMergeContained: false });
    expect(summary.merged).toHaveLength(0);
    expect(summary.proposed).toHaveLength(1);
  });

  it('sweeps EXISTING pending proposals whose loser is contained in the winner', async () => {
    // Queue a proposal first with containment disabled.
    const winner = await seedEmbedded(db, 'port 7777 is the default for API endpoints', 'h-ct-7', vecAt(0));
    const loser = await seedEmbedded(db, 'Port 7777 is the default', 'h-ct-8', vecAt(0, 0.45));
    recordRecallUsed(db, { atomId: winner, surface: 'rest', signal: 'explicit' }); // superset wins the row
    const first = await runConsolidation(db, { autoMergeContained: false });
    expect(first.proposed).toHaveLength(1);

    const second = await runConsolidation(db);
    expect(second.autoAcceptedProposals).toHaveLength(1);
    expect(new ProposalRepo(db).list('pending')).toHaveLength(0);
    expect(new MemoryRepo(db).get(loser)!.superseded_by).toBe(winner);
  });

  it('leaves a pending proposal manual when the WINNER is the contained (shorter) text', async () => {
    // Loser holds extra info — accepting would drop it from the active set.
    const shortWinner = await seedEmbedded(db, 'Port 7777 is the default', 'h-ct-9', vecAt(0));
    const longLoser = await seedEmbedded(db, 'port 7777 is the default for API endpoints', 'h-ct-10', vecAt(0, 0.45));
    recordRecallUsed(db, { atomId: shortWinner, surface: 'rest', signal: 'explicit' });
    const first = await runConsolidation(db, { autoMergeContained: false });
    expect(first.proposed).toHaveLength(1);
    expect(first.proposed[0]).toMatchObject({ winner: shortWinner, loser: longLoser });

    const second = await runConsolidation(db, { autoMergeContained: true });
    // The sweep must NOT accept it (winner ⊂ loser)…
    expect(second.autoAcceptedProposals).toHaveLength(0);
    // …but the pair-scan re-encounters the pair and merges it superset-first.
    expect(second.merged).toHaveLength(1);
    expect(second.merged[0]).toMatchObject({ winner: longLoser, loser: shortWinner, reason: 'contained' });
  });
});

describe('runConsolidation autoAcceptThreshold (FEAT-442)', () => {
  let db: DB;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
  });

  it('default (unset) is byte-identical to pre-FEAT-442 behavior — still just a pending proposal', async () => {
    const a = await seedEmbedded(db, 'deploys run at midnight', 'h-aa-1', vecAt(0));
    const b = await seedEmbedded(db, 'deploys run nightly', 'h-aa-2', vecAt(0, 0.45));

    const summary = await runConsolidation(db);
    expect(summary.merged).toHaveLength(0);
    expect(summary.proposed).toHaveLength(1);
    expect(summary.autoAccepted).toHaveLength(0);
    void a; void b;
  });

  it('similarity >= autoAcceptThreshold accepts immediately via the human-accept path, with provenance', async () => {
    const a = await seedEmbedded(db, 'deploys run at midnight', 'h-aa-3', vecAt(0));
    const b = await seedEmbedded(db, 'deploys run nightly', 'h-aa-4', vecAt(0, 0.45));

    const summary = await runConsolidation(db, { autoAcceptThreshold: 0.85 }); // <= proposeThreshold default (0.85)
    expect(summary.proposed).toHaveLength(0);
    expect(summary.merged).toHaveLength(0); // not a mergeThreshold/containment merge
    expect(summary.autoAccepted).toHaveLength(1);
    const entry = summary.autoAccepted[0]!;
    expect([entry.winner, entry.loser].sort()).toEqual([a, b].sort());

    const proposal = new ProposalRepo(db).get(entry.proposalId)!;
    expect(proposal.status).toBe('accepted');

    const loser = new MemoryRepo(db).get(entry.loser)!;
    expect(loser.superseded_by).toBe(entry.winner);
    expect(loser.valid_to).not.toBeNull();

    const supersedeEvent = new MemoryEventRepo(db).listForAtom(entry.loser)
      .find(e => e.event_type === 'supersede')!;
    const payload = JSON.parse(supersedeEvent.payload_json ?? '{}');
    expect(payload).toMatchObject({ auto_accepted: true, threshold: 0.85, similarity: entry.similarity });
  });

  it('similarity below autoAcceptThreshold is unaffected — still a pending proposal', async () => {
    const a = await seedEmbedded(db, 'deploys run at midnight', 'h-aa-5', vecAt(0));
    const b = await seedEmbedded(db, 'deploys run nightly', 'h-aa-6', vecAt(0, 0.45));

    const summary = await runConsolidation(db, { autoAcceptThreshold: 0.95 });
    expect(summary.autoAccepted).toHaveLength(0);
    expect(summary.proposed).toHaveLength(1);
    expect(new MemoryRepo(db).get(a)!.valid_to).toBeNull();
    expect(new MemoryRepo(db).get(b)!.valid_to).toBeNull();
  });

  it('autoAcceptThreshold below proposeThreshold is invalid — disabled for the run (logged, non-fatal)', async () => {
    const a = await seedEmbedded(db, 'deploys run at midnight', 'h-aa-7', vecAt(0));
    const b = await seedEmbedded(db, 'deploys run nightly', 'h-aa-8', vecAt(0, 0.45));
    const logs: string[] = [];

    const summary = await runConsolidation(db, { autoAcceptThreshold: 0.5, log: (m) => logs.push(m) });
    expect(summary.autoAccepted).toHaveLength(0);
    expect(summary.proposed).toHaveLength(1);
    expect(logs.some(m => m.includes('autoAcceptThreshold'))).toBe(true);
    void a; void b;
  });

  it('autoAcceptThreshold > 1 is invalid — disabled for the run (logged, non-fatal)', async () => {
    const a = await seedEmbedded(db, 'deploys run at midnight', 'h-aa-9', vecAt(0));
    const b = await seedEmbedded(db, 'deploys run nightly', 'h-aa-10', vecAt(0, 0.45));
    const logs: string[] = [];

    const summary = await runConsolidation(db, { autoAcceptThreshold: 1.5, log: (m) => logs.push(m) });
    expect(summary.autoAccepted).toHaveLength(0);
    expect(summary.proposed).toHaveLength(1);
    expect(logs.length).toBeGreaterThan(0);
    void a; void b;
  });

  it('reversal round-trip: unsupersede after an auto-accept restores the loser; proposal stays accepted', async () => {
    const a = await seedEmbedded(db, 'deploys run at midnight', 'h-aa-11', vecAt(0));
    const b = await seedEmbedded(db, 'deploys run nightly', 'h-aa-12', vecAt(0, 0.45));

    const summary = await runConsolidation(db, { autoAcceptThreshold: 0.85 });
    const entry = summary.autoAccepted[0]!;

    const events = new MemoryEventRepo(db);
    events.unsupersede(entry.loser, 'threshold was miscalibrated');

    const mems = new MemoryRepo(db);
    expect(mems.get(entry.loser)!.valid_to).toBeNull();
    expect(mems.get(entry.loser)!.superseded_by).toBeNull();
    expect(mems.get(entry.winner)!.valid_to).toBeNull(); // winner untouched — un-hiding, not un-merging

    // The consolidation_proposals audit trail is unaffected by the reversal —
    // it stays 'accepted' (the proposal WAS accepted; unsupersede reverses
    // the atom's currency, not the historical proposal record).
    expect(new ProposalRepo(db).get(entry.proposalId)!.status).toBe('accepted');
    void a; void b;
  });
});

describe('stale-proposal sweep (FEAT-410 follow-up)', () => {
  let db: DB;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
  });

  it('marks a pending proposal accepted when the pair was already merged by the pair-scan, and rejected when unactionable', async () => {
    // Queue two proposals with containment off.
    const w1 = await seedEmbedded(db, 'port 7777 is the default for API endpoints', 'h-st-1', vecAt(0));
    const l1 = await seedEmbedded(db, 'Port 7777 is the default', 'h-st-2', vecAt(0, 0.45));
    recordRecallUsed(db, { atomId: w1, surface: 'rest', signal: 'explicit' });
    const w2 = await seedEmbedded(db, 'deploys run at midnight', 'h-st-3', vecAt(2));
    const l2 = await seedEmbedded(db, 'deploys run nightly', 'h-st-4', vecAt(2, 0.45));
    recordRecallUsed(db, { atomId: w2, surface: 'rest', signal: 'explicit' });
    const first = await runConsolidation(db, { autoMergeContained: false });
    expect(first.proposed).toHaveLength(2);

    // Pair 1's work happens out-of-band (same as the scheduled consolidate
    // job's pair-scan): loser superseded by winner directly.
    mergeAsSupersede(db, w1, l1, undefined, 'consolidation_auto');
    // Pair 2's loser becomes unactionable for a different reason: superseded
    // by an unrelated atom.
    const other = await seedEmbedded(db, 'unrelated survivor', 'h-st-5', vecAt(7));
    mergeAsSupersede(db, other, l2, undefined, 'consolidation_auto');

    const second = await runConsolidation(db);
    expect(second.autoAcceptedProposals).toHaveLength(1);   // pair 1: already done
    expect(second.staleRejectedProposals).toHaveLength(1);  // pair 2: unactionable
    const repo = new ProposalRepo(db);
    expect(repo.list('pending')).toHaveLength(0);
    // No double-merge attempted: w1 lineage contains l1 exactly once.
    expect(new MemoryRepo(db).get(l1)!.superseded_by).toBe(w1);
  });
});

describe('contradiction detection (FEAT-456 SLICE-1)', () => {
  let db: DB;
  // The mock judge's deterministic vocabulary (src/consolidate/mock-judge-pairs.ts)
  // is exact-text keyed — the texts seeded below are taken verbatim from that
  // table so the judge branch never falls back to the {unrelated, 0.5} default.
  const judgeProvider = makeMockProviders().llm.extraction;
  /** Default maxWallClockMs for tests that don't care about the wall-clock
   *  cap itself — long enough that no test here could plausibly hit it. */
  const MAX_WALL_CLOCK_MS = 60_000;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
  });

  /**
   * Seeds two atoms with a controlled cosine similarity (via `tilt`, same
   * technique as the module-level `vecAt` helper) and EXPLICIT,
   * strictly-ordered `created_at` timestamps — direct UPDATEs, not relying
   * on wall-clock insert order, so winner/loser assignment
   * (`a.created_at >= b.created_at`) is deterministic regardless of
   * test-machine clock resolution (two seedEmbedded calls could otherwise
   * tie at 1ms resolution).
   */
  async function seedPair(
    textA: string, textB: string, hashPrefix: string, tilt = 1.02, repo = 'r1',
  ): Promise<{ older: string; newer: string }> {
    const older = await seedEmbedded(db, textA, `${hashPrefix}-a`, vecAt(0), { repo });
    const newer = await seedEmbedded(db, textB, `${hashPrefix}-b`, vecAt(0, tilt), { repo });
    db.prepare('UPDATE memories SET created_at = ? WHERE id = ?').run(1_000, older);
    db.prepare('UPDATE memories SET created_at = ? WHERE id = ?').run(2_000, newer);
    return { older, newer };
  }

  it('AC-1: mode off (default) makes no judge call — output matches pre-FEAT-456 behavior', async () => {
    // P2 (contradicts, confidence 0.92) at sim ~0.70 — inside the default
    // judge band [0.6, 0.85) but below proposeThreshold, so it's also
    // invisible to the merge tier either way.
    await seedPair('Default port is 7777.', 'Default port is now 8888.', 'h-ac1');
    const summary = await runConsolidation(db); // no contradictionDetection opt at all
    expect(summary.contradictionsPreviewed).toHaveLength(0);
    expect(summary.contradictionsProposed).toHaveLength(0);
    expect(summary.contradictionCapReached).toBe(false);
    expect(summary.proposed).toHaveLength(0);
    expect(new ProposalRepo(db).list()).toHaveLength(0);
  });

  // Silent-error audit (2026-07-13): judgeCallsExecuted alone only proves the
  // judge was invoked, not that it produced a real verdict — a systemically
  // broken judge provider makes every call fall back to 'unrelated' and
  // would otherwise be indistinguishable from "genuinely no contradictions
  // found" in consolidation_judge_runs (same failure shape as issues
  // #190/#200). runConsolidation must persist judgeErrors alongside
  // judgeCalls so doctor's "Consolidation judge" check can tell the two apart.
  it('a judge provider that always throws — judgeErrors == judgeCalls in the persisted run row', async () => {
    await seedPair('Default port is 7777.', 'Default port is now 8888.', 'h-brokenjudge');
    const brokenJudgeProvider: LLMProvider = {
      name: 'ollama',
      model: 'broken-test-model',
      chat: async () => { throw new Error('judge provider unreachable (test)'); },
      health: async () => ({ ok: true, model: 'broken-test-model', latency_ms: 0 }),
    };
    const summary = await runConsolidation(db, {
      contradictionDetection: { mode: 'enabled', minSimilarity: 0.6, minConfidence: 0.7, maxPerRun: 200, maxWallClockMs: MAX_WALL_CLOCK_MS },
      judgeProvider: brokenJudgeProvider,
    });
    expect(summary.judgeCallsExecuted).toBe(1);
    // The judge failing means the pair falls through to the merge-tier
    // classification unchanged, never a contradiction proposal.
    expect(summary.contradictionsProposed).toHaveLength(0);

    const latest = latestConsolidationJudgeRun(db);
    expect(latest?.judgeCalls).toBe(1);
    expect(latest?.judgeErrors).toBe(1);
  });

  it('AC-2: dry-run mode previews a confident contradiction without writing a row', async () => {
    const { older, newer } = await seedPair('Default port is 7777.', 'Default port is now 8888.', 'h-ac2');
    const summary = await runConsolidation(db, {
      contradictionDetection: { mode: 'dry-run', minSimilarity: 0.6, minConfidence: 0.7, maxPerRun: 200, maxWallClockMs: MAX_WALL_CLOCK_MS },
      judgeProvider,
    });
    expect(summary.contradictionsPreviewed).toHaveLength(1);
    expect(summary.contradictionsPreviewed[0]).toMatchObject({ winner: newer, loser: older });
    expect(summary.contradictionsPreviewed[0]!.verdict).toMatchObject({ verdict: 'contradicts', confidence: 0.92 });
    expect(summary.contradictionsProposed).toHaveLength(0);
    expect(new ProposalRepo(db).list()).toHaveLength(0);
  });

  it('AC-3: enabled mode writes exactly one kind=contradiction proposal, winner=newer/loser=older', async () => {
    const { older, newer } = await seedPair('Default port is 7777.', 'Default port is now 8888.', 'h-ac3');
    const summary = await runConsolidation(db, {
      contradictionDetection: { mode: 'enabled', minSimilarity: 0.6, minConfidence: 0.7, maxPerRun: 200, maxWallClockMs: MAX_WALL_CLOCK_MS },
      judgeProvider,
    });
    expect(summary.contradictionsProposed).toHaveLength(1);
    expect(summary.contradictionsProposed[0]).toMatchObject({ winner: newer, loser: older });

    const pending = new ProposalRepo(db).list('pending');
    expect(pending).toHaveLength(1);
    const p = pending[0]!;
    expect(p.kind).toBe('contradiction');
    expect(p.winner_id).toBe(newer);
    expect(p.loser_id).toBe(older);
    expect(p.status).toBe('pending');
    const meta = parseContradictionMetadata(p);
    expect(meta).toMatchObject({ verdict: 'contradicts', confidence: 0.92 });
    expect(meta!.winner_excerpt).toBe('Default port is now 8888.');
    expect(meta!.loser_excerpt).toBe('Default port is 7777.');
  });

  it('AC-4: an existing pending merge proposal blocks a second contradiction row for the same pair', async () => {
    // P5 (contradicts, confidence 0.95) at sim ~0.894 — propose-tier band.
    const { older, newer } = await seedPair(
      'The daemon binds to port 7777.', 'The daemon now binds to port 9999.', 'h-ac4', 0.5,
    );
    // Run 1: contradiction detection off — propose-tier sim creates a 'merge' proposal.
    const first = await runConsolidation(db);
    expect(first.proposed).toHaveLength(1);
    const mergeProposal = new ProposalRepo(db).list('pending')[0]!;
    expect(mergeProposal.kind).toBe('merge');

    // Run 2: contradiction detection enabled — judge sees the same pair,
    // confidently labels it contradicts, but the unique-pending-pair index
    // (no `kind` predicate) already holds one row for this unordered pair.
    const second = await runConsolidation(db, {
      contradictionDetection: { mode: 'enabled', minSimilarity: 0.6, minConfidence: 0.7, maxPerRun: 200, maxWallClockMs: MAX_WALL_CLOCK_MS },
      judgeProvider,
    });
    expect(second.contradictionsProposed).toHaveLength(0);
    const pending = new ProposalRepo(db).list('pending');
    expect(pending).toHaveLength(1);
    expect(pending[0]!.id).toBe(mergeProposal.id);
    expect(pending[0]!.kind).toBe('merge'); // unchanged
    void older; void newer;
  });

  it('AC-5: contradicts below minConfidence creates no proposal of either kind', async () => {
    // P2 confidence is 0.92 — set the run's bar above that.
    await seedPair('Default port is 7777.', 'Default port is now 8888.', 'h-ac5');
    const summary = await runConsolidation(db, {
      contradictionDetection: { mode: 'enabled', minSimilarity: 0.6, minConfidence: 0.95, maxPerRun: 200, maxWallClockMs: MAX_WALL_CLOCK_MS },
      judgeProvider,
    });
    expect(summary.contradictionsProposed).toHaveLength(0);
    expect(summary.contradictionsPreviewed).toHaveLength(0);
    expect(summary.proposed).toHaveLength(0); // sim < proposeThreshold too — falls through cleanly
    expect(new ProposalRepo(db).list()).toHaveLength(0);
  });

  it('AC-6: judge verdict agrees/refines lets the merge-tier proposal fire unchanged; unrelated blocks it', async () => {
    // P1 (agrees) at propose-tier sim ~0.894 — merge-tier path must fire exactly as if
    // contradiction detection were off.
    await seedPair('Port 7777 is the default.', 'The default port is 7777.', 'h-ac6a', 0.5);
    const agrees = await runConsolidation(db, {
      contradictionDetection: { mode: 'enabled', minSimilarity: 0.6, minConfidence: 0.7, maxPerRun: 200, maxWallClockMs: MAX_WALL_CLOCK_MS },
      judgeProvider,
    });
    expect(agrees.contradictionsProposed).toHaveLength(0);
    expect(agrees.proposed).toHaveLength(1);
    expect(new ProposalRepo(db).list('pending')[0]!.kind).toBe('merge');
  });

  it('AC-6b: judge verdict unrelated creates neither kind, even at propose-tier similarity', async () => {
    // P4 (unrelated) at propose-tier sim ~0.894 — without a judge this cosine
    // alone would become a 'merge' proposal; the judge overrides it away.
    await seedPair('Config lives in %APPDATA%\\Astramem.', 'Ollama must be running locally.', 'h-ac6b', 0.5);
    const summary = await runConsolidation(db, {
      contradictionDetection: { mode: 'enabled', minSimilarity: 0.6, minConfidence: 0.7, maxPerRun: 200, maxWallClockMs: MAX_WALL_CLOCK_MS },
      judgeProvider,
    });
    expect(summary.contradictionsProposed).toHaveLength(0);
    expect(summary.proposed).toHaveLength(0);
    expect(new ProposalRepo(db).list()).toHaveLength(0);
  });

  it('AC-7: judge calls are capped at maxPerRun; remaining pairs fall through, cap flag set', async () => {
    // Two independent (repo, type) groups, one judge-eligible pair each —
    // r1 sorts before r2, so the pair-scan visits r1's pair first.
    await seedPair('Default port is 7777.', 'Default port is now 8888.', 'h-ac7-r1', 1.02, 'r1');
    await seedPair('The daemon binds to port 7777.', 'The daemon now binds to port 9999.', 'h-ac7-r2', 1.02, 'r2');
    const summary = await runConsolidation(db, {
      contradictionDetection: { mode: 'dry-run', minSimilarity: 0.6, minConfidence: 0.7, maxPerRun: 1, maxWallClockMs: MAX_WALL_CLOCK_MS },
      judgeProvider,
    });
    expect(summary.contradictionsPreviewed).toHaveLength(1); // only the first pair got judged
    expect(summary.contradictionCapReached).toBe(true);
    expect(summary.contradictionWallClockCapReached).toBe(false);
  });

  it('FEAT-482: judge sweep is halted once maxWallClockMs elapses; remaining pairs fall through, wall-clock flag set', async () => {
    // Two independent (repo, type) groups, one judge-eligible pair each —
    // r1 sorts before r2, so the pair-scan visits r1's pair first.
    await seedPair('Default port is 7777.', 'Default port is now 8888.', 'h-wallclock-r1', 1.02, 'r1');
    await seedPair('The daemon binds to port 7777.', 'The daemon now binds to port 9999.', 'h-wallclock-r2', 1.02, 'r2');
    // A judgeProvider whose first call takes long enough that the sweep's
    // elapsed time is already past a near-zero maxWallClockMs by the time
    // the SECOND pair is checked — proves the wall-clock check actually
    // gates dispatch, not just a value that happens to be set.
    const slowJudgeProvider: LLMProvider = {
      name: 'ollama' as const,
      model: 'test-model',
      async chat(_messages: ChatMsg[], _opts?: ChatOpts): Promise<ChatResult> {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return { text: JSON.stringify({ verdict: 'contradicts', confidence: 0.92 }), usage: { in: 10, out: 10, usd: 0 } };
      },
      async health(): Promise<LLMHealth> {
        return { ok: true, model: 'test-model', latency_ms: 0 };
      },
    };
    // 25ms: comfortably above the sync DB-setup work before the first judge
    // call (single-digit ms), comfortably below the slow provider's 50ms
    // delay — so pair 1 is dispatched (elapsed < 25ms at that check), and by
    // the time pair 2 is checked the elapsed time (>= the 50ms the first
    // call took) has cleared the cap.
    const summary = await runConsolidation(db, {
      contradictionDetection: { mode: 'dry-run', minSimilarity: 0.6, minConfidence: 0.7, maxPerRun: 200, maxWallClockMs: 25 },
      judgeProvider: slowJudgeProvider,
    });
    expect(summary.contradictionsPreviewed).toHaveLength(1); // only the first pair got judged
    expect(summary.contradictionCapReached).toBe(false);
    expect(summary.contradictionWallClockCapReached).toBe(true);
  });

  it('an invalid minSimilarity (>= mergeThreshold) disables contradiction detection for the run, logged non-fatal', async () => {
    await seedPair('Default port is 7777.', 'Default port is now 8888.', 'h-ac-inv1');
    const logs: string[] = [];
    const summary = await runConsolidation(db, {
      contradictionDetection: { mode: 'enabled', minSimilarity: 0.95, minConfidence: 0.7, maxPerRun: 200, maxWallClockMs: MAX_WALL_CLOCK_MS },
      judgeProvider,
      log: (m) => logs.push(m),
    });
    expect(summary.contradictionsProposed).toHaveLength(0);
    expect(logs.some(m => m.includes('minSimilarity'))).toBe(true);
  });

  it('a missing judgeProvider with mode on disables contradiction detection for the run, logged non-fatal', async () => {
    await seedPair('Default port is 7777.', 'Default port is now 8888.', 'h-ac-inv2');
    const logs: string[] = [];
    const summary = await runConsolidation(db, {
      contradictionDetection: { mode: 'enabled', minSimilarity: 0.6, minConfidence: 0.7, maxPerRun: 200, maxWallClockMs: MAX_WALL_CLOCK_MS },
      // no judgeProvider
      log: (m) => logs.push(m),
    });
    expect(summary.contradictionsProposed).toHaveLength(0);
    expect(logs.some(m => m.includes('judgeProvider'))).toBe(true);
  });

  it('FEAT-482: judge sweep telemetry (call count + wall-clock elapsed) is recorded and readable back', async () => {
    // Since dollars can't bound this judge (both shipped providers report
    // usage.usd: 0 — see contradiction-judge.ts's doc comment), the run
    // records call count + elapsed time instead, for doctor to surface.
    await seedPair('Default port is 7777.', 'Default port is now 8888.', 'h-telemetry');
    const summary = await runConsolidation(db, {
      contradictionDetection: { mode: 'enabled', minSimilarity: 0.6, minConfidence: 0.7, maxPerRun: 200, maxWallClockMs: MAX_WALL_CLOCK_MS },
      judgeProvider,
    });
    expect(summary.judgeCallsExecuted).toBe(1);
    expect(summary.judgeSweepElapsedMs).toBeGreaterThanOrEqual(0);

    const latest = latestConsolidationJudgeRun(db);
    expect(latest).not.toBeNull();
    expect(latest!.mode).toBe('enabled');
    expect(latest!.judgeCalls).toBe(1);
    expect(latest!.capReached).toBe(false);
    expect(latest!.wallClockCapReached).toBe(false);
  });

  it('FEAT-482: no telemetry row is written when contradiction detection is off', async () => {
    await seedPair('Default port is 7777.', 'Default port is now 8888.', 'h-telemetry-off');
    await runConsolidation(db); // no contradictionDetection opt at all
    expect(latestConsolidationJudgeRun(db)).toBeNull();
  });
});

describe('dup-judge sweep (FEAT-549)', () => {
  let db: DB;
  const MAX_WALL_CLOCK_MS = 60_000;
  const DEFAULT_CAPS = { batchSize: 20, maxPerRun: 200, maxWallClockMs: MAX_WALL_CLOCK_MS };

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
  });

  /** Seeds two atoms at propose-tier cosine similarity (~0.90, inside
   *  [0.85, 0.92)) so the pairwise scan creates exactly one pending
   *  `kind='merge'` proposal for the dup-judge sweep to see. */
  async function seedProposeTierPair(
    textA: string, textB: string, hashPrefix: string, axis = 0,
  ): Promise<{ a: string; b: string }> {
    const a = await seedEmbedded(db, textA, `${hashPrefix}-a`, vecAt(axis));
    const b = await seedEmbedded(db, textB, `${hashPrefix}-b`, vecAt(axis, 0.45));
    return { a, b };
  }

  function verdictProvider(
    verdict: 'same-fact-merge' | 'distinct-keep-separate' | 'unclear-leave-pending',
    confidence: number,
  ): LLMProvider {
    return {
      name: 'ollama',
      model: 'test-dup-judge-model',
      async chat(_messages: ChatMsg[], _opts?: ChatOpts): Promise<ChatResult> {
        return {
          text: JSON.stringify({ verdicts: [{ index: 0, verdict, confidence }] }),
          usage: { in: 10, out: 10, usd: 0 },
        };
      },
      async health(): Promise<LLMHealth> {
        return { ok: true, model: 'test-dup-judge-model', latency_ms: 0 };
      },
    };
  }

  it("AC-2: mode 'off' (default) makes no dup-judge call — pending proposal untouched, byte-identical to pre-FEAT-549", async () => {
    await seedProposeTierPair('Deploys run at midnight.', 'Deploys run nightly.', 'h-off');
    const summary = await runConsolidation(db); // no dupJudge opt at all
    expect(summary.dupJudgeCallsExecuted).toBe(0);
    expect(summary.dupJudgeResolved).toHaveLength(0);
    expect(summary.dupJudgeVerdictsPreviewed).toHaveLength(0);
    const pending = new ProposalRepo(db).list('pending');
    expect(pending).toHaveLength(1);
    expect(pending[0]!.kind).toBe('merge');
    expect(pending[0]!.metadata_json).toBeNull();
  });

  it("AC-2: mode 'dry-run' previews the verdict but changes NOTHING", async () => {
    await seedProposeTierPair('Deploys run at midnight.', 'Deploys run nightly.', 'h-dryrun');
    const summary = await runConsolidation(db, {
      dupJudge: { mode: 'dry-run', minConfidence: 0.7, ...DEFAULT_CAPS },
      dupJudgeProvider: verdictProvider('same-fact-merge', 0.95),
    });
    expect(summary.dupJudgeCallsExecuted).toBe(1);
    expect(summary.dupJudgeVerdictsPreviewed).toHaveLength(1);
    expect(summary.dupJudgeVerdictsPreviewed[0]).toMatchObject({ verdict: 'same-fact-merge', confidence: 0.95 });
    expect(summary.dupJudgeResolved).toHaveLength(0);
    const pending = new ProposalRepo(db).list('pending');
    expect(pending).toHaveLength(1); // still pending — dry-run never resolves
    expect(pending[0]!.metadata_json).toBeNull();
  });

  it("AC-2: mode 'enabled' + confident 'same-fact-merge' auto-accepts (merges) the proposal", async () => {
    const { a, b } = await seedProposeTierPair('Deploys run at midnight.', 'Deploys run nightly.', 'h-merge');
    const summary = await runConsolidation(db, {
      dupJudge: { mode: 'enabled', minConfidence: 0.7, ...DEFAULT_CAPS },
      dupJudgeProvider: verdictProvider('same-fact-merge', 0.95),
    });
    expect(summary.dupJudgeResolved).toHaveLength(1);
    expect(summary.dupJudgeResolved[0]).toMatchObject({ verdict: 'same-fact-merge', confidence: 0.95, action: 'merged' });
    expect(new ProposalRepo(db).list('pending')).toHaveLength(0);
    const accepted = new ProposalRepo(db).list('accepted')[0]!;
    expect(accepted.status).toBe('accepted');
    // One of the two atoms is now superseded (merge-as-supersede executed).
    const repo = new MemoryRepo(db);
    const aRow = repo.get(a)!, bRow = repo.get(b)!;
    expect(aRow.valid_to !== null || bRow.valid_to !== null).toBe(true);
  });

  it("AC-2: mode 'enabled' + confident 'distinct-keep-separate' rejects (keeps separate) without merging", async () => {
    const { a, b } = await seedProposeTierPair('The API rate limit is 100 rpm.', 'The API rate limit resets every minute.', 'h-keepsep');
    const summary = await runConsolidation(db, {
      dupJudge: { mode: 'enabled', minConfidence: 0.7, ...DEFAULT_CAPS },
      dupJudgeProvider: verdictProvider('distinct-keep-separate', 0.9),
    });
    expect(summary.dupJudgeResolved).toHaveLength(1);
    expect(summary.dupJudgeResolved[0]).toMatchObject({ verdict: 'distinct-keep-separate', confidence: 0.9, action: 'kept-separate' });
    expect(new ProposalRepo(db).list('pending')).toHaveLength(0);
    const rejected = new ProposalRepo(db).list('rejected')[0]!;
    expect(rejected.status).toBe('rejected');
    // Neither atom was merged/superseded — both stay independently valid.
    const repo = new MemoryRepo(db);
    expect(repo.get(a)!.valid_to).toBeNull();
    expect(repo.get(b)!.valid_to).toBeNull();
  });

  it("AC-2: 'unclear-leave-pending' leaves the proposal pending, unchanged", async () => {
    await seedProposeTierPair('Config lives in %APPDATA%.', 'Ollama runs locally.', 'h-unclear');
    const summary = await runConsolidation(db, {
      dupJudge: { mode: 'enabled', minConfidence: 0.7, ...DEFAULT_CAPS },
      dupJudgeProvider: verdictProvider('unclear-leave-pending', 0.99),
    });
    expect(summary.dupJudgeResolved).toHaveLength(0);
    const pending = new ProposalRepo(db).list('pending');
    expect(pending).toHaveLength(1);
    expect(pending[0]!.metadata_json).toBeNull();
  });

  it('AC-2: a verdict below minConfidence leaves the proposal pending, unchanged', async () => {
    await seedProposeTierPair('Deploys run at midnight.', 'Deploys run nightly.', 'h-lowconf');
    const summary = await runConsolidation(db, {
      dupJudge: { mode: 'enabled', minConfidence: 0.95, ...DEFAULT_CAPS },
      dupJudgeProvider: verdictProvider('same-fact-merge', 0.8), // below the 0.95 bar
    });
    expect(summary.dupJudgeResolved).toHaveLength(0);
    expect(new ProposalRepo(db).list('pending')).toHaveLength(1);
  });

  it("AC-4: a same-fact-merge resolution records resolved_by/verdict/confidence/provider/model provenance in metadata_json", async () => {
    await seedProposeTierPair('Deploys run at midnight.', 'Deploys run nightly.', 'h-ac4-merge');
    await runConsolidation(db, {
      dupJudge: { mode: 'enabled', minConfidence: 0.7, ...DEFAULT_CAPS },
      dupJudgeProvider: verdictProvider('same-fact-merge', 0.95),
    });
    const accepted = new ProposalRepo(db).list('accepted')[0]!;
    const meta = parseDupJudgeMetadata(accepted);
    expect(meta).toMatchObject({
      resolved_by: 'dup-judge', verdict: 'same-fact-merge', confidence: 0.95,
      provider: 'ollama', model: 'test-dup-judge-model',
    });
  });

  it("AC-4: a distinct-keep-separate resolution records the same provenance shape, and is distinguishable from a human resolve in the same query", async () => {
    await seedProposeTierPair('The API rate limit is 100 rpm.', 'The API rate limit resets every minute.', 'h-ac4-keepsep');
    await runConsolidation(db, {
      dupJudge: { mode: 'enabled', minConfidence: 0.7, ...DEFAULT_CAPS },
      dupJudgeProvider: verdictProvider('distinct-keep-separate', 0.9),
    });
    const rejected = new ProposalRepo(db).list('rejected')[0]!;
    const meta = parseDupJudgeMetadata(rejected);
    expect(meta).toMatchObject({ resolved_by: 'dup-judge', verdict: 'distinct-keep-separate', confidence: 0.9 });

    // Contrast: a human-resolved proposal (no dup-judge involved at all)
    // has metadata_json NULL — the absence IS the audit signal (AC-4).
    await seedProposeTierPair('Human resolved pair.', 'Human resolved pair variant.', 'h-ac4-human', 50);
    await runConsolidation(db); // dupJudge off — creates a second pending proposal
    const humanPending = new ProposalRepo(db).list('pending')[0]!;
    new ProposalRepo(db).reject(humanPending.id); // no metadata passed — human path
    const humanResolved = new ProposalRepo(db).get(humanPending.id)!;
    expect(parseDupJudgeMetadata(humanResolved)).toBeNull();
    expect(humanResolved.metadata_json).toBeNull();
  });

  // AC-1's fail-open contract: a judge provider that throws must leave
  // every proposal in the affected batch pending, unchanged — proven
  // directly here (not just at the dupJudgeBatch unit-test level).
  it('AC-1: a dup-judge provider that always throws leaves the proposal pending, unchanged (fail-open)', async () => {
    await seedProposeTierPair('Deploys run at midnight.', 'Deploys run nightly.', 'h-fail-open');
    const throwingProvider: LLMProvider = {
      name: 'ollama',
      model: 'broken-test-model',
      chat: async () => { throw new Error('dup-judge provider unreachable (test)'); },
      health: async () => ({ ok: true, model: 'broken-test-model', latency_ms: 0 }),
    };
    const summary = await runConsolidation(db, {
      dupJudge: { mode: 'enabled', minConfidence: 0.7, ...DEFAULT_CAPS },
      dupJudgeProvider: throwingProvider,
    });
    expect(summary.dupJudgeCallsExecuted).toBe(1);
    expect(summary.dupJudgeResolved).toHaveLength(0);
    const pending = new ProposalRepo(db).list('pending');
    expect(pending).toHaveLength(1);
    expect(pending[0]!.status).toBe('pending');
    expect(pending[0]!.metadata_json).toBeNull();
  });

  it('AC-1: an unparsable dup-judge response leaves the proposal pending, unchanged (fail-open)', async () => {
    await seedProposeTierPair('Deploys run at midnight.', 'Deploys run nightly.', 'h-fail-open-parse');
    const unparsableProvider: LLMProvider = {
      name: 'ollama',
      model: 'broken-test-model',
      chat: async () => ({ text: 'not json', usage: { in: 1, out: 1, usd: 0 } }),
      health: async () => ({ ok: true, model: 'broken-test-model', latency_ms: 0 }),
    };
    const summary = await runConsolidation(db, {
      dupJudge: { mode: 'enabled', minConfidence: 0.7, ...DEFAULT_CAPS },
      dupJudgeProvider: unparsableProvider,
    });
    expect(summary.dupJudgeResolved).toHaveLength(0);
    expect(new ProposalRepo(db).list('pending')).toHaveLength(1);
  });

  it('dup-judge calls are capped at maxPerRun; remaining pending proposals fall through, cap flag set', async () => {
    await seedProposeTierPair('Deploys run at midnight.', 'Deploys run nightly.', 'h-cap-r1', 0);
    await seedProposeTierPair('The daemon binds to port 7777.', 'The daemon still binds to port 7777.', 'h-cap-r2', 60);
    // batchSize=1 forces two separate calls (one per proposal); maxPerRun=1
    // caps the sweep after the first.
    const summary = await runConsolidation(db, {
      dupJudge: { mode: 'dry-run', minConfidence: 0.7, batchSize: 1, maxPerRun: 1, maxWallClockMs: MAX_WALL_CLOCK_MS },
      dupJudgeProvider: verdictProvider('same-fact-merge', 0.9),
    });
    expect(summary.dupJudgeCallsExecuted).toBe(1);
    expect(summary.dupJudgeVerdictsPreviewed).toHaveLength(1); // only the first proposal got judged
    expect(summary.dupJudgeCapReached).toBe(true);
    expect(summary.dupJudgeWallClockCapReached).toBe(false);
  });

  it('FEAT-482 mirror: dup-judge sweep is halted once maxWallClockMs elapses; remaining proposals fall through, wall-clock flag set', async () => {
    await seedProposeTierPair('Deploys run at midnight.', 'Deploys run nightly.', 'h-wallclock-r1', 0);
    await seedProposeTierPair('The daemon binds to port 7777.', 'The daemon still binds to port 7777.', 'h-wallclock-r2', 60);
    const slowProvider: LLMProvider = {
      name: 'ollama',
      model: 'test-model',
      async chat(_messages: ChatMsg[], _opts?: ChatOpts): Promise<ChatResult> {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return { text: JSON.stringify({ verdicts: [{ index: 0, verdict: 'same-fact-merge', confidence: 0.9 }] }), usage: { in: 10, out: 10, usd: 0 } };
      },
      async health(): Promise<LLMHealth> {
        return { ok: true, model: 'test-model', latency_ms: 0 };
      },
    };
    const summary = await runConsolidation(db, {
      dupJudge: { mode: 'dry-run', minConfidence: 0.7, batchSize: 1, maxPerRun: 200, maxWallClockMs: 25 },
      dupJudgeProvider: slowProvider,
    });
    expect(summary.dupJudgeVerdictsPreviewed).toHaveLength(1); // only the first proposal got judged
    expect(summary.dupJudgeCapReached).toBe(false);
    expect(summary.dupJudgeWallClockCapReached).toBe(true);
  });

  it('batches multiple pending proposals into ONE call when batchSize allows it', async () => {
    await seedProposeTierPair('Deploys run at midnight.', 'Deploys run nightly.', 'h-batch-r1', 0);
    await seedProposeTierPair('The daemon binds to port 7777.', 'The daemon still binds to port 7777.', 'h-batch-r2', 60);
    let callCount = 0;
    let lastUserContent = '';
    const provider: LLMProvider = {
      name: 'ollama',
      model: 'test-model',
      async chat(messages: ChatMsg[], _opts?: ChatOpts): Promise<ChatResult> {
        callCount++;
        lastUserContent = messages.find((m) => m.role === 'user')?.content ?? '';
        return {
          text: JSON.stringify({
            verdicts: [
              { index: 0, verdict: 'same-fact-merge', confidence: 0.9 },
              { index: 1, verdict: 'distinct-keep-separate', confidence: 0.9 },
            ],
          }),
          usage: { in: 10, out: 10, usd: 0 },
        };
      },
      async health(): Promise<LLMHealth> {
        return { ok: true, model: 'test-model', latency_ms: 0 };
      },
    };
    const summary = await runConsolidation(db, {
      dupJudge: { mode: 'enabled', minConfidence: 0.7, batchSize: 20, maxPerRun: 200, maxWallClockMs: MAX_WALL_CLOCK_MS },
      dupJudgeProvider: provider,
    });
    expect(callCount).toBe(1); // both proposals batched into a single call
    expect(summary.dupJudgeCallsExecuted).toBe(1);
    expect(summary.dupJudgeResolved).toHaveLength(2);
    expect(lastUserContent).toContain('[0]');
    expect(lastUserContent).toContain('[1]');
  });

  it('an invalid minConfidence (out of [0,1]) disables dup-judge for the run, logged non-fatal', async () => {
    await seedProposeTierPair('Deploys run at midnight.', 'Deploys run nightly.', 'h-inv-conf');
    const logs: string[] = [];
    const summary = await runConsolidation(db, {
      dupJudge: { mode: 'enabled', minConfidence: 1.5, ...DEFAULT_CAPS },
      dupJudgeProvider: verdictProvider('same-fact-merge', 0.9),
      log: (m) => logs.push(m),
    });
    expect(summary.dupJudgeCallsExecuted).toBe(0);
    expect(logs.some((m) => m.includes('minConfidence'))).toBe(true);
  });

  it('an invalid batchSize disables dup-judge for the run, logged non-fatal', async () => {
    await seedProposeTierPair('Deploys run at midnight.', 'Deploys run nightly.', 'h-inv-batch');
    const logs: string[] = [];
    const summary = await runConsolidation(db, {
      dupJudge: { mode: 'enabled', minConfidence: 0.7, batchSize: 0, maxPerRun: 200, maxWallClockMs: MAX_WALL_CLOCK_MS },
      dupJudgeProvider: verdictProvider('same-fact-merge', 0.9),
      log: (m) => logs.push(m),
    });
    expect(summary.dupJudgeCallsExecuted).toBe(0);
    expect(logs.some((m) => m.includes('batchSize'))).toBe(true);
  });

  it('a missing dupJudgeProvider with mode on disables dup-judge for the run, logged non-fatal', async () => {
    await seedProposeTierPair('Deploys run at midnight.', 'Deploys run nightly.', 'h-inv-provider');
    const logs: string[] = [];
    const summary = await runConsolidation(db, {
      dupJudge: { mode: 'enabled', minConfidence: 0.7, ...DEFAULT_CAPS },
      // no dupJudgeProvider
      log: (m) => logs.push(m),
    });
    expect(summary.dupJudgeCallsExecuted).toBe(0);
    expect(logs.some((m) => m.includes('dupJudgeProvider'))).toBe(true);
  });

  it("does not touch the >=mergeThreshold auto-merge tier — a pair at sim >= 0.92 is auto-merged before any proposal (or dup-judge call) exists", async () => {
    // Near-identical pair (sim ~0.999) — auto-merges immediately, never
    // becomes a pending 'merge' proposal at all.
    const a = await seedEmbedded(db, 'port is 7777', 'h-automerge-a', vecAt(0, 0.01));
    const b = await seedEmbedded(db, 'the port is 7777', 'h-automerge-b', vecAt(0, 0.02));
    const summary = await runConsolidation(db, {
      dupJudge: { mode: 'enabled', minConfidence: 0.7, ...DEFAULT_CAPS },
      dupJudgeProvider: verdictProvider('distinct-keep-separate', 0.99), // would reject it if it ever saw it
    });
    expect(summary.merged).toHaveLength(1);
    expect(summary.dupJudgeCallsExecuted).toBe(0); // never even called — nothing pending to judge
    const repo = new MemoryRepo(db);
    expect(repo.get(a)!.valid_to !== null || repo.get(b)!.valid_to !== null).toBe(true);
  });
});

describe('cooperative yield in the pairwise scan (ADR-018 Tier 1, issue #347)', () => {
  let db: DB;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
  });

  it('fires the yield hook every yieldEveryNPairs pairs scanned, counting skipped pairs too', async () => {
    // 10 orthogonal atoms in one (repo, type) group → C(10,2) = 45 pairs,
    // every one of them skipped via `sim < proposeThreshold` — this isolates
    // the yield counter from any merge/propose side effect.
    for (let k = 0; k < 10; k++) {
      await seedEmbedded(db, `atom ${k}`, `h-yield-${k}`, vecAt(k));
    }
    let yields = 0;
    const summary = await runConsolidation(db, { yieldEveryNPairs: 5, onYield: () => { yields++; } });
    expect(yields).toBe(9); // floor(45 / 5) — the counter increments once per pair, before any `continue`
    expect(summary.merged).toHaveLength(0);
    expect(summary.proposed).toHaveLength(0);
  });

  it('never yields when the group has fewer pairs than the interval', async () => {
    await seedEmbedded(db, 'a', 'h-yield-small-1', vecAt(0));
    await seedEmbedded(db, 'b', 'h-yield-small-2', vecAt(1));
    let yields = 0;
    await runConsolidation(db, { onYield: () => { yields++; } }); // default interval 200, only 1 pair total
    expect(yields).toBe(0);
  });

  it('yielding every single pair produces the same merge outcome as the default interval (behavior-preserving)', async () => {
    const seedNearDuplicatePair = async (database: DB) => {
      const a = await seedEmbedded(database, 'port is 7777', 'h-yield-eq-1', vecAt(0, 0.01));
      const b = await seedEmbedded(database, 'the port is 7777', 'h-yield-eq-2', vecAt(0, 0.02));
      recordRecallUsed(database, { atomId: b, surface: 'rest', signal: 'explicit' }); // b wins on usefulness
      return { a, b };
    };

    const { a: aDefault, b: bDefault } = await seedNearDuplicatePair(db);
    const summaryDefault = await runConsolidation(db);

    const dbFrequentYield = openDb(':memory:');
    migrate(dbFrequentYield);
    const { a: aFrequent, b: bFrequent } = await seedNearDuplicatePair(dbFrequentYield);
    const summaryFrequentYield = await runConsolidation(dbFrequentYield, { yieldEveryNPairs: 1 });

    expect(summaryDefault.merged).toHaveLength(1);
    expect(summaryFrequentYield.merged).toHaveLength(1);
    expect(summaryDefault.merged[0]).toMatchObject({ winner: bDefault, loser: aDefault });
    expect(summaryFrequentYield.merged[0]).toMatchObject({ winner: bFrequent, loser: aFrequent });
    expect(summaryFrequentYield.merged[0]!.similarity).toBeCloseTo(summaryDefault.merged[0]!.similarity, 10);
  });
});
