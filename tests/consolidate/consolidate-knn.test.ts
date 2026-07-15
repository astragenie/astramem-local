/**
 * tests/consolidate/consolidate-knn.test.ts
 *
 * P2.1 stabilization — k-NN candidate selection for consolidation
 * (src/consolidate/consolidate.ts). Covers the four acceptance criteria
 * from the design memo (`.claude/artifacts/crew/handoffs/
 * 20260715T1645Z-design-memo-architect-p1-p2-stabilization-designs.md` §6):
 *
 *  (a) 'knn' finds the same known duplicates 'full' does (recall parity).
 *  (b) candidate-pair count is far smaller than C(n,2).
 *  (c) resumable-cursor: two runs with a low ceiling together cover what
 *      one full run does (no group permanently starved).
 *  (d) 'full' mode is byte-identical to pre-P2.1 — already covered by the
 *      existing (untouched) tests/consolidate/consolidate.test.ts suite,
 *      which stays green against this change with zero edits.
 *
 * Fixture scale: the design memo's own reasoning uses ~2000 atoms (a
 * production-scale illustration of O(n^2) vs O(n*k)). This suite uses a
 * smaller, RNG-seeded fixture (a few hundred atoms) that proves the exact
 * same mechanism deterministically and fast — see `mulberry32` below for
 * the seeded PRNG that makes vector generation reproducible across runs.
 */
import { describe, it, expect } from 'vitest';
import { openDb, type DB } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { MemoryRepo } from '../../src/storage/memories.js';
import { SqliteVecStore } from '../../src/vector/sqlite-vec.js';
import {
  runConsolidation, buildFullPairs, buildKnnCandidatePairs, type AtomRow,
} from '../../src/consolidate/consolidate.js';
import { getConsolidationCursor } from '../../src/storage/consolidation-cursor.js';
import type { VectorStore, VecHit } from '../../src/contracts/index.js';

const DIM = 1024; // must match memories_vec's schema width (DEFAULT_EMBED_DIM)

/** Deterministic seeded PRNG (mulberry32) — reproducible fixtures, no
 *  external dependency. */
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return function (): number {
    s |= 0; s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomVec(rng: () => number): Float32Array {
  const v = new Float32Array(DIM);
  for (let i = 0; i < DIM; i++) v[i] = rng() * 2 - 1;
  return v;
}

/** A cluster member: the shared centroid plus small independent noise.
 *  Empirically (see test-file header) this keeps intra-cluster cosine
 *  ~0.99, comfortably above mergeThreshold (0.92) — the seeded "known
 *  duplicates" the recall-parity test looks for. Two independent random
 *  DIM=1024 vectors sit at cosine ~0 +/- 0.03, comfortably below
 *  proposeThreshold (0.85) — the "background" atoms that must NEVER match. */
function clusterMemberVec(rng: () => number, centroid: Float32Array, noiseScale = 0.08): Float32Array {
  const v = new Float32Array(DIM);
  for (let i = 0; i < DIM; i++) v[i] = (centroid[i] as number) + (rng() * 2 - 1) * noiseScale;
  return v;
}

async function seedAtom(
  db: DB, text: string, hash: string, vec: Float32Array,
  opts: { type?: string; repo?: string } = {},
): Promise<string> {
  const id = new MemoryRepo(db).insert({
    type: (opts.type ?? 'fact') as 'fact', text, normalized_text: text.toLowerCase(),
    repo: opts.repo ?? 'r1', project: null, branch: null, agent: null,
    session_id: null, hash, source_hash: null,
  });
  await new SqliteVecStore(db).upsert(id, vec);
  return id;
}

interface ClusterFixture {
  /** clusterAtomIds[c] = ids of every member of cluster c. */
  clusterAtomIds: string[][];
  backgroundAtomIds: string[];
}

/** Seeds `numClusters` tight near-duplicate clusters of `clusterSize` atoms
 *  each, plus `numBackground` unrelated singleton atoms — all in the SAME
 *  (repo,type) group so they compete for the same k-NN candidate pool. */
async function seedClusterFixture(
  db: DB, rng: () => number,
  opts: { numClusters: number; clusterSize: number; numBackground: number; repo?: string; type?: string },
): Promise<ClusterFixture> {
  const repo = opts.repo ?? 'bigrepo';
  const type = opts.type ?? 'fact';
  const clusterAtomIds: string[][] = [];
  for (let c = 0; c < opts.numClusters; c++) {
    const centroid = randomVec(rng);
    const ids: string[] = [];
    for (let m = 0; m < opts.clusterSize; m++) {
      const vec = clusterMemberVec(rng, centroid);
      const id = await seedAtom(db, `cluster-${c}-member-${m}-${rng().toFixed(6)}`, `h-c${c}-m${m}`, vec, { repo, type });
      ids.push(id);
    }
    clusterAtomIds.push(ids);
  }
  const backgroundAtomIds: string[] = [];
  for (let i = 0; i < opts.numBackground; i++) {
    const vec = randomVec(rng);
    const id = await seedAtom(db, `background-${i}`, `h-bg-${i}`, vec, { repo, type });
    backgroundAtomIds.push(id);
  }
  return { clusterAtomIds, backgroundAtomIds };
}

/** Same query runConsolidation itself uses to build its atom set — kept in
 *  lock-step deliberately (a drift here would silently invalidate every
 *  assertion below). */
function fetchAtomRows(db: DB): AtomRow[] {
  return db.prepare(`
    SELECT m.id, m.rowid, m.repo, m.type, m.text, m.importance, m.created_at, m.derived_from
    FROM memories m
    JOIN memories_vec v ON v.rowid = m.rowid
    WHERE m.valid_to IS NULL
    ORDER BY m.repo, m.type, m.created_at
  `).all() as AtomRow[];
}

function loadVecs(db: DB, atoms: AtomRow[]): Map<string, Float32Array> {
  const getEmbedding = db.prepare('SELECT embedding FROM memories_vec WHERE rowid = ?');
  const vecs = new Map<string, Float32Array>();
  for (const a of atoms) {
    const row = getEmbedding.get(BigInt(a.rowid)) as { embedding: Buffer } | undefined;
    if (row) {
      vecs.set(a.id, new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4));
    }
  }
  return vecs;
}

