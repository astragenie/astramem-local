-- 046: migration self-heal log (FEAT-495 item 1).
--
-- SQLite has no `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`. schema_version
-- recording a migration as applied does not PROVE its DDL actually landed —
-- a crash between two statements in the same migration file, before
-- better-sqlite3's transaction wrapper commits, or a hand-doctored
-- schema_version row, both leave a column permanently missing with no
-- automatic way to notice. src/storage/migration-self-heal.ts re-derives
-- every ADD COLUMN statement ever shipped across ALL migration files on
-- disk (not just ones applied this boot) and checks each target column's
-- real presence via `pragma_table_info` — re-issuing the exact original
-- ALTER TABLE text for any that's missing, every boot (migrate.ts calls it
-- unconditionally, so this self-heals even on unattended/service boots,
-- unlike doctor which never runs unattended — see CLAUDE.md's "Known open
-- gaps").
--
-- This table makes healed columns visible in retrospect: doctor's
-- "Migration self-heal" check reads it, so an operator running doctor AFTER
-- a boot that healed something can still see WHAT was healed and WHEN,
-- rather than the evidence disappearing the moment the gap is closed. Same
-- append-only, one-row-per-action shape as relation_guard_drops (029) /
-- entity_name_drops (034) / validity_guard_drops (038).
CREATE TABLE migration_self_heal_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  migration_file TEXT NOT NULL,
  "table" TEXT NOT NULL,
  column_name TEXT NOT NULL,
  healed_at INTEGER NOT NULL
);
CREATE INDEX idx_migration_self_heal_log_healed_at ON migration_self_heal_log(healed_at DESC);
