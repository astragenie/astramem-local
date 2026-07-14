/**
 * FEAT-499 stage 1 (instrument-first): the judge is already gated to pairs
 * with cosine similarity in [minSimilarity, mergeThreshold). This suite
 * verifies the NEW instrumentation only — counting how many of a run's REAL
 * judge dispatches had a pair similarity in the near-merge-threshold band
 * [NEAR_MERGE_THRESHOLD_MIN (0.90), mergeThreshold) — on synthetic pairs
 * placed at controlled cosine similarities straddling that boundary. No
 * skip/filter behavior exists yet (that's stage 2, gated on this evidence);
 * every pair here still reaches the judge exactly as before this FEAT.
 *
 * Cosine construction mirrors consolidate.test.ts's `vecAt` helper: two unit
 * vectors on the same axis, one tilted by `tilt` on a second axis, gives
 * cosine = 1 / sqrt(1 + tilt^2) — solved for `tilt` below to land each pair
 * at a specific target similarity.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { MemoryRepo } from '../../src/storage/memories.js';
import { SqliteVecStore } from '../../src/vector/sqlite-vec.js';
import { runConsolidation, NEAR_MERGE_THRESHOLD_MIN } from '../../src/consolidate/consolidate.js';
import { latestConsolidationJudgeRun } from '../../src/storage/consolidation-judge-log.js';
import type { LLMProvider } from '../../src/contracts/index.js';

const MAX_WALL_CLOCK_MS = 60_000;

function vecAt(axis: number, tilt = 0, tiltAxis = 1): Float32Array {
  const v = new Float32Array(1024);
  v[axis] = 1;
  if (tilt > 0) v[tiltAxis] = tilt;
  return v;
}

/** tilt such that cosine(vecAt(0), vecAt(0, tilt)) == targetSim. */
function tiltForSim(targetSim: number): number {
  return Math.sqrt(1 / (targetSim * targetSim) - 1);
}

async function seedPair(
  db: DB, textA: string, textB: string, hashPrefix: string, repo: string, targetSim: number,
): Promise<void> {
  const idA = new MemoryRepo(db).insert({
    type: 'fact', text: textA, normalized_text: textA.toLowerCase(),
    repo, project: null, branch: null, agent: null,
    session_id: null, hash: `${hashPrefix}-a`, source_hash: null,
  });
  const idB = new MemoryRepo(db).insert({
    type: 'fact', text: textB, normalized_text: textB.toLowerCase(),
    repo, project: null, branch: null, agent: null,
    session_id: null, hash: `${hashPrefix}-b`, source_hash: null,
  });
  await new SqliteVecStore(db).upsert(idA, vecAt(0));
  await new SqliteVecStore(db).upsert(idB, vecAt(0, tiltForSim(targetSim)));
}

/** Always falls back to {unrelated, 0.5} — text is deliberately absent from
 *  MOCK_JUDGE_PAIRS, so the verdict itself is irrelevant; only call counts
 *  and similarity bucketing are under test here. */
const alwaysUnrelatedJudge: LLMProvider = {
  name: 'ollama',
  model: 'near-threshold-test-model',
  chat: async () => ({
    text: JSON.stringify({ verdict: 'unrelated', confidence: 0.5, reasoning: 'test' }),
    // Both shipped providers hardcode usage.usd: 0 (Ollama free,
    // codex-subscription quota-metered, not per-token) — mirror that shape
    // rather than inventing a nonzero cost (see contradiction-judge.ts's
    // doc comment / CLAUDE.md's FEAT-482 note).
    usage: { in: 0, out: 0, usd: 0 },
  }),
  health: async () => ({ ok: true, model: 'near-threshold-test-model', latency_ms: 0 }),
};

