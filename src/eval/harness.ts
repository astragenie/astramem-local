/**
 * ADR-005 retrieval eval harness.
 *
 * Seeds the shared eval corpus (contracts/fixtures/eval/corpus.json) into a
 * live database, runs the shared query set through the local search engine,
 * and scores recall@k / NDCG@k against the graded relevance judgments.
 *
 * Known v1 engine gaps, handled explicitly rather than silently:
 *  - `as_of` (bitemporal time-travel) is not supported by search() — queries
 *    carrying an as_of filter are reported as skipped with a reason.
 *  - per-query `mode` (keyword|semantic|hybrid) is advisory only; the local
 *    engine always runs its hybrid FTS+vector path. The mode is echoed in
 *    the per-query report so a future mode-routing engine can be compared.
 */

import type { DB } from '../storage/db.js';
import type { EmbedProvider, MemoryType } from '../contracts/index.js';
import { MemoryRepo } from '../storage/memories.js';
import { SqliteVecStore } from '../vector/sqlite-vec.js';
import { search } from '../search/search.js';
import { recallAtK, ndcgAtK, type GradedRelevance } from './metrics.js';

export interface EvalAtom {
  id: string;
  type: string;
  text: string;
  evidence: string | string[] | null;
  confidence: number;
  importance: number;
  provenance: { session_id: string; repo: string; project: string };
  valid_to: string | null;
  scope: string;
  content_hash: string;
}

export interface EvalQuery {
  id: string;
  text: string;
  mode: string;
  filters: { type?: string[]; as_of?: string };
  graded_relevant: GradedRelevance[];
}

export interface EvalCorpus { atoms: EvalAtom[] }
export interface EvalQuerySet { queries: EvalQuery[] }

export interface QueryResult {
  id: string;
  mode: string;
  skipped: string | null;
  recall: number | null;
  ndcg: number | null;
  rankedAtomIds: string[];
}

export interface EvalReport {
  k: number;
  perQuery: QueryResult[];
  evaluated: number;
  skipped: number;
  meanRecall: number;
  meanNdcg: number;
}

/**
 * Insert every corpus atom into the DB (memories + FTS via trigger + vector
 * index). Returns memory-id → atom-id so engine hits can be scored against
 * the corpus judgments. Atoms with a non-null valid_to are marked
 * invalidated after insert, matching their bitemporal state.
 */
export async function seedEvalCorpus(
  db: DB,
  embed: EmbedProvider,
  corpus: EvalCorpus,
): Promise<Map<string, string>> {
  const repo = new MemoryRepo(db);
  const vecStore = new SqliteVecStore(db);
  const memToAtom = new Map<string, string>();

  for (const atom of corpus.atoms) {
    const memId = repo.insert({
      type: atom.type as MemoryType,
      text: atom.text,
      normalized_text: atom.text.toLowerCase(),
      repo: atom.provenance.repo,
      project: atom.provenance.project,
      branch: null,
      agent: null,
      // corpus session ids don't exist in the sessions table (FK) — seed detached
      session_id: null,
      hash: atom.content_hash,
      source_hash: null,
      importance: atom.importance,
      confidence: atom.confidence,
      evidence: Array.isArray(atom.evidence) ? atom.evidence.join('; ') : atom.evidence,
      scope: atom.scope as 'personal' | 'team' | 'org',
    });
    if (atom.valid_to !== null) {
      db.prepare('UPDATE memories SET valid_to = ? WHERE id = ?')
        .run(Date.parse(atom.valid_to), memId);
    }
    const [vec] = await embed.embed([atom.text]);
    if (!vec) throw new Error(`embed returned no vector for atom ${atom.id}`);
    await vecStore.upsert(memId, vec);
    memToAtom.set(memId, atom.id);
  }

  return memToAtom;
}

export async function runRetrievalEval(
  db: DB,
  embed: EmbedProvider,
  weights: { alpha: number; beta: number; gamma: number; delta: number },
  corpus: EvalCorpus,
  querySet: EvalQuerySet,
  k = 10,
): Promise<EvalReport> {
  const memToAtom = await seedEvalCorpus(db, embed, corpus);

  const perQuery: QueryResult[] = [];
  for (const q of querySet.queries) {
    if (q.filters.as_of !== undefined) {
      perQuery.push({
        id: q.id, mode: q.mode,
        skipped: 'as_of (bitemporal time-travel) not supported by local engine v1',
        recall: null, ndcg: null, rankedAtomIds: [],
      });
      continue;
    }

    const hits = await search(q.text, { type: q.filters.type }, k, { db, embed, weights });
    const rankedAtomIds = hits
      .map(h => memToAtom.get(h.id))
      .filter((id): id is string => id !== undefined);

    perQuery.push({
      id: q.id, mode: q.mode, skipped: null,
      recall: recallAtK(rankedAtomIds, q.graded_relevant, k),
      ndcg: ndcgAtK(rankedAtomIds, q.graded_relevant, k),
      rankedAtomIds,
    });
  }

  const evaluated = perQuery.filter(r => r.skipped === null);
  const mean = (xs: number[]): number =>
    xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;

  return {
    k,
    perQuery,
    evaluated: evaluated.length,
    skipped: perQuery.length - evaluated.length,
    meanRecall: mean(evaluated.map(r => r.recall as number)),
    meanNdcg: mean(evaluated.map(r => r.ndcg as number)),
  };
}
