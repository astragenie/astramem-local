/**
 * tests/consolidate/consolidate-knn-multigroup-crowding.test.ts
 *
 * P2.1 review follow-up (MEDIUM finding, promoted to a concrete soak
 * deliverable by the team-lead — see the P2.2 dispatch message this suite
 * was added under). `buildKnnCandidatePairs` (src/consolidate/consolidate.ts)
 * queries `SqliteVecStore.search()` GLOBALLY — sqlite-vec has no same-query
 * metadata filter (see that function's own doc comment) — and only
 * post-filters hits down to the current (repo,type) group's own atom ids
 * AFTER retrieval. `tests/consolidate/consolidate-knn.test.ts`'s existing
 * recall-parity suite seeds exactly ONE (repo,type) group per DB, so it can
 * never exercise the failure mode this creates: in a MULTI-group corpus, a
 * true in-group duplicate can be crowded out of the top-`k` neighbor list
 * by atoms from OTHER groups whose vectors happen to sit even closer in
 * embedding space — a silent recall loss `'full'` mode never has, because
 * its exhaustive C(n,2) scan is same-group-only by construction and
 * structurally immune to cross-group interference.
 *
 * FIXTURE: a SMALL (repo,type) group carrying NUM_CLUSTERS genuine
 * near-duplicate pairs (noiseScale 0.2 -> cosine ~0.965 pairwise,
 * comfortably above mergeThreshold 0.92 with margin for per-cluster RNG
 * variance), surrounded by NUM_DECOY_GROUPS LARGER (repo,type) groups whose
 * atoms are deliberately placed marginally CLOSER to each pair's shared
 * centroid (noiseScale 0.19 — see the noise-scale-vs-cosine measurements
 * inside `seedCrowdingFixture`'s doc comment for why the gap has to be this
 * narrow: at DIM=1024 cosine similarity is highly insensitive to noiseScale
 * in this range) than the real duplicate partner is. This is a plausible
 * real-world analog of several unrelated repos/types independently
 * producing atoms with similar embedding-space content: nothing about the
 * SCENARIO is contrived, only the vectors are hand-placed to make the
 * effect deterministic and measurable rather than a rare coincidence.
 *
 * TWO MEASUREMENTS, per the team-lead's explicit ask (do not tune the
 * fixture until the default passes a floor — raise `knnK` instead and
 * report both numbers):
 *
 *   1. AT THE SHIPPED DEFAULT (`knnK` = `DEFAULT_KNN_K` = 30): 'full'
 *      collapses 6/6 target clusters (100% — the control, immune to
 *      cross-group crowding by construction). 'knn' collapses 2/6 (33%) —
 *      4 of the 6 real duplicate pairs are crowded out of their top-30
 *      global neighbor list by the tighter-noise decoys and are never
 *      proposed as candidates, so they never merge. This is NOT a bug to
 *      chase to zero here — it is the exact, now-quantified shape of the
 *      review's MEDIUM finding, existing already at the shipped default.
 *      Reported (console.log + assertion below) but NOT floor-gated — a
 *      floor set to tolerate the already-known 33% would be too loose to
 *      ever catch a real regression, and a floor tight enough to catch a
 *      regression would fail on every green run at the (known, accepted)
 *      default. `expect(knnCollapsedAtDefault).toBeLessThan(fullCollapsed)`
 *      instead proves the effect is real and reproducible at the shipped
 *      default without gating pass/fail on its exact magnitude.
 *
 *   2. AT A RAISED `knnK` (34 — the minimum value that recovers full
 *      recall for THIS exact fixture+seed; found by sweeping k=31..39 on
 *      this fixture, see the sweep note in the test body): 'knn' collapses
 *      6/6 (100%). THIS is the floor-gated measurement (>= FLOOR_RATIO =
 *      0.8) — proves the recall loss is a `k`-vs-decoy-density tradeoff,
 *      not a structural ceiling: raising `knnK` is a real, working lever
 *      for the promote-'knn'-to-default decision, not just a hopeful claim
 *      in a doc comment. The sharp step from 33% (k=30/31/32) to 50%
 *      (k=33) to 100% (k=34) rather than a smooth ramp is a direct
 *      consequence of NUM_DECOYS_PER_CLUSTER being a fixed 32 — once
 *      `knnK - 1` exceeds the total decoy count for a cluster, EVERY decoy
 *      can occupy a slot and the real partner is still guaranteed to fit;
 *      it is a property of this fixture's decoy count, not evidence that
 *      production behaves as a step function.
 *
 * Both measurements pin the same seed (mulberry32 20260716), so both are
 * exactly reproducible run to run — see the 3x-run verification note in the
 * PR/commit this test ships with. Re-run and update this comment (both
 * numbers) together if the fixture constants below ever change.
 *
 * This measurement is what the promote-'knn'-to-default decision (P2.1's
 * `consolidation.candidateSelection` ships opt-in `'full'`) should cite:
 * raising `knnK` is the lever if the loss rate needs to shrink, not a code
 * change to the post-filter itself (see `buildKnnCandidatePairs`'s doc
 * comment for why the filter is unavoidable given sqlite-vec's current API).
 */
