/**
 * runTypeBackfillBatch — FEAT-552 sub-scope B (AC-B2) core, DB-only and
 * CLI-independent (same shape as `src/tag-hygiene/backfill.ts` /
 * `src/entity/backfill.ts`) so it's directly unit-testable without spawning
 * the daemon or a CLI process.
 *
 * One-shot, operator-invoked re-typing of EXISTING stored atoms using the
 * exact same deterministic rules module (`src/distill/type-hints.ts`)
 * already applied at distill time (07-memory-normalize.ts) — retroactively
 * fixing atoms that predate this tier, or that were extracted while
 * `distill.typeHints` was 'off'. Zero LLM calls.
 *
 * Batched by rowid (never the whole table at once) so a caller can persist
 * `lastRowid` as a resumable checkpoint between calls — an interrupted
 * --apply run (process killed mid-batch) resumes from the last COMPLETED
 * batch rather than re-scanning the whole corpus or, worse, silently
 * skipping unexamined rows. See src/cli/backfill-types.ts for the
 * checkpoint-file wrapper.
 *
 * Only ever touches `memories.type` + `memories.updated_at` — text,
 * normalized_text, hash, and the vector index are never read for a WRITE
 * here (only `type`/`normalized_text` are read, to compute the candidate
 * hint) and never mutated. Asserted directly in
 * tests/storage/backfill-types.test.ts (content_hash + vec rowids unchanged
 * across an --apply run on a seeded DB).
 *
 * Each applied change appends a correction-style `usefulness` event via the
 * existing memory_events machinery (MemoryEventRepo.append — no new event
 * type, no new table, no migration) tagged `family: 'type_corrected'` and
 * `source: 'type-backfill'`. Deliberately NOT `family: 'memory_corrected'`
 * (the invalidate/supersede negative-usefulness-signal family
 * src/storage/usefulness.ts's feedback-loop queries count against an atom)
 * — a type retag is a metadata correction, not "this memory was wrong,"
 * and must not silently poison usefulness scoring or the
 * distinctCorrectedAtoms canary for atoms that were simply mistyped.
 */

import type { DB } from '../storage/db.js';
import type { MemoryEventRepo } from '../storage/memory-events.js';
import { getTypeHint } from './type-hints.js';

export interface BackfillTypesBatchOptions {
  /** When false (dry-run, the CLI default), candidates are computed and
   *  returned but no row is mutated and no event is appended. */
  apply: boolean;
  /** Max rows examined THIS call. */
  batchSize: number;
  /** Resume point — only rows with rowid > startAfterRowid are considered.
   *  Pass 0 (or omit) to scan from the beginning. */
  startAfterRowid?: number;
}

export interface TypeChangeCandidate {
  id: string;
  rowid: number;
  fromType: string;
  toType: string;
  matchedPattern: string;
  /** True only when `apply: true` was set AND this row was actually mutated. */
  applied: boolean;
}

export interface BackfillTypesBatchResult {
  /** Rows examined this batch (including ones that needed no change). */
  scanned: number;
  /** Rows actually mutated this batch (0 in dry-run mode by construction). */
  changed: number;
  candidates: TypeChangeCandidate[];
  /** would-change census: fromType -> toType -> count, for every candidate
   *  found this batch (dry-run or apply — computed either way). */
  census: Record<string, Record<string, number>>;
  /** Highest rowid examined this batch — persist as the next call's
   *  `startAfterRowid` to resume. Equal to the input `startAfterRowid` when
   *  this batch examined zero rows (already exhausted). */
  lastRowid: number;
  /** True when this batch returned fewer rows than `batchSize` — the scan
   *  has reached the end of the table, nothing more to resume. */
  exhausted: boolean;
}

interface CandidateRow {
  rowid: number;
  id: string;
  type: string;
  normalized_text: string;
}

/**
 * Examine up to `opts.batchSize` memories (ordered by rowid, resuming after
 * `opts.startAfterRowid`), compute a type-hint candidate for each, and —
 * when `opts.apply` is true — mutate + log an audit event for every atom
 * whose hint disagrees with its stored type. Never touches an already
 * invalidated/superseded/archived/erased row (`valid_to IS NULL` scope,
 * same convention every other candidate-selection query in this codebase
 * uses) — retyping a row that is no longer current serves no purpose.
 */
export function runTypeBackfillBatch(
  db: DB,
  events: MemoryEventRepo,
  opts: BackfillTypesBatchOptions,
): BackfillTypesBatchResult {
  const startAfterRowid = opts.startAfterRowid ?? 0;
  const batchSize = Math.max(1, opts.batchSize);

  const rows = db
    .prepare(`
      SELECT rowid, id, type, normalized_text FROM memories
      WHERE rowid > ? AND valid_to IS NULL
      ORDER BY rowid ASC
      LIMIT ?
    `)
    .all(startAfterRowid, batchSize) as CandidateRow[];

  const updateStmt = db.prepare('UPDATE memories SET type = ?, updated_at = ? WHERE id = ?');

  const candidates: TypeChangeCandidate[] = [];
  const census: Record<string, Record<string, number>> = {};
  let changed = 0;
  let lastRowid = startAfterRowid;

  for (const row of rows) {
    lastRowid = row.rowid;

    const hint = getTypeHint(row.normalized_text);
    if (!hint || hint.hint === row.type) continue;

    const fromCensus = (census[row.type] ??= {});
    fromCensus[hint.hint] = (fromCensus[hint.hint] ?? 0) + 1;

    let applied = false;
    if (opts.apply) {
      const now = Date.now();
      updateStmt.run(hint.hint, now, row.id);
      events.append({
        event_type: 'usefulness',
        atom_id: row.id,
        payload: {
          family: 'type_corrected',
          action: 'retype',
          from: row.type,
          to: hint.hint,
          matched_pattern: hint.matchedPattern,
          source: 'type-backfill',
        },
        created_at: now,
      });
      applied = true;
      changed++;
    }

    candidates.push({
      id: row.id,
      rowid: row.rowid,
      fromType: row.type,
      toType: hint.hint,
      matchedPattern: hint.matchedPattern,
      applied,
    });
  }

  return {
    scanned: rows.length,
    changed,
    candidates,
    census,
    lastRowid,
    exhausted: rows.length < batchSize,
  };
}