/** Count of atoms from `ids` still valid (valid_to IS NULL) — a cluster
 *  that fully collapsed to one survivor reports 1. */
function countValid(db: DB, ids: string[]): number {
  if (ids.length === 0) return 0;
  const placeholders = ids.map(() => '?').join(',');
  const row = db.prepare(
    `SELECT COUNT(*) AS n FROM memories WHERE valid_to IS NULL AND id IN (${placeholders})`,
  ).get(...ids) as { n: number };
  return row.n;
}

describe('P2.1: k-NN candidate selection — recall parity + pair-count reduction', () => {
  // AC(a) + AC(b): one seeded fixture, run once in 'full' mode and once in
  // 'knn' mode against SEPARATE db instances (same RNG seed -> structurally
  // identical clusters, different ids). Both modes must fully collapse
  // every cluster to exactly 1 survivor and leave every background atom
  // untouched — recall parity on the known seeded duplicates. Separately,
  // the raw candidate-pair count for 'knn' must be far below C(n,2).
  const NUM_CLUSTERS = 25;
  const CLUSTER_SIZE = 4;
  const NUM_BACKGROUND = 200;
  const SEED = 20260715;

  it("AC(a): 'knn' collapses every seeded cluster to 1 survivor, same as 'full', background untouched", async () => {
    const dbFull = openDb(':memory:');
    migrate(dbFull);
    const fixtureFull = await seedClusterFixture(dbFull, mulberry32(SEED), {
      numClusters: NUM_CLUSTERS, clusterSize: CLUSTER_SIZE, numBackground: NUM_BACKGROUND,
    });
    await runConsolidation(dbFull, {
      candidateSelection: 'full', maxGroupSize: 100_000, yieldEveryNPairs: 100_000,
    });
    for (const cluster of fixtureFull.clusterAtomIds) {
      expect(countValid(dbFull, cluster)).toBe(1);
    }
    expect(countValid(dbFull, fixtureFull.backgroundAtomIds)).toBe(fixtureFull.backgroundAtomIds.length);
    dbFull.close();

    const dbKnn = openDb(':memory:');
    migrate(dbKnn);
    const fixtureKnn = await seedClusterFixture(dbKnn, mulberry32(SEED), {
      numClusters: NUM_CLUSTERS, clusterSize: CLUSTER_SIZE, numBackground: NUM_BACKGROUND,
    });
    await runConsolidation(dbKnn, {
      candidateSelection: 'knn', knnK: 20, yieldEveryNPairs: 100_000,
    });
    for (const cluster of fixtureKnn.clusterAtomIds) {
      expect(countValid(dbKnn, cluster)).toBe(1);
    }
    expect(countValid(dbKnn, fixtureKnn.backgroundAtomIds)).toBe(fixtureKnn.backgroundAtomIds.length);
    dbKnn.close();
  }, 30_000);

  it('AC(b): knn candidate-pair count is far smaller than C(n,2) for the same large single group', async () => {
    const db = openDb(':memory:');
    migrate(db);
    await seedClusterFixture(db, mulberry32(SEED), {
      numClusters: NUM_CLUSTERS, clusterSize: CLUSTER_SIZE, numBackground: NUM_BACKGROUND,
    });
    const group = fetchAtomRows(db);
    const n = group.length;
    expect(n).toBe(NUM_CLUSTERS * CLUSTER_SIZE + NUM_BACKGROUND);

    const vecs = loadVecs(db, group);
    const vectorStore = new SqliteVecStore(db);
    const fullPairs = buildFullPairs(group);
    const knnPairs = await buildKnnCandidatePairs(group, vecs, vectorStore, 20);

    expect(fullPairs.length).toBe((n * (n - 1)) / 2);
    // Order-of-magnitude reduction: knn is bounded by ~n*k (pre-dedup), full
    // is C(n,2) — at n=300/k=20 that's ~3000 vs ~44850, comfortably under a
    // 10x margin even after accounting for symmetric double-counting.
    expect(knnPairs.length).toBeLessThan(fullPairs.length / 10);

    // Every pair knn finds is a REAL pair from the group (no fabricated ids,
    // no self-pairs, no duplicate pairs under the canonical min/max key).
    const seen = new Set<string>();
    const groupIds = new Set(group.map(a => a.id));
    for (const [a, b] of knnPairs) {
      expect(a.id).not.toBe(b.id);
      expect(groupIds.has(a.id)).toBe(true);
      expect(groupIds.has(b.id)).toBe(true);
      const key = a.id < b.id ? `${a.id} ${b.id}` : `${b.id} ${a.id}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
    db.close();
  }, 30_000);

  it('buildKnnCandidatePairs post-filters hits outside the (repo,type) group (sqlite-vec has no same-query metadata filter)', async () => {
    // Direct unit check of the post-filter contract using a stub
    // VectorStore that deliberately returns a hit OUTSIDE the group — the
    // real reason this filtering happens in JS: SqliteVecStore.search()
    // throws on a non-empty VecFilter today (src/vector/sqlite-vec.ts).
    const inGroup: AtomRow = {
      id: 'a', rowid: 1, repo: 'r1', type: 'fact', text: 'x', importance: 0.5, created_at: 1, derived_from: null,
    };
    const alsoInGroup: AtomRow = {
      id: 'b', rowid: 2, repo: 'r1', type: 'fact', text: 'y', importance: 0.5, created_at: 2, derived_from: null,
    };
    const group = [inGroup, alsoInGroup];
    const vecs = new Map<string, Float32Array>([
      ['a', new Float32Array(4).fill(1)],
      ['b', new Float32Array(4).fill(1)],
    ]);
    const stubStore: VectorStore = {
      name: 'sqlite-vec',
      async search(): Promise<VecHit[]> {
        return [
          { id: 'a', score: 1 }, // self — must be excluded
          { id: 'b', score: 0.99 }, // in-group — must be kept
          { id: 'outsider', score: 0.98 }, // NOT in this group — must be dropped
        ];
      },
      async upsert(): Promise<void> {},
      async clear(): Promise<void> {},
    };
    const pairs = await buildKnnCandidatePairs(group, vecs, stubStore, 5);
    // Each of the 2 atoms independently queries and finds the same
    // in-group neighbor — deduped to exactly 1 pair.
    expect(pairs).toHaveLength(1);
    expect([pairs[0]![0].id, pairs[0]![1].id].sort()).toEqual(['a', 'b']);
  });
});

describe('P2.1: maxCandidatePairsPerRun resumable cursor', () => {
  // AC(c): 8 independent (repo,type) groups, each a clean 2-atom
  // near-duplicate pair (1 candidate pair each in either mode). A ceiling
  // of 4 pairs/run means group order is EXACTLY 4 groups/run (deterministic
  // — see groupOrder's sort-by-min-created_at-then-key tie-break in
  // consolidate.ts: same-millisecond inserts in this fixture tie on
  // created_at, so the group KEY 'g0 fact' < 'g1 fact' < ... decides order).
  // Two runs together must merge all 8 pairs — the same outcome one
  // unlimited run produces — proving no group is permanently starved by the
  // ceiling.
  const NUM_GROUPS = 8;

  async function seedPairFixture(db: DB, rng: () => number): Promise<Array<[string, string]>> {
    const pairs: Array<[string, string]> = [];
    for (let g = 0; g < NUM_GROUPS; g++) {
      const centroid = randomVec(rng);
      const a = await seedAtom(db, `g${g}-a`, `h-g${g}-a`, centroid, { repo: `g${g}`, type: 'fact' });
      const b = await seedAtom(db, `g${g}-b`, `h-g${g}-b`, clusterMemberVec(rng, centroid), { repo: `g${g}`, type: 'fact' });
      pairs.push([a, b]);
    }
    return pairs;
  }

  it('two low-ceiling knn runs together merge every pair a single unlimited run would', async () => {
    const dbOne = openDb(':memory:');
    migrate(dbOne);
    const pairsOne = await seedPairFixture(dbOne, mulberry32(1));
    await runConsolidation(dbOne, { candidateSelection: 'knn', knnK: 5, yieldEveryNPairs: 100_000 });
    for (const [a, b] of pairsOne) {
      expect(countValid(dbOne, [a, b])).toBe(1); // fully merged
    }
    dbOne.close();

    const dbTwo = openDb(':memory:');
    migrate(dbTwo);
    const pairsTwo = await seedPairFixture(dbTwo, mulberry32(1));

    const run1 = await runConsolidation(dbTwo, {
      candidateSelection: 'knn', knnK: 5, yieldEveryNPairs: 100_000, maxCandidatePairsPerRun: 4,
    });
    expect(run1.groupsScanned).toBe(4);
    const cursorAfterRun1 = getConsolidationCursor(dbTwo);
    expect(cursorAfterRun1?.groupKey).not.toBeNull(); // mid-sweep — more groups remain

    const run2 = await runConsolidation(dbTwo, {
      candidateSelection: 'knn', knnK: 5, yieldEveryNPairs: 100_000, maxCandidatePairsPerRun: 4,
    });
    expect(run2.groupsScanned).toBe(4);
    const cursorAfterRun2 = getConsolidationCursor(dbTwo);
    expect(cursorAfterRun2?.groupKey).toBeNull(); // full sweep cycle completed

    for (const [a, b] of pairsTwo) {
      expect(countValid(dbTwo, [a, b])).toBe(1); // every group covered across the two runs
    }
    dbTwo.close();
  }, 30_000);

  it('a third run after a completed cycle starts over cleanly (no atoms left to touch, no error)', async () => {
    const db = openDb(':memory:');
    migrate(db);
    await seedPairFixture(db, mulberry32(2));
    await runConsolidation(db, { candidateSelection: 'knn', knnK: 5, yieldEveryNPairs: 100_000, maxCandidatePairsPerRun: 4 });
    await runConsolidation(db, { candidateSelection: 'knn', knnK: 5, yieldEveryNPairs: 100_000, maxCandidatePairsPerRun: 4 });
    // Every atom is now merged (valid_to set) — a third run finds nothing
    // left to scan (groups shrink below 2 atoms and are filtered out), not
    // an error and not a re-scan of stale groups.
    const run3 = await runConsolidation(db, { candidateSelection: 'knn', knnK: 5, yieldEveryNPairs: 100_000, maxCandidatePairsPerRun: 4 });
    expect(run3.groupsScanned).toBe(0);
    db.close();
  }, 30_000);
});
