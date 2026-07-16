// #372/#171 — ProposalRepo pagination/filtering at the repo layer.
// Unit-level: seeds consolidation_proposals rows directly (no FK on
// winner_id/loser_id, see migrations/008-consolidation.sql) rather than
// running the full consolidation pass, so pagination/confidence-filter
// behavior is isolated from candidate selection and threshold logic
// already covered by consolidate.test.ts.

import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { MemoryRepo } from '../../src/storage/memories.js';
import { SqliteVecStore } from '../../src/vector/sqlite-vec.js';
import { runConsolidation } from '../../src/consolidate/consolidate.js';
import { ProposalRepo, proposalConfidence, type ConsolidationProposal } from '../../src/consolidate/proposals.js';

let seq = 0;

/** Inserts a `kind='merge'` pending proposal with a distinct (winner,loser)
 *  pair each call — required by `idx_consolidation_pair_pending`'s unique
 *  index on pending rows. `createdAt` controls list() ordering. */
function seedMergeProposal(db: DB, similarity: number, createdAt: number): string {
  const id = `prop-merge-${++seq}`;
  db.prepare(`
    INSERT INTO consolidation_proposals (id, kind, winner_id, loser_id, similarity, status, created_at, metadata_json)
    VALUES (?, 'merge', ?, ?, ?, 'pending', ?, NULL)
  `).run(id, `w-${seq}`, `l-${seq}`, similarity, createdAt);
  return id;
}

/** Inserts a `kind='contradiction'` pending proposal with the given judge
 *  confidence (or no metadata_json at all when `confidence` is undefined). */
function seedContradictionProposal(db: DB, confidence: number | undefined, createdAt: number): string {
  const id = `prop-contra-${++seq}`;
  const metadata = confidence === undefined ? null : JSON.stringify({
    verdict: 'contradicts', confidence, winner_excerpt: 'a', loser_excerpt: 'b',
  });
  db.prepare(`
    INSERT INTO consolidation_proposals (id, kind, winner_id, loser_id, similarity, status, created_at, metadata_json)
    VALUES (?, 'contradiction', ?, ?, ?, 'pending', ?, ?)
  `).run(id, `w-${seq}`, `l-${seq}`, 0.5, createdAt, metadata);
  return id;
}

describe('proposalConfidence', () => {
  it('is the similarity column for kind=merge', () => {
    const p = { kind: 'merge', similarity: 0.87, metadata_json: null } as ConsolidationProposal;
    expect(proposalConfidence(p)).toBe(0.87);
  });

  it('is the parsed judge confidence for kind=contradiction', () => {
    const p = {
      kind: 'contradiction', similarity: 0.5,
      metadata_json: JSON.stringify({ verdict: 'contradicts', confidence: 0.92, winner_excerpt: 'a', loser_excerpt: 'b' }),
    } as ConsolidationProposal;
    expect(proposalConfidence(p)).toBe(0.92);
  });

  it('falls back to 0 for a kind=contradiction row with no/unparsable metadata_json', () => {
    const missing = { kind: 'contradiction', similarity: 0.5, metadata_json: null } as ConsolidationProposal;
    const broken = { kind: 'contradiction', similarity: 0.5, metadata_json: 'not json' } as ConsolidationProposal;
    expect(proposalConfidence(missing)).toBe(0);
    expect(proposalConfidence(broken)).toBe(0);
  });
});