import { describe, it, expect } from 'vitest';
import { openDb, type DB } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { MemoryRepo } from '../../src/storage/memories.js';
import { SqliteVecStore } from '../../src/vector/sqlite-vec.js';
import { runConsolidation } from '../../src/consolidate/consolidate.js';

const DIM = 1024; // must match memories_vec's schema width (DEFAULT_EMBED_DIM)

/** Deterministic seeded PRNG (mulberry32) — reproducible fixtures, no
 *  external dependency. Duplicated from consolidate-knn.test.ts by design:
 *  that file exports no helpers, and this fixture's seeding needs (multiple
 *  decoy groups, tighter-noise decoys) are shaped differently enough from
 *  the single-group recall-parity fixture that sharing a helper module
 *  would couple two independent test intents. */
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

/** A cluster member: the shared centroid plus independent noise scaled by
 *  `noiseScale`. Smaller `noiseScale` -> tighter to the centroid -> higher
 *  cosine similarity to the centroid AND to any other low-noise member.
 *  Empirically (a standalone diagnostic script swept this before picking
 *  fixture constants — see the measured-result note above) cosine
 *  similarity at DIM=1024 is highly insensitive to noiseScale in the
 *  0.01-0.08 range (independent per-dimension noise barely perturbs
 *  direction against a large-magnitude random centroid) and a real pair
 *  needs noiseScale >= ~0.2 before its own mutual cosine even clears
 *  mergeThreshold (0.92) — a naive 0.5 gives cosine ~0.80, below even the
 *  propose threshold. The crowding-out effect below is built on decoys
 *  using a marginally SMALLER noiseScale (0.19) than the real duplicate
 *  pairs (0.2), so decoys rank closer to a real pair's own centroid than
 *  the OTHER real member does — but the gap has to be this narrow, not
 *  the tighter 0.015 an earlier iteration of this fixture tried (that
 *  produced a 0% knn recall total wipeout, not a useful measurement). */
