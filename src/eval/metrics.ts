/**
 * Retrieval quality metrics — ADR-005 eval harness.
 *
 * Both metrics operate on a ranked list of atom ids (engine output order)
 * against a graded relevance list (0 = not relevant .. 3 = highly relevant).
 */

export interface GradedRelevance {
  atom_id: string;
  grade: number;
}

/**
 * recall@k — fraction of relevant atoms (grade > 0) that appear in the
 * top-k ranked list. Returns 1 when the query has no relevant atoms
 * (nothing to miss).
 */
export function recallAtK(ranked: string[], graded: GradedRelevance[], k: number): number {
  const relevant = new Set(graded.filter(g => g.grade > 0).map(g => g.atom_id));
  if (relevant.size === 0) return 1;
  const topK = ranked.slice(0, k);
  let found = 0;
  for (const id of topK) {
    if (relevant.has(id)) found++;
  }
  return found / relevant.size;
}

/**
 * NDCG@k with exponential gain (2^grade - 1) and log2(rank+1) discount.
 * Ideal DCG is computed from the graded list sorted descending, so a
 * grade-0 entry contributes nothing to either side. Returns 1 when the
 * query has no relevant atoms.
 */
export function ndcgAtK(ranked: string[], graded: GradedRelevance[], k: number): number {
  const gradeMap = new Map(graded.map(g => [g.atom_id, g.grade]));
  const gain = (grade: number): number => Math.pow(2, grade) - 1;

  let dcg = 0;
  ranked.slice(0, k).forEach((id, i) => {
    dcg += gain(gradeMap.get(id) ?? 0) / Math.log2(i + 2);
  });

  const idealGrades = graded.map(g => g.grade).sort((a, b) => b - a).slice(0, k);
  let idcg = 0;
  idealGrades.forEach((grade, i) => {
    idcg += gain(grade) / Math.log2(i + 2);
  });

  return idcg === 0 ? 1 : dcg / idcg;
}