describe('ProposalRepo.list — pagination and minConfidence (#372/#171)', () => {
  let db: DB;
  let repo: ProposalRepo;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    repo = new ProposalRepo(db);
  });

  it('existing two-arg callers are unaffected (opts omitted = no limit/offset/filter)', () => {
    const a = seedMergeProposal(db, 0.9, 1000);
    const b = seedMergeProposal(db, 0.95, 2000);
    const rows = repo.list('pending');
    expect(rows.map(r => r.id)).toEqual([a, b]); // created_at ASC, unchanged order
  });

  it('limit caps the returned rows without affecting total via count()', () => {
    for (let i = 0; i < 5; i++) seedMergeProposal(db, 0.9, 1000 + i);
    const page = repo.list('pending', undefined, { limit: 2 });
    expect(page).toHaveLength(2);
    expect(repo.count('pending')).toBe(5);
  });

  it('offset skips rows, preserving created_at ASC order', () => {
    const ids = Array.from({ length: 4 }, (_, i) => seedMergeProposal(db, 0.9, 1000 + i));
    const page = repo.list('pending', undefined, { offset: 2 });
    expect(page.map(r => r.id)).toEqual(ids.slice(2));
  });

  it('offset + limit together page through the full set with no gaps or overlap', () => {
    const ids = Array.from({ length: 5 }, (_, i) => seedMergeProposal(db, 0.9, 1000 + i));
    const page1 = repo.list('pending', undefined, { limit: 2, offset: 0 });
    const page2 = repo.list('pending', undefined, { limit: 2, offset: 2 });
    const page3 = repo.list('pending', undefined, { limit: 2, offset: 4 });
    expect([...page1, ...page2, ...page3].map(r => r.id)).toEqual(ids);
  });

  it('minConfidence filters kind=merge rows on the similarity column', () => {
    const low = seedMergeProposal(db, 0.80, 1000);
    const high = seedMergeProposal(db, 0.95, 2000);
    const rows = repo.list('pending', undefined, { minConfidence: 0.9 });
    expect(rows.map(r => r.id)).toEqual([high]);
    expect(rows.map(r => r.id)).not.toContain(low);
  });

  it('minConfidence filters kind=contradiction rows on the parsed metadata_json confidence, not similarity', () => {
    // similarity is deliberately low (0.5) on both — confidence must come
    // from metadata_json, not the similarity column, for this kind.
    const low = seedContradictionProposal(db, 0.4, 1000);
    const high = seedContradictionProposal(db, 0.93, 2000);
    const rows = repo.list('pending', undefined, { minConfidence: 0.9 });
    expect(rows.map(r => r.id)).toEqual([high]);
    expect(rows.map(r => r.id)).not.toContain(low);
  });

  it('a contradiction row with no metadata_json is excluded by any positive minConfidence floor', () => {
    const noMeta = seedContradictionProposal(db, undefined, 1000);
    const rows = repo.list('pending', undefined, { minConfidence: 0.01 });
    expect(rows.map(r => r.id)).not.toContain(noMeta);
  });

  it('minConfidence and limit/offset compose: filter first, then slice', () => {
    for (let i = 0; i < 3; i++) seedMergeProposal(db, 0.5, 1000 + i); // below floor
    const ids = Array.from({ length: 4 }, (_, i) => seedMergeProposal(db, 0.9, 2000 + i)); // above floor
    const page = repo.list('pending', undefined, { minConfidence: 0.8, limit: 2, offset: 1 });
    expect(page.map(r => r.id)).toEqual(ids.slice(1, 3));
  });
});

describe('ProposalRepo.count — matches list() minus the limit/offset slice', () => {
  let db: DB;
  let repo: ProposalRepo;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    repo = new ProposalRepo(db);
  });

  it('counts all matching rows regardless of any limit/offset a caller might apply separately', () => {
    for (let i = 0; i < 7; i++) seedMergeProposal(db, 0.9, 1000 + i);
    expect(repo.count('pending')).toBe(7);
    expect(repo.list('pending', undefined, { limit: 3 })).toHaveLength(3);
  });

  it('respects minConfidence the same way list() does', () => {
    for (let i = 0; i < 3; i++) seedMergeProposal(db, 0.5, 1000 + i);
    for (let i = 0; i < 4; i++) seedMergeProposal(db, 0.95, 2000 + i);
    expect(repo.count('pending', undefined, 0.9)).toBe(4);
  });
});