function clusterMemberVec(rng: () => number, centroid: Float32Array, noiseScale: number): Float32Array {
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

/** Count of atoms from `ids` still valid (valid_to IS NULL) — a pair that
 *  fully collapsed to one survivor reports 1; an uncollapsed pair reports 2. */
function countValid(db: DB, ids: string[]): number {
  if (ids.length === 0) return 0;
  const placeholders = ids.map(() => '?').join(',');
  const row = db.prepare(
    `SELECT COUNT(*) AS n FROM memories WHERE valid_to IS NULL AND id IN (${placeholders})`,
  ).get(...ids) as { n: number };
  return row.n;
}

interface CrowdingFixture {
  /** [clusterIdx] -> the genuine near-duplicate pair seeded in the SMALL
   *  (repo,type) group — the pairs 'full' mode always finds and 'knn' mode
   *  may or may not, depending on decoy crowding and `knnK`. */
  targetPairs: Array<[string, string]>;
  /** Unrelated random-vector atoms in the SAME small group — must never
   *  merge in EITHER mode; proves the crowding fixture isn't accidentally
   *  over-merging everything in sight. */
  smallGroupBackgroundIds: string[];
}

interface CrowdingFixtureOpts {
  numClusters: number;
  numDecoyGroups: number;
  /** Decoys seeded per cluster, split round-robin across numDecoyGroups —
   *  the FIXED decoy count that produces the sharp knnK step described in
   *  the file header (33% at k<=32, 50% at k=33, 100% at k>=34). */
  numDecoysPerCluster: number;
  numSmallGroupBackground: number;
  smallGroupRepo?: string;
  smallGroupType?: string;
}

/** Seeds the multi-group crowding scenario described in the file header:
 *  one small (repo,type) group with `numClusters` genuine duplicate pairs
 *  plus background noise, and `numDecoyGroups` larger OTHER (repo,type)
 *  groups whose atoms sit closer to each pair's shared centroid than the
 *  real duplicate partner does — competing for the same global top-k. */
async function seedCrowdingFixture(db: DB, rng: () => number, opts: CrowdingFixtureOpts): Promise<CrowdingFixture> {
  const smallRepo = opts.smallGroupRepo ?? 'small-repo';
  const smallType = opts.smallGroupType ?? 'fact';
  const targetPairs: Array<[string, string]> = [];

  for (let c = 0; c < opts.numClusters; c++) {
    const centroid = randomVec(rng);

    // The genuine near-duplicate pair.
    const a = await seedAtom(
      db, `small-cluster-${c}-a-${rng().toFixed(6)}`, `h-sc${c}-a`,
      clusterMemberVec(rng, centroid, 0.2), { repo: smallRepo, type: smallType },
    );
    const b = await seedAtom(
      db, `small-cluster-${c}-b-${rng().toFixed(6)}`, `h-sc${c}-b`,
      clusterMemberVec(rng, centroid, 0.2), { repo: smallRepo, type: smallType },
    );
    targetPairs.push([a, b]);

    // Decoys — spread round-robin across several OTHER (repo,type) groups
    // so they compete in the GLOBAL knn query for this exact centroid but
    // get JS-post-filtered out of THIS (small-repo, fact) group's own
    // candidate pairs. Alternating type by decoy-group index gives
    // numDecoyGroups genuinely distinct (repo,type) tuples, not just
    // distinct repos.
    for (let d = 0; d < opts.numDecoysPerCluster; d++) {
      const decoyGroupIdx = d % opts.numDecoyGroups;
      const decoyRepo = `decoy-repo-${decoyGroupIdx}`;
      const decoyType = decoyGroupIdx % 2 === 0 ? 'fact' : 'decision';
      await seedAtom(
        db, `decoy-c${c}-${d}-${rng().toFixed(6)}`, `h-decoy-c${c}-${d}`,
        clusterMemberVec(rng, centroid, 0.19), { repo: decoyRepo, type: decoyType },
      );
    }
  }

  const smallGroupBackgroundIds: string[] = [];
  for (let i = 0; i < opts.numSmallGroupBackground; i++) {
    const id = await seedAtom(
      db, `small-background-${i}`, `h-sbg-${i}`, randomVec(rng), { repo: smallRepo, type: smallType },
    );
    smallGroupBackgroundIds.push(id);
  }

  return { targetPairs, smallGroupBackgroundIds };
}

/** Runs the fixture once (fresh :memory: DB) under one candidateSelection
 *  config and returns how many of the target clusters collapsed to a
 *  single survivor. Shared by all three runs below (full / knn@default /
 *  knn@raised) so the seeding + measurement logic can't drift between them. */
async function runFixtureAndMeasure(
  seed: number,
  fixtureOpts: CrowdingFixtureOpts,
  consolidateOpts: Parameters<typeof runConsolidation>[1],
): Promise<{ collapsed: number; total: number }> {
  const db = openDb(':memory:');
  migrate(db);
  const fixture = await seedCrowdingFixture(db, mulberry32(seed), fixtureOpts);
  await runConsolidation(db, consolidateOpts);
  let collapsed = 0;
  for (const [a, b] of fixture.targetPairs) {
    if (countValid(db, [a, b]) === 1) collapsed++;
  }
  // Background must never merge in ANY mode — proves the fixture isn't
  // just globally over-merging (which would make every recall number
  // below meaningless regardless of direction).
  expect(countValid(db, fixture.smallGroupBackgroundIds)).toBe(fixture.smallGroupBackgroundIds.length);
  db.close();
  return { collapsed, total: fixture.targetPairs.length };
}

describe('P2.1 review follow-up: multi-group vector crowding-out (knn vs full recall delta)', () => {
  const NUM_CLUSTERS = 6;
  const NUM_DECOY_GROUPS = 5;
  const NUM_DECOYS_PER_CLUSTER = 32;
  const NUM_SMALL_BACKGROUND = 20;
  const SEED = 20260716;
  const FIXTURE_OPTS: CrowdingFixtureOpts = {
    numClusters: NUM_CLUSTERS, numDecoyGroups: NUM_DECOY_GROUPS,
    numDecoysPerCluster: NUM_DECOYS_PER_CLUSTER, numSmallGroupBackground: NUM_SMALL_BACKGROUND,
  };

  const DEFAULT_KNN_K = 30; // matches consolidate.ts's DEFAULT_KNN_K — the shipped default
  /** Minimum `knnK` that clears FLOOR_RATIO for THIS exact fixture+seed —
   *  found by sweeping k=31..39 (33% at 31/32, 50% at 33, 100% from 34
   *  onward — see file header for why the transition is a sharp step, not
   *  a ramp). NOT a universal "safe k" for production; it is evidence that
   *  raising k is a working lever for THIS measured scenario. */
  const RAISED_KNN_K = 34;
  /** Team-lead's explicit floor for the raised-k measurement. */
  const FLOOR_RATIO = 0.8;

  it('measures the knn recall delta vs full, then vs a raised knnK, on a multi-group corpus with cross-group vector crowding', async () => {
    // ── 1. 'full' baseline — immune to cross-group crowding by construction ──
    const full = await runFixtureAndMeasure(SEED, FIXTURE_OPTS, {
      candidateSelection: 'full', maxGroupSize: 100_000, yieldEveryNPairs: 100_000,
    });
    expect(full.collapsed).toBe(NUM_CLUSTERS); // the control

    // ── 2. 'knn' AT THE SHIPPED DEFAULT (k=30) — documents the known finding,
    // not floor-gated (see file header for why gating on this number would
    // be meaningless either way it's set). ──
    const knnDefault = await runFixtureAndMeasure(SEED, FIXTURE_OPTS, {
      candidateSelection: 'knn', knnK: DEFAULT_KNN_K, yieldEveryNPairs: 100_000,
    });

    // ── 3. 'knn' AT A RAISED k=34 — THIS is the floor-gated measurement. ──
    const knnRaised = await runFixtureAndMeasure(SEED, FIXTURE_OPTS, {
      candidateSelection: 'knn', knnK: RAISED_KNN_K, yieldEveryNPairs: 100_000,
    });

    const defaultRatio = knnDefault.collapsed / full.collapsed;
    const raisedRatio = knnRaised.collapsed / full.collapsed;

    // eslint-disable-next-line no-console -- deliberate: the measured numbers
    // ARE the deliverable here, not just the pass/fail (see file header).
    console.log(
      `[P2.1 crowding-out] full=${full.collapsed}/${NUM_CLUSTERS} (control); ` +
      `knn@k=${DEFAULT_KNN_K} (shipped default)=${knnDefault.collapsed}/${NUM_CLUSTERS} (${(defaultRatio * 100).toFixed(0)}%); ` +
      `knn@k=${RAISED_KNN_K} (raised)=${knnRaised.collapsed}/${NUM_CLUSTERS} (${(raisedRatio * 100).toFixed(0)}%)`,
    );

    // The crowding effect must be REAL and reproducible at the shipped
    // default — if this ever reads knnDefault.collapsed === full.collapsed,
    // the fixture stopped exercising the finding (e.g. a sqlite-vec change
    // made search() metadata-aware) and this test's premise needs
    // re-deriving, not just a number bump.
    expect(knnDefault.collapsed).toBeLessThan(full.collapsed);

    // Raising knnK is a REAL, WORKING lever (not just a doc-comment claim):
    // proves the recall loss is a k-vs-decoy-density tradeoff, not a
    // structural ceiling 'knn' mode can never clear.
    expect(
      raisedRatio,
      `knn@k=${RAISED_KNN_K} recall ratio ${knnRaised.collapsed}/${full.collapsed} (${(raisedRatio * 100).toFixed(0)}%) ` +
      `dropped below the ${(FLOOR_RATIO * 100).toFixed(0)}% floor — RAISED_KNN_K may need re-tuning for this fixture, ` +
      `or this is a genuine regression in buildKnnCandidatePairs`,
    ).toBeGreaterThanOrEqual(FLOOR_RATIO);
  }, 90_000);
});
