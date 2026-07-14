/**
 * Post-migration self-heal (FEAT-495 item 1): schema_version recording a
 * migration as applied does not prove its DDL actually landed on THIS
 * database. SQLite has no `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, so a
 * partially-applied migration (e.g. a crash between two ALTER TABLE
 * statements in the same file, before the transaction wrapping migrate()'s
 * loop commits) leaves a column permanently missing with no automatic
 * recovery — otherwise unrecoverable without an operator hand-editing the
 * schema.
 *
 * Re-derives every `ALTER TABLE <table> ADD COLUMN <column> ...` statement
 * ever shipped by scanning ALL migration files on disk (not just ones
 * applied this boot — the gap could have been introduced by a migration
 * from months ago), checks each target column's real presence via
 * `pragma_table_info`, and re-issues the exact original ALTER TABLE text for
 * any that's missing. A table the ALTER TABLE targets no longer existing at
 * all (dropped by a later migration — migrations/040-drop-dead-tables.sql)
 * is skipped, not an error: its columns were deliberately removed along with
 * it, there is nothing to heal.
 *
 * Called unconditionally from migrate() (this repo's one boot-time DDL
 * entrypoint every caller already goes through), NOT gated behind doctor —
 * doctor never runs unattended (see CLAUDE.md's "Known open gaps"), so a
 * self-heal that only doctor could trigger would never fire on a real
 * service boot.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DB } from './db.js';
import { MIGRATIONS_DIR } from './schema-version.js';

const ADD_COLUMN_RE = /ALTER TABLE\s+(\w+)\s+ADD COLUMN\s+(\w+)\s+[^;]+;/gi;

export interface AddColumnStatement {
  migrationFile: string;
  table: string;
  column: string;
  /** Verbatim `ALTER TABLE ... ;` text from the migration file, ready to re-execute as-is. */
  statement: string;
}

/** Extract every ADD COLUMN statement from one migration file's raw SQL text. */
export function extractAddColumnStatements(sql: string, migrationFile: string): AddColumnStatement[] {
  const out: AddColumnStatement[] = [];
  for (const match of sql.matchAll(ADD_COLUMN_RE)) {
    const table = match[1];
    const column = match[2];
    if (!table || !column) continue;
    out.push({ migrationFile, table, column, statement: match[0].trim() });
  }
  return out;
}

function tableExists(db: DB, table: string): boolean {
  return db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table) !== undefined;
}

function columnExists(db: DB, table: string): Set<string> {
  // Table name is NOT a bind parameter — PRAGMA doesn't support parameter
  // binding — but every caller here sources `table` from our OWN migration
  // files on disk (regex-extracted, not user/network input), never from an
  // external source, so string interpolation is safe (matches migrate.ts's
  // own existing pattern for building migration DDL from disk content).
  const rows = db.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[];
  return new Set(rows.map(r => r.name));
}

export interface SelfHealAction {
  migrationFile: string;
  table: string;
  column: string;
}

/**
 * Run the self-heal pass: for every ADD COLUMN statement across every
 * migration file on disk, re-apply it if (and only if) the target table
 * exists and the target column is missing. Returns the list of actions
 * actually taken (empty when the schema is fully healthy, the common case).
 */
export function selfHealMissingColumns(db: DB): SelfHealAction[] {
  const files = readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
  const actions: SelfHealAction[] = [];
  const columnsByTable = new Map<string, Set<string>>();

  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    for (const stmt of extractAddColumnStatements(sql, file)) {
      if (!tableExists(db, stmt.table)) continue; // dropped by a later migration — not a gap

      let cols = columnsByTable.get(stmt.table);
      if (!cols) {
        cols = columnExists(db, stmt.table);
        columnsByTable.set(stmt.table, cols);
      }
      if (cols.has(stmt.column)) continue; // already present — nothing to heal

      db.exec(stmt.statement);
      cols.add(stmt.column); // keep the cache correct if this table is touched again later in the scan
      actions.push({ migrationFile: stmt.migrationFile, table: stmt.table, column: stmt.column });
    }
  }
  return actions;
}

/** Append one row per healed column, so doctor can show what was healed and when — even after the gap is already closed. */
export function recordSelfHealActions(db: DB, actions: SelfHealAction[], healedAt: number = Date.now()): void {
  if (actions.length === 0) return;
  const stmt = db.prepare(
    `INSERT INTO migration_self_heal_log (migration_file, "table", column_name, healed_at) VALUES (?, ?, ?, ?)`,
  );
  const tx = db.transaction((rows: SelfHealAction[]) => {
    for (const a of rows) stmt.run(a.migrationFile, a.table, a.column, healedAt);
  });
  tx(actions);
}

export interface SelfHealLogRow {
  migrationFile: string;
  table: string;
  column: string;
  healedAt: number;
}

/** Most recent N healed-column rows, newest first. Empty when self-heal has never fired. */
export function recentSelfHealActions(db: DB, limit = 20): SelfHealLogRow[] {
  const rows = db.prepare(`
    SELECT migration_file, "table", column_name, healed_at
    FROM migration_self_heal_log
    ORDER BY healed_at DESC, id DESC
    LIMIT ?
  `).all(limit) as { migration_file: string; table: string; column_name: string; healed_at: number }[];
  return rows.map(r => ({ migrationFile: r.migration_file, table: r.table, column: r.column_name, healedAt: r.healed_at }));
}
