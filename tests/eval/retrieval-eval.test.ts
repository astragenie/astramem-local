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
import { MockCrossEncoderProvider, resolveRerankOpts, type RerankOpts } from '../../src/search/rerank.js';

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

  // FEAT-401: as_of is now supported end-to-end — q6 (the temporal case) runs
  // like every other query instead of being reported as a skipped gap.
  it('evaluates every query, including the as_of temporal case (q6)', () => {
    expect(report.perQuery).toHaveLength(querySet.queries.length);
    expect(report.skipped).toBe(0);
    const q6 = report.perQuery.find(r => r.id === 'q6');
    expect(q6?.skipped).toBeNull();
    // q6 asserts atom-001 (valid at as_of) outranks atom-002 (not yet valid).
    expect(q6?.recall).toBe(1);
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

  // FEAT-402 slice 2 AC-8: entity-tagged fixtures + entity queries. q9/q10
  // exercise the AC-4 pre-fusion intersection against entities shared by
  // exactly two corpus atoms (deterministic full recall/NDCG); q11 exercises
  // the AC-4/AC-9 exact-then-LIKE resolution plus the current-snapshot
  // validity filter. Floors above already include these queries in the mean
  // — this test additionally pins the exact per-query numbers so a
  // regression in the entity join is caught precisely, not just averaged away.
  it('AC-8: entity queries (q9-q11) score full recall/NDCG against their graded set', () => {
    for (const id of ['q9', 'q10', 'q11']) {
      const r = report.perQuery.find(q => q.id === id);
      expect(r?.skipped, `${id} skipped`).toBeNull();
      expect(r?.recall, `${id} recall`).toBe(1);
      expect(r?.ndcg, `${id} ndcg`).toBe(1);
    }
  });

  it('AC-4: q9/q10 entity filter returns all-and-only the entity-linked atoms (no lexical leakage)', () => {
    const q9 = report.perQuery.find(r => r.id === 'q9');
    expect(new Set(q9?.rankedAtomIds)).toEqual(new Set([
      '10000000-0000-4000-8000-000000000003',
      '10000000-0000-4000-8000-000000000009',
    ]));

    const q10 = report.perQuery.find(r => r.id === 'q10');
    // atom-005 ('bun run test' command) is lexically related to "Bun" but
    // carries no entity link — it MUST NOT appear once entity=bun filters.
    expect(new Set(q10?.rankedAtomIds)).toEqual(new Set([
      '10000000-0000-4000-8000-000000000004',
      '10000000-0000-4000-8000-000000000009',
    ]));
    expect(q10?.rankedAtomIds).not.toContain('10000000-0000-4000-8000-000000000005');
  });
});

// FEAT-402 slice 2 AC-6: with search.zeta=0 (default), ranking is
// byte-identical to the pre-AC-6 baseline — proven by running the exact same
// ADR-005 corpus + query set through two independently-seeded DBs, one with
// the current defaultConfig().search (zeta: 0) and one with a weights object
// that doesn't carry a `zeta` key at all (the pre-AC-6 shape). If zeta ever
// stopped being a true no-op at 0, this snapshot would catch it immediately.
describe('AC-6: zeta=0 ranking snapshot', () => {
  it('every query\'s ranked order is identical with zeta=0 vs no zeta key at all', async () => {
    const dbWithZetaZero = openDb(':memory:');
    migrate(dbWithZetaZero);
    const reportWithZetaZero = await runRetrievalEval(
      dbWithZetaZero, fakeEmbed, defaultConfig().search, corpus, querySet,
    );

    const dbNoZeta = openDb(':memory:');
    migrate(dbNoZeta);
    const { zeta: _zeta, ...weightsNoZeta } = defaultConfig().search;
    const reportNoZeta = await runRetrievalEval(
      dbNoZeta, fakeEmbed, weightsNoZeta, corpus, querySet,
    );

    expect(reportWithZetaZero.perQuery.map(r => r.rankedAtomIds))
      .toEqual(reportNoZeta.perQuery.map(r => r.rankedAtomIds));
    expect(reportWithZetaZero.meanRecall).toBe(reportNoZeta.meanRecall);
    expect(reportWithZetaZero.meanNdcg).toBe(reportNoZeta.meanNdcg);
  });

  it('zeta defaults to 0 in defaultConfig().search (AC-6 default OFF)', () => {
    expect(defaultConfig().search.zeta).toBe(0);
  });
});

// Issue #26 / ADR-005: cross-encoder rerank stage gate. ADR-005 ruled local
// ships v1 with "no reranker (CPU budget)" — crossEncoder.enabled defaults to
// false, so the reranked path below is exercised explicitly (not via
// defaultConfig()) to prove BOTH states clear the recall@10/NDCG@10 floors
// before the seam is ever flipped on for real traffic. See
// docs/runbooks/cross-encoder-rerank.md for the operator rollout procedure.
describe('issue #26: cross-encoder rerank gate', () => {
  it('crossEncoder.enabled defaults to false (ADR-005: no reranker in v1)', () => {
    expect(defaultConfig().crossEncoder.enabled).toBe(false);
  });

  it('resolveRerankOpts returns undefined when disabled (search() takes zero extra branches)', () => {
    expect(resolveRerankOpts(defaultConfig())).toBeUndefined();
  });

  it('rerank OFF (default): mean recall@10 / NDCG@10 clear the ADR-005 floors', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const report = await runRetrievalEval(db, fakeEmbed, defaultConfig().search, corpus, querySet);
    expect(report.meanRecall).toBeGreaterThanOrEqual(0.9);
    expect(report.meanNdcg).toBeGreaterThanOrEqual(0.7);
  });

  it('rerank ON (mock provider): mean recall@10 / NDCG@10 still clear the ADR-005 floors', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const rerank: RerankOpts = { topK: 50, timeoutMs: 300, provider: new MockCrossEncoderProvider() };
    const report = await runRetrievalEval(db, fakeEmbed, defaultConfig().search, corpus, querySet, 10, rerank);
    expect(report.meanRecall).toBeGreaterThanOrEqual(0.9);
    expect(report.meanNdcg).toBeGreaterThanOrEqual(0.7);
  });

  it('rerank ON via config wiring (resolveRerankOpts) also clears the floors', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const cfg = { ...defaultConfig(), crossEncoder: { enabled: true, provider: 'mock' as const, topK: 50, timeoutMs: 300 } };
    const rerank = resolveRerankOpts(cfg);
    expect(rerank).toBeDefined();
    const report = await runRetrievalEval(db, fakeEmbed, cfg.search, corpus, querySet, 10, rerank);
    expect(report.meanRecall).toBeGreaterThanOrEqual(0.9);
    expect(report.meanNdcg).toBeGreaterThanOrEqual(0.7);
  });
});
