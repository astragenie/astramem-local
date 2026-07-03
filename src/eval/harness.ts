/**
 * ADR-005 retrieval eval harness.
 *
 * Seeds the shared eval corpus (contracts/fixtures/eval/corpus.json) into a
 * live database, runs the shared query set through the local search engine,
 * and scores recall@k / NDCG@k against the graded relevance judgments.
 *
 * Known v1 engine gaps, handled explicitly rather than silently:
 *  - per-query `mode` (keyword|semantic|hybrid) is advisory only; the local
 *    engine always runs its hybrid FTS+vector path. The mode is echoed in
 *    the per-query report so a future mode-routing engine can be compared.
 *
 * FEAT-401: `as_of` (bitemporal time-travel) is now supported end-to-end —
 * seedEvalCorpus backfills each atom's declared valid_from (in addition to
 * valid_to) so corpus atoms carry their fixture-declared validity windows
 * rather than the insert-time "now", and runRetrievalEval forwards
 * `filters.as_of` straight into search() instead of skipping the query.
 */

import type { DB } from '../storage/db.js';
import type { EmbedProvider, MemoryType } from '../contracts/index.js';
import { MemoryRepo } from '../storage/memories.js';
import { SqliteVecStore } from '../vector/sqlite-vec.js';
import { search, parseAsOf } from '../search/search.js';
import { recallAtK, ndcgAtK, type GradedRelevance } from './metrics.js';

export interface EvalAtom {
  id: string;
  type: string;
  text: string;
  evidence: string | string[] | null;
  confidence: number;
  importance: number;
  provenance: { session_id: string; repo: string; project: string };
  /** Bitemporal valid-time start (ADR-001). Optional for pre-FEAT-401 fixtures. */
  valid_from?: string;
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
  const vecStore = new SqliteVecStore(db, embed.dim);
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
    // FEAT-401: backfill the fixture-declared valid_from/valid_to so corpus
    // atoms carry their real bitemporal windows instead of insert-time "now"
    // — required for as_of queries (q6) to resolve against the right
    // generation. valid_from mirrors created_at on a fresh insert, so only
    // rewrite it when the fixture declares a different instant.
    if (atom.valid_from !== undefined) {
      db.prepare('UPDATE memories SET valid_from = ? WHERE id = ?')
        .run(Date.parse(atom.valid_from), memId);
    }
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
  // epsilon (ADR-010 usefulness component) is part of the fused score — the
  // eval must exercise the same weight set production search uses, not a
  // narrower structural subset that only works by accident.
  weights: { alpha: number; beta: number; gamma: number; delta: number; epsilon: number },
  corpus: EvalCorpus,
  querySet: EvalQuerySet,
  k = 10,
): Promise<EvalReport> {
  const memToAtom = await seedEvalCorpus(db, embed, corpus);

  const perQuery: QueryResult[] = [];
  for (const q of querySet.queries) {
    const as_of = q.filters.as_of !== undefined ? parseAsOf(q.filters.as_of) : undefined;
    const hits = await search(q.text, { type: q.filters.type, as_of }, k, { db, embed, weights });
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
