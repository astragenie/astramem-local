-- FEAT-409: resumable checkpoint tracking for the embedding-dimension
-- re-embed procedure (`astramem-local reembed-dim`, docs/embed-dim-migration.md).
--
-- sqlite-vec's vec0 virtual table bakes its dim into CREATE VIRTUAL TABLE
-- DDL — there is no ALTER for it. Changing config.embedding.dim against an
-- EXISTING database with live data therefore requires: (1) recreating
-- memories_vec at the new dim (destructive — the pre-change backup is the
-- rollback, per AC-4), then (2) re-embedding every memory's text with the
-- newly-configured provider and upserting into the recreated table.
--
-- Step (2) calls out to the embed provider over the network per memory and
-- can be interrupted (Ctrl+C, crash, transient provider failure). This
-- table is the resumability mechanism: `reembed-dim` commits one row here
-- in the SAME transaction as each memory's vec upsert, so a re-run skips
-- memory ids already checkpointed for the target dim instead of redoing
-- completed work or leaving a memory half-migrated.
--
-- This is intentionally NOT the vector store itself and carries no dim
-- literal of its own — target_dim is data, supplied at runtime by the CLI,
-- not baked into schema (unlike memories_vec, whose dim genuinely must be
-- fixed at CREATE TABLE time for vec0 to work at all).
CREATE TABLE dim_migration_progress (
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  target_dim INTEGER NOT NULL,
  completed_at INTEGER NOT NULL,
  PRIMARY KEY (memory_id, target_dim)
);
CREATE INDEX idx_dim_migration_progress_target ON dim_migration_progress(target_dim);
