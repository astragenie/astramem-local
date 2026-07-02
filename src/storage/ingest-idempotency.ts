/**
 * D-DEF2 fix — `summary_memory_id` backfill.
 *
 * `POST /ingest/transcript` (server/routes/ingest.ts) writes the transcript
 * row's own id into `ingest_idempotency.summary_memory_id` at insert time —
 * distillation is async (queued as a `distill` job), so there is no real
 * memory id yet when the HTTP response is built. That placeholder value was
 * never updated afterwards, so idempotent replays kept returning the
 * transcript id forever, even after distillation produced real memories
 * (CHANGELOG 0.2.0 "Known issues" — D-DEF2: "Wave-3 distillation will
 * produce a real summary memory... semantic meaning will change when
 * distillation is wired end-to-end").
 *
 * This backfills the row once the distill job actually produces a memory.
 * No schema change: `summary_memory_id` already accepts an arbitrary TEXT
 * id (it has never had a FK constraint tying it to `transcripts.id`), so
 * repointing it at a `memories.id` is a value change, not a shape change.
 */

import type { DB } from './db.js';

/**
 * Repoint any `ingest_idempotency` row still holding `transcriptId` as its
 * placeholder `summary_memory_id` to the real `memoryId` produced by
 * distillation. No-op if no such row exists (e.g. the original POST carried
 * no `Idempotency-Key`, so no row was ever created).
 */
export function backfillSummaryMemoryId(db: DB, transcriptId: string, memoryId: string): void {
  db.prepare('UPDATE ingest_idempotency SET summary_memory_id = ? WHERE summary_memory_id = ?')
    .run(memoryId, transcriptId);
}
