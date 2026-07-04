/**
 * Entity name normalization — the single seam AC-9 requires.
 *
 * Every caller that resolves an entity name to an `entities.id` (distill-time
 * extraction in stage 8, the entity-backfill command, and — in slice 2 — the
 * search `entity=` filter) MUST go through this function first. Today it is
 * lowercase + trim + whitespace-collapse only, so "Postgres" / "postgres" /
 * "  Postgres  " collapse to the same normalized name and therefore the same
 * `entities.id` via the UNIQUE constraint on `entities.name`.
 *
 * An alias table ("pg" -> "postgres", "postgres flexible" -> "postgres") is
 * explicitly deferred (FEAT-402 AC-9, roadmap W4.x) but this function is
 * where it plugs in later — swap the body for a dictionary/DB lookup and
 * every call site (extraction, backfill, future query filter) inherits it
 * without a single call-site edit.
 */
export function normalizeEntityName(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, ' ');
}