// #372 scope update (2026-07-16): consolidation.candidateSelection=knn is now
// LIVE in prod (shipped default stays 'full' — no default change). The ops
// surface built by this slice must be proven under BOTH modes, knn as the
// primary case, since knn is what prod actually runs and its rerun against
// previously-skipped groups is expected to push the pending queue well past
// the 768 this slice was scoped against. Unlike the describe blocks above
// (which insert consolidation_proposals rows directly, isolating pagination
// from candidate-selection logic), these seed real atoms and go through a
// REAL runConsolidation() pass — the ops surface is exercised against
// proposals actually produced by each selection mode, not synthetic rows.
describe('ProposalRepo pagination/minConfidence against real runConsolidation() output — both candidateSelection modes (#372)', () => {
  /** Unit vector on `axis`, tilted toward axis 0 by `tilt` — mirrors
   *  tests/consolidate/consolidate.test.ts's `vecAt`. Distinct axes per pair
   *  keep every pair mutually orthogonal (cosine ~0 cross-pair), so knn's
   *  top-1 neighbor for any atom is unambiguously its own pair-mate even at
   *  knnK=1, while the within-pair tilt lands at the borderline
   *  propose-tier similarity (~0.90, inside the default [0.85, 0.92) band)
   *  — a PENDING proposal, not an auto-merge, for both 'full' and 'knn'. */
  function vecAt(axis: number, tilt = 0): Float32Array {
    const v = new Float32Array(1024);
    v[axis] = 1;
    if (tilt > 0) v[0] = tilt;
    return v;
  }

  /** Seeds `n` independent borderline-similarity pairs (2n atoms, one group)
   *  and runs consolidation with the given `candidateSelection`, returning
   *  the DB for the caller to query via ProposalRepo. */
  async function seedAndRunConsolidation(candidateSelection: 'full' | 'knn', n: number): Promise<DB> {
    const db = openDb(':memory:');
    migrate(db);
    const memRepo = new MemoryRepo(db);
    const vecStore = new SqliteVecStore(db);
    for (let i = 0; i < n; i++) {
      const w = memRepo.insert({
        type: 'fact', text: `knn-mode pair ${i} winner`, normalized_text: `knn-mode pair ${i} winner`,
        repo: 'r1', project: null, branch: null, agent: null, session_id: null, hash: `h-cs-w${i}`, source_hash: null,
      });
      const l = memRepo.insert({
        type: 'fact', text: `knn-mode pair ${i} loser`, normalized_text: `knn-mode pair ${i} loser`,
        repo: 'r1', project: null, branch: null, agent: null, session_id: null, hash: `h-cs-l${i}`, source_hash: null,
      });
      // Two atoms per pair share one axis (20+i), so within-pair cosine is
      // controlled by `tilt` while every other pair sits on an orthogonal
      // axis — cross-pair cosine ~0, well below proposeThreshold.
      await vecStore.upsert(w, vecAt(20 + i));
      await vecStore.upsert(l, vecAt(20 + i, 0.45));
    }
    await runConsolidation(db, { candidateSelection, knnK: 3 });
    return db;
  }

  it.each(['full', 'knn'] as const)(
    'candidateSelection=%s: limit/offset page through real consolidation output with no gaps or overlap, count() matches total',
    async (mode) => {
      const db = await seedAndRunConsolidation(mode, 7);
      const repo = new ProposalRepo(db);

      expect(repo.count('pending')).toBe(7);
      const all = repo.list('pending');
      expect(all).toHaveLength(7);
      expect(all.every(p => p.kind === 'merge')).toBe(true);

      const page1 = repo.list('pending', undefined, { limit: 3, offset: 0 });
      const page2 = repo.list('pending', undefined, { limit: 3, offset: 3 });
      const page3 = repo.list('pending', undefined, { limit: 3, offset: 6 });
      expect([...page1, ...page2, ...page3].map(p => p.id)).toEqual(all.map(p => p.id));
    },
  );

  it.each(['full', 'knn'] as const)(
    'candidateSelection=%s: minConfidence filters real consolidation output on the similarity column (proposalConfidence for kind=merge)',
    async (mode) => {
      // A run whose atoms are seeded so half the pairs sit ABOVE 0.999 (near-
      // exact tilt) and half stay at the default ~0.90 borderline — but
      // ~0.999 similarity typically crosses this repo's mergeThreshold
      // (0.92) and auto-merges rather than proposing. To keep every pair at
      // PROPOSE tier while still separating them by confidence, seed all 7
      // at the same borderline band and assert on the band itself instead —
      // proposalConfidence must read back exactly the similarity
      // runConsolidation recorded, regardless of selection mode.
      const db = await seedAndRunConsolidation(mode, 5);
      const repo = new ProposalRepo(db);
      const all = repo.list('pending');
      expect(all.every(p => proposalConfidence(p) === p.similarity)).toBe(true);

      const floor = Math.min(...all.map(p => p.similarity)) - 0.001;
      expect(repo.list('pending', undefined, { minConfidence: floor })).toHaveLength(5);
      expect(repo.list('pending', undefined, { minConfidence: 0.999 })).toHaveLength(0);
      expect(repo.count('pending', undefined, 0.999)).toBe(0);
    },
  );
});
