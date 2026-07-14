/**
 * FEAT-495 item 3 (beta-hardening bundle): guards for `memory_events.payload_json`.
 *
 * That column is the ONLY JSON column in this codebase fed by BOTH local
 * writers (MemoryEventRepo.append, conflict-resolve.ts's synthetic
 * conflict_merge insert) AND the sync pull path (src/sync/puller.ts's
 * dedupInsertEvent, which inserts a remote device's payload_json verbatim,
 * with no validation — see that function's doc comment). It is then read by
 * several SHARED query paths that scan or aggregate across many rows at
 * once: usefulness stats (src/storage/usefulness.ts), the shipper's
 * ship-eligibility scan (src/sync/shipper.ts), the sync conflict-resolve
 * dedup check, and dashboard/profile queries. A single malformed row from
 * either origin must not break those for every OTHER, healthy row.
 *
 * Confirmed empirically (this worktree, better-sqlite3-multiple-ciphers):
 * `json_extract('not json', '$.x')` THROWS `"malformed JSON"` rather than
 * returning NULL.
 *
 * Corrected 2026-07-14 (per review): SQLite DOES short-circuit an AND on a
 * false leading operand, both in a read query's WHERE clause and in a
 * partial index's own WHERE expression (which is evaluated on every INSERT
 * to decide index membership — see migration 044's header for that half of
 * the story). A malformed-payload row whose `event_type` does NOT match an
 * adjacent `event_type = 'usefulness'` equality predicate does NOT throw —
 * confirmed directly, including through `dedupInsertEvent`'s real
 * INSERT…SELECT…WHERE NOT EXISTS shape. The throw only fires when the
 * malformed row's own `event_type` DOES match that predicate (forcing
 * `json_extract` to actually evaluate the bad payload) — i.e. a malformed
 * `'usefulness'`-typed event, which is exactly the realistic case a
 * corrupted or buggy remote device would produce via sync pull. Guarding
 * unconditionally (not just for that one case) is still correct: it's
 * harmless for event_types that were never at risk, and it protects any
 * query that lacks an index to short-circuit against at all.
 */

/**
 * Wrap a JSON-typed SQL column reference so `json_extract()` against it can
 * never throw. Substitutes the empty-array literal `'[]'` (valid JSON, no
 * matching path) for a row whose stored text isn't valid JSON — the extract
 * then returns NULL for that row exactly as it would for a path that simply
 * doesn't exist, instead of aborting the whole query. Use everywhere
 * `json_extract(<column>, ...)` reads `memory_events.payload_json`.
 *
 * Example: `json_extract(payload_json, '$.family')` becomes
 * `json_extract(${safeJsonColumn('payload_json')}, '$.family')`.
 */
export function safeJsonColumn(column: string): string {
  return `(CASE WHEN json_valid(${column}) THEN ${column} ELSE '[]' END)`;
}

/**
 * Defensive `JSON.parse` for a `memory_events.payload_json` value read back
 * in application code (as opposed to a raw SQL `json_extract`). Same
 * rationale as {@link safeJsonColumn}: a malformed row (local bit-rot, or a
 * remote device's corrupted payload arriving via sync pull) must not throw
 * and abort a caller that's processing many rows in one pass or one
 * transaction — src/sync/shipper.ts's buildEnvelope maps up to a whole ship
 * batch, and src/sync/conflict-resolve.ts's recomputeProjection runs inside
 * the SAME transaction as an entire pull round (src/sync/puller.ts), so an
 * uncaught throw there rolls back every event in that round and re-fetches
 * the same malformed batch forever.
 *
 * Never silently swallows: `onError`, when supplied, is always invoked with
 * the parse error so the caller can log it (this repo's dominant bug class
 * is a check that runs and reports healthy while the thing it guards is
 * broken — a caught-and-unlogged parse failure would be exactly that).
 * Returns `null` for both a null input and a parse failure — callers that
 * need to tell those apart should check `raw` themselves before calling.
 */
export function safeParseEventPayload(
  raw: string | null,
  onError?: (err: unknown) => void,
): Record<string, unknown> | null {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    onError?.(err);
    return null;
  }
}
