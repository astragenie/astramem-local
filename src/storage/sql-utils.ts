/**
 * Small SQL-shape helpers shared across storage repos.
 */

/**
 * Default batch size for {@link chunkedIn} — well under SQLite's
 * SQLITE_MAX_VARIABLE_NUMBER (default 999), leaving headroom for any
 * additional bound params a caller's own query adds (a leading/trailing
 * scalar, etc.). Matches the batch size usefulness.ts's usefulnessScores()
 * already used before this helper was extracted from it (2026-07-15
 * "too many SQL variables" incident fix).
 */
export const CHUNK_IN_BATCH_SIZE = 900;

/**
 * Chunk a large `id IN (...)` list so no single query exceeds SQLite's
 * SQLITE_MAX_VARIABLE_NUMBER — one bound parameter per id overflows that
 * limit the moment a caller passes a full corpus-sized id set (tens of
 * thousands of rows), which throws "too many SQL variables" and, inside a
 * transaction, poisons the whole caller (this exact failure mode first hit
 * usefulness.ts's usefulnessScores() in production, 2026-07-15).
 *
 * `runChunk` receives one batch of ids (`<= batchSize`) plus a pre-built
 * `?,?,?`-style placeholder string sized for that batch's own `IN (${ph})`
 * clause, and returns whatever rows that chunk's query produced. Results
 * from every chunk are concatenated in call order. Any OTHER bound
 * parameters a query needs (a leading/trailing scalar, etc.) are the
 * caller's own closure — this helper only ever chunks the id list itself.
 *
 * No-ops (returns `[]` without preparing a statement) for an empty `ids`
 * list — callers should still short-circuit before calling if they need to
 * distinguish "no ids requested" from "ids requested, none matched".
 */
export function chunkedIn<T>(
  ids: string[],
  runChunk: (batch: string[], placeholders: string) => T[],
  batchSize: number = CHUNK_IN_BATCH_SIZE,
): T[] {
  const out: T[] = [];
  for (let start = 0; start < ids.length; start += batchSize) {
    const batch = ids.slice(start, start + batchSize);
    const placeholders = batch.map(() => '?').join(',');
    out.push(...runChunk(batch, placeholders));
  }
  return out;
}
