// Wave 4b — consolidation stage 9 (ADR-004): merge-as-supersede + propose-only.

import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { MemoryRepo } from '../../src/storage/memories.js';
import { MemoryEventRepo } from '../../src/storage/memory-events.js';
import { SqliteVecStore } from '../../src/vector/sqlite-vec.js';
import { recordRecallUsed } from '../../src/storage/usefulness.js';
import { runConsolidation, mergeAsSupersede } from '../../src/consolidate/consolidate.js';
import { ProposalRepo, parseContradictionMetadata } from '../../src/consolidate/proposals.js';
import { buildApp } from '../../src/server/app.js';
import { makeMockProviders } from '../../src/pipeline/mock-providers.js';

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
    mergeAsSupersede(db, w1, l1);
    // Pair 2's loser becomes unactionable for a different reason: superseded
    // by an unrelated atom.
    const other = await seedEmbedded(db, 'unrelated survivor', 'h-st-5', vecAt(7));
    mergeAsSupersede(db, other, l2);

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

  it('AC-2: dry-run mode previews a confident contradiction without writing a row', async () => {
    const { older, newer } = await seedPair('Default port is 7777.', 'Default port is now 8888.', 'h-ac2');
    const summary = await runConsolidation(db, {
      contradictionDetection: { mode: 'dry-run', minSimilarity: 0.6, minConfidence: 0.7, maxPerRun: 200 },
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
      contradictionDetection: { mode: 'enabled', minSimilarity: 0.6, minConfidence: 0.7, maxPerRun: 200 },
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
      contradictionDetection: { mode: 'enabled', minSimilarity: 0.6, minConfidence: 0.7, maxPerRun: 200 },
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
      contradictionDetection: { mode: 'enabled', minSimilarity: 0.6, minConfidence: 0.95, maxPerRun: 200 },
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
      contradictionDetection: { mode: 'enabled', minSimilarity: 0.6, minConfidence: 0.7, maxPerRun: 200 },
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
      contradictionDetection: { mode: 'enabled', minSimilarity: 0.6, minConfidence: 0.7, maxPerRun: 200 },
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
      contradictionDetection: { mode: 'dry-run', minSimilarity: 0.6, minConfidence: 0.7, maxPerRun: 1 },
      judgeProvider,
    });
    expect(summary.contradictionsPreviewed).toHaveLength(1); // only the first pair got judged
    expect(summary.contradictionCapReached).toBe(true);
  });

  it('an invalid minSimilarity (>= mergeThreshold) disables contradiction detection for the run, logged non-fatal', async () => {
    await seedPair('Default port is 7777.', 'Default port is now 8888.', 'h-ac-inv1');
    const logs: string[] = [];
    const summary = await runConsolidation(db, {
      contradictionDetection: { mode: 'enabled', minSimilarity: 0.95, minConfidence: 0.7, maxPerRun: 200 },
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
      contradictionDetection: { mode: 'enabled', minSimilarity: 0.6, minConfidence: 0.7, maxPerRun: 200 },
      // no judgeProvider
      log: (m) => logs.push(m),
    });
    expect(summary.contradictionsProposed).toHaveLength(0);
    expect(logs.some(m => m.includes('judgeProvider'))).toBe(true);
  });
});