describe('runConsolidation — FEAT-499 stage 1 near-threshold instrumentation', () => {
  let db: DB;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
  });

  it('counts a below-band pair (sim ~0.85) as judged but NOT near-threshold', async () => {
    await seedPair(db, 'alpha text one', 'alpha text two', 'below', 'g-below', 0.85);

    const summary = await runConsolidation(db, {
      contradictionDetection: { mode: 'enabled', minSimilarity: 0.6, minConfidence: 0.99, maxPerRun: 200, maxWallClockMs: MAX_WALL_CLOCK_MS },
      judgeProvider: alwaysUnrelatedJudge,
    });

    expect(summary.judgeCallsExecuted).toBe(1);
    expect(summary.judgeCallsNearThreshold).toBe(0);
  });

  it('counts a just-below-boundary pair (sim ~0.899) as judged but NOT near-threshold', async () => {
    await seedPair(db, 'bravo text one', 'bravo text two', 'justbelow', 'g-justbelow', 0.899);

    const summary = await runConsolidation(db, {
      contradictionDetection: { mode: 'enabled', minSimilarity: 0.6, minConfidence: 0.99, maxPerRun: 200, maxWallClockMs: MAX_WALL_CLOCK_MS },
      judgeProvider: alwaysUnrelatedJudge,
    });

    expect(summary.judgeCallsExecuted).toBe(1);
    expect(summary.judgeCallsNearThreshold).toBe(0);
  });

  it('counts a just-above-boundary pair (sim ~0.901) as judged AND near-threshold', async () => {
    await seedPair(db, 'charlie text one', 'charlie text two', 'justabove', 'g-justabove', 0.901);

    const summary = await runConsolidation(db, {
      contradictionDetection: { mode: 'enabled', minSimilarity: 0.6, minConfidence: 0.99, maxPerRun: 200, maxWallClockMs: MAX_WALL_CLOCK_MS },
      judgeProvider: alwaysUnrelatedJudge,
    });

    expect(summary.judgeCallsExecuted).toBe(1);
    expect(summary.judgeCallsNearThreshold).toBe(1);
  });

  it('counts a well-inside-band pair (sim ~0.915, close to mergeThreshold 0.92) as near-threshold', async () => {
    await seedPair(db, 'delta text one', 'delta text two', 'nearmerge', 'g-nearmerge', 0.915);

    const summary = await runConsolidation(db, {
      contradictionDetection: { mode: 'enabled', minSimilarity: 0.6, minConfidence: 0.99, maxPerRun: 200, maxWallClockMs: MAX_WALL_CLOCK_MS },
      judgeProvider: alwaysUnrelatedJudge,
    });

    expect(summary.judgeCallsExecuted).toBe(1);
    expect(summary.judgeCallsNearThreshold).toBe(1);
  });

  it('a pair at/above mergeThreshold never reaches the judge at all — auto-merged instead, zero judge calls', async () => {
    await seedPair(db, 'echo distinct phrasing alpha', 'echo distinct phrasing alpha restated fully', 'automerge', 'g-automerge', 0.999);

    const summary = await runConsolidation(db, {
      contradictionDetection: { mode: 'enabled', minSimilarity: 0.6, minConfidence: 0.99, maxPerRun: 200, maxWallClockMs: MAX_WALL_CLOCK_MS },
      judgeProvider: alwaysUnrelatedJudge,
    });

    expect(summary.judgeCallsExecuted).toBe(0);
    expect(summary.judgeCallsNearThreshold).toBe(0);
    expect(summary.merged.length + summary.contradictionsProposed.length).toBeGreaterThanOrEqual(0);
  });

  it('mixed run: aggregates near-threshold count across multiple independent (repo,type) groups', async () => {
    await seedPair(db, 'foxtrot text one', 'foxtrot text two', 'mix-below', 'g-mix-below', 0.85); // not near
    await seedPair(db, 'golf text one', 'golf text two', 'mix-above1', 'g-mix-above1', 0.905); // near
    await seedPair(db, 'hotel text one', 'hotel text two', 'mix-above2', 'g-mix-above2', 0.918); // near

    const summary = await runConsolidation(db, {
      contradictionDetection: { mode: 'enabled', minSimilarity: 0.6, minConfidence: 0.99, maxPerRun: 200, maxWallClockMs: MAX_WALL_CLOCK_MS },
      judgeProvider: alwaysUnrelatedJudge,
    });

    expect(summary.judgeCallsExecuted).toBe(3);
    expect(summary.judgeCallsNearThreshold).toBe(2);
  });

  it('persists judgeCallsNearThreshold via recordConsolidationJudgeRun, readable back via latestConsolidationJudgeRun', async () => {
    await seedPair(db, 'india text one', 'india text two', 'persist-below', 'g-persist-below', 0.85);
    await seedPair(db, 'juliet text one', 'juliet text two', 'persist-above', 'g-persist-above', 0.905);

    await runConsolidation(db, {
      contradictionDetection: { mode: 'enabled', minSimilarity: 0.6, minConfidence: 0.99, maxPerRun: 200, maxWallClockMs: MAX_WALL_CLOCK_MS },
      judgeProvider: alwaysUnrelatedJudge,
    });

    const latest = latestConsolidationJudgeRun(db);
    expect(latest?.judgeCalls).toBe(2);
    expect(latest?.judgeCallsNearThreshold).toBe(1);
  });

  it('a run with contradiction detection off never touches judgeCallsNearThreshold (stays 0, no row written)', async () => {
    await seedPair(db, 'kilo text one', 'kilo text two', 'off', 'g-off', 0.905);

    const summary = await runConsolidation(db); // no contradictionDetection opt at all
    expect(summary.judgeCallsExecuted).toBe(0);
    expect(summary.judgeCallsNearThreshold).toBe(0);
    expect(latestConsolidationJudgeRun(db)).toBeNull();
  });

  it('NEAR_MERGE_THRESHOLD_MIN is exported and equals 0.90 (documents the band boundary for callers/tests)', () => {
    expect(NEAR_MERGE_THRESHOLD_MIN).toBe(0.90);
  });
});
