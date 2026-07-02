// ADR-005 eval harness — CI quality gate for the local retrieval engine.
//
// Runs the shared eval corpus + query set (contracts/fixtures/eval/) through
// the hybrid search path with the deterministic fake embedder, so scores are
// stable across runs and OSes. With fake vectors the semantic leg carries no
// real signal — these thresholds are a REGRESSION FLOOR for the FTS+fusion
// pipeline, not an absolute quality claim. Re-baseline deliberately (with a
// commit explaining why) whenever ranking behavior changes on purpose.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeAll } from 'vitest';
import { openDb, type DB } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { makeFakeVec } from '../../src/search/search.js';
import type { EmbedProvider } from '../../src/contracts/index.js';
import { defaultConfig } from '../../src/config/config.js';
import {
  runRetrievalEval,
  type EvalCorpus,
  type EvalQuerySet,
  type EvalReport,
} from '../../src/eval/harness.js';
import { recallAtK, ndcgAtK } from '../../src/eval/metrics.js';

const fixturesDir = join(__dirname, '..', '..', 'contracts', 'fixtures', 'eval');
const corpus = JSON.parse(readFileSync(join(fixturesDir, 'corpus.json'), 'utf8')) as EvalCorpus;
const querySet = JSON.parse(readFileSync(join(fixturesDir, 'queries.json'), 'utf8')) as EvalQuerySet;

const fakeEmbed: EmbedProvider = {
  name: 'ollama' as const,
  model: 'fake-eval',
  dim: 1024 as const,
  embed: async (texts: string[]) => texts.map(t => makeFakeVec(t)),
  health: async () => ({ ok: true, model: 'fake-eval', dim: 1024 as const }),
};

describe('metrics', () => {
  it('recallAtK counts relevant hits in top-k', () => {
    const graded = [{ atom_id: 'a', grade: 3 }, { atom_id: 'b', grade: 1 }, { atom_id: 'c', grade: 0 }];
    expect(recallAtK(['a', 'x', 'b'], graded, 10)).toBe(1);
    expect(recallAtK(['a', 'x', 'b'], graded, 2)).toBe(0.5);
    expect(recallAtK(['x', 'y'], graded, 10)).toBe(0);
    expect(recallAtK([], [{ atom_id: 'z', grade: 0 }], 10)).toBe(1); // nothing to miss
  });

  it('ndcgAtK is 1 for ideal order, discounted for swaps, 0 for all misses', () => {
    const graded = [{ atom_id: 'a', grade: 3 }, { atom_id: 'b', grade: 1 }];
    expect(ndcgAtK(['a', 'b'], graded, 10)).toBe(1);
    const swapped = ndcgAtK(['b', 'a'], graded, 10);
    expect(swapped).toBeGreaterThan(0);
    expect(swapped).toBeLessThan(1);
    expect(ndcgAtK(['x', 'y'], graded, 10)).toBe(0);
  });
});

describe('ADR-005 retrieval eval gate', () => {
  let db: DB;
  let report: EvalReport;

  beforeAll(async () => {
    db = openDb(':memory:');
    migrate(db);
    report = await runRetrievalEval(db, fakeEmbed, defaultConfig().search, corpus, querySet);
    // Per-query breakdown for CI logs — the numbers behind the gate.
    for (const r of report.perQuery) {
      console.log(
        r.skipped
          ? `  ${r.id} [${r.mode}] SKIPPED: ${r.skipped}`
          : `  ${r.id} [${r.mode}] recall@10=${r.recall?.toFixed(3)} ndcg@10=${r.ndcg?.toFixed(3)}`,
      );
    }
    console.log(`  mean recall@10=${report.meanRecall.toFixed(3)} mean ndcg@10=${report.meanNdcg.toFixed(3)}`);
  });

  it('evaluates every query except the known as_of gap (q6)', () => {
    expect(report.perQuery).toHaveLength(querySet.queries.length);
    expect(report.skipped).toBe(1);
    expect(report.perQuery.find(r => r.id === 'q6')?.skipped).toContain('as_of');
  });

  // Baseline measured 2026-07-02 with the fake embedder: mean recall@10 =
  // 0.929, mean NDCG@10 = 0.748. Floors sit just below with a small margin.
  // q2 recall is 0.5 by design — its grade-1 atom is invalidated (valid_to
  // set), and the engine correctly refuses to surface invalidated memories.
  it('mean recall@10 stays at or above the regression floor', () => {
    expect(report.meanRecall).toBeGreaterThanOrEqual(0.9);
  });

  it('mean NDCG@10 stays at or above the regression floor', () => {
    expect(report.meanNdcg).toBeGreaterThanOrEqual(0.7);
  });
});
