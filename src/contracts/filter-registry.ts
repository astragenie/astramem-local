/**
 * Filter-descriptor registry (FEAT-429).
 *
 * Problem this collapses: before this file, adding one recall/search filter
 * signal (project, agent, entity, ...) meant hand-editing the same pattern in
 * lockstep across the Zod contract (src/contracts/recall-filters.ts), the
 * GET /search query-string parser, the POST /recall body parser, the MCP
 * `search_memory`/`recall_memory` tool schemas, and the post-fusion SQL
 * WHERE-clause builder in src/search/search.ts. Missing any one silently
 * degrades a surface — see FEAT-424 (cross-surface drift) and the FEAT-429
 * arch-review finding that motivated this file.
 *
 * A `FilterDescriptor` is the single declaration of one filter signal: its
 * wire name, its Zod value shape, how a raw GET query-string value parses
 * into that shape, how a structured (already-parsed) value is recognized as
 * "present" (mirrors the exact truthy/`!== undefined` checks the hand-rolled
 * code used per field, preserved here for byte-identical behavior), and how
 * it composes into the SQL WHERE clause (a plain equals/IN column, or
 * `'custom'` for filters like `entity` that resolve through a side table
 * before fusion rather than a plain `WHERE col = ?`).
 *
 * Every function below is generic over an explicit `descriptors` array
 * (defaulting to the shared `RECALL_FILTER_REGISTRY`), so a descriptor-only
 * addition — including one defined only inside a test — drives parsing +
 * SQL end-to-end without touching any of these functions.
 *
 * To add a new hard-filter SQL-column signal: add one
 * `stringOrListColumnFilter({...})` entry to `RECALL_FILTER_REGISTRY` below
 * (plus a migration if it needs a new column). Every surface that calls
 * `assignQueryFilterValues` / `assignStructuredFilterValues` /
 * `applySqlColumnFilters` / `buildFilterFieldsSchema` picks it up for free.
 */
import { z } from 'zod';

/** How a filter's wire value is shaped. */
export type FilterValueShape = 'stringOrList' | 'scalarString' | 'scalarNumber';

/** How a filter composes into the post-fusion SQL WHERE clause. */
export type FilterApply =
  /** Plain `col = ?` (single value) or `col IN (...)` (list, OR-semantics). */
  | { kind: 'sqlColumn'; column: string }
  /**
   * Numeric comparison column (FEAT-429 SLICE-B) — `col >= ?`. Narrowly
   * typed to the one operator `since` actually needs rather than a generic
   * operator-string field; a second distinct comparison shape showing up
   * later is the trigger to reconsider this, not a reason to generalize now.
   */
  | { kind: 'sqlRangeColumn'; column: string; op: 'gte' }
  /** Resolved through custom logic (e.g. entity -> EntityRepo candidate-set
   *  intersection) rather than a plain SQL column — the registry still
   *  enumerates it for schema/parsing derivation, but SQL-builder helpers
   *  below skip it (the surface applies its own resolution). */
  | { kind: 'custom' };

export interface FilterDescriptor {
  /** Wire field name — shared verbatim across query params, JSON body, and MCP tool args. */
  readonly name: string;
  readonly valueShape: FilterValueShape;
  /** Zod schema for this field, reused by every surface's input schema. */
  readonly schema: z.ZodTypeAny;
  readonly apply: FilterApply;
  /** All current filters AND-compose with every other active filter. */
  readonly compose: 'AND';
  readonly description: string;
  /**
   * Presence predicate for a value that has already been parsed into its
   * wire shape (JSON body / MCP args). Mirrors the exact per-field check the
   * hand-rolled parsing used before this registry existed — `project`/`agent`
   * used a truthy check (so an explicit `''` is treated as absent), `entity`
   * used `!== undefined` (so an explicit `''` is a filter that resolves to
   * zero results, not "absent"). Preserved here, not "fixed", to stay
   * byte-identical (FEAT-429 AC: behavior-preserving).
   */
  presentInStructured(value: unknown): boolean;
  /**
   * Parse a raw GET query-string value into this filter's wire shape.
   * Only invoked when the raw string is non-empty (callers gate on
   * `if (raw) ...`), matching the pre-registry per-field truthy check.
   * Returns `undefined` to mean "no constraint" (e.g. an all-empty CSV list).
   */
  parseQueryValue(raw: string): unknown;
}

/**
 * `col,col2,col3` -> `string[]` (IN, OR-semantics); a single value stays a
 * bare `string` (`col = ?`); empty/whitespace-only segments are dropped; an
 * all-empty value yields `undefined` (no constraint). Shared by every
 * `stringOrList` filter (FEAT-423's original `csvFilter` generalized).
 */
function csvToStringOrList(raw: string): string | string[] | undefined {
  const parts = raw.split(',').map(s => s.trim()).filter(Boolean);
  if (parts.length === 0) return undefined;
  return parts.length === 1 ? parts[0] : parts;
}

/** Descriptor factory for a `string | string[]` hard SQL-column filter (project, agent, ...). */
function stringOrListColumnFilter(opts: { name: string; column: string; description: string }): FilterDescriptor {
  return {
    name: opts.name,
    valueShape: 'stringOrList',
    schema: z.union([z.string(), z.array(z.string())]).optional(),
    apply: { kind: 'sqlColumn', column: opts.column },
    compose: 'AND',
    description: opts.description,
    presentInStructured: (value) => Boolean(value),
    parseQueryValue: csvToStringOrList,
  };
}

/** Descriptor factory for a scalar-string filter resolved via custom (non-column) logic (entity, ...). */
function scalarCustomFilter(opts: { name: string; description: string }): FilterDescriptor {
  return {
    name: opts.name,
    valueShape: 'scalarString',
    schema: z.string().optional(),
    apply: { kind: 'custom' },
    compose: 'AND',
    description: opts.description,
    presentInStructured: (value) => value !== undefined,
    parseQueryValue: (raw) => raw,
  };
}

/**
 * Descriptor factory for a scalar-string `col = ?` filter (repo, ...) —
 * structurally identical to `stringOrListColumnFilter` except the wire value
 * is always a single string, never a CSV-parsed list (FEAT-429 SLICE-A: repo
 * has no OR-list semantics today). Presence check mirrors project/agent's
 * truthy check (an explicit `''` is "absent"), matching repo's pre-registry
 * hand-rolled `if (params.repo) ...` / `if (rawFilters?.repo) ...` gates.
 */
function scalarColumnFilter(opts: { name: string; column: string; description: string }): FilterDescriptor {
  return {
    name: opts.name,
    valueShape: 'scalarString',
    schema: z.string().optional(),
    apply: { kind: 'sqlColumn', column: opts.column },
    compose: 'AND',
    description: opts.description,
    presentInStructured: (value) => Boolean(value),
    parseQueryValue: (raw) => raw,
  };
}

/**
 * Descriptor factory for a numeric `col >= ?` lower-bound filter (since, ...)
 * (FEAT-429 SLICE-B). Presence check uses `!== undefined` (matches since's
 * pre-registry `if (rawFilters?.since !== undefined) ...` structured gate —
 * `0` is a legitimate epoch-ms lower bound, not "absent"). `parseQueryValue`
 * mirrors the pre-registry `Number(raw)` parse exactly, including silently
 * dropping an unparseable value (`NaN` -> `undefined`, no 400) rather than
 * throwing — byte-identical to the old GET /search `if (!isNaN(sinceNum))` gate.
 */
function numericRangeColumnFilter(opts: { name: string; column: string; description: string }): FilterDescriptor {
  return {
    name: opts.name,
    valueShape: 'scalarNumber',
    schema: z.number().optional(),
    apply: { kind: 'sqlRangeColumn', column: opts.column, op: 'gte' },
    compose: 'AND',
    description: opts.description,
    presentInStructured: (value) => value !== undefined,
    parseQueryValue: (raw) => {
      const n = Number(raw);
      return Number.isNaN(n) ? undefined : n;
    },
  };
}

/**
 * The production recall-filter registry (FEAT-429). Migrated from FEAT-423/
 * FEAT-424's hand-rolled project/agent/entity wiring — see
 * src/contracts/recall-filters.ts for the canonical-contract mirror these
 * schemas are drawn from.
 */
export const RECALL_FILTER_REGISTRY: readonly FilterDescriptor[] = [
  stringOrListColumnFilter({
    name: 'project',
    column: 'project',
    description: 'Filter by project name(s) — string or list (OR)',
  }),
  stringOrListColumnFilter({
    name: 'agent',
    column: 'agent',
    description: 'Filter by provenance agent/agent_type — string or list (OR)',
  }),
  scalarCustomFilter({
    name: 'entity',
    description:
      'Entity name filter (FEAT-402); resolved via the normalize seam (case/whitespace-insensitive, exact match then substring fallback). Unresolvable names yield zero results.',
  }),
  scalarColumnFilter({
    name: 'repo',
    column: 'repo',
    description: 'Filter by repo name — scalar exact match (no OR-list)',
  }),
  numericRangeColumnFilter({
    name: 'since',
    column: 'created_at',
    description: 'Filter to memories created at or after this epoch-ms timestamp (lower bound, inclusive)',
  }),
] as const;

/** Look up a single descriptor's schema by wire name (throws if unknown — programmer error, not a wire-input error). */
export function getFilterSchema(
  name: string,
  descriptors: readonly FilterDescriptor[] = RECALL_FILTER_REGISTRY
): z.ZodTypeAny {
  const d = descriptors.find(x => x.name === name);
  if (!d) throw new Error(`filter-registry: unknown descriptor "${name}"`);
  return d.schema;
}

/**
 * Build a `z.object({...})` shape from every descriptor's schema — the
 * registry-driven replacement for hand-assembling `{ project, agent, entity }`
 * object schemas at each call site (route body schema, MCP tool inputSchema).
 */
export function buildFilterFieldsSchema<D extends readonly FilterDescriptor[]>(
  descriptors: D = RECALL_FILTER_REGISTRY as unknown as D
): z.ZodObject<Record<D[number]['name'], z.ZodTypeAny>> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const d of descriptors) shape[d.name] = d.schema;
  return z.object(shape) as z.ZodObject<Record<D[number]['name'], z.ZodTypeAny>>;
}

/**
 * Assign every present, already-structured filter value (JSON body / MCP
 * args, already validated by each descriptor's `schema`) from `raw` onto
 * `target`, using each descriptor's `presentInStructured` predicate. Mutates
 * `target` in place (matches the pre-registry `if (x) filters.x = ...` style
 * so call sites can keep building a single `filters` object incrementally).
 */
export function assignStructuredFilterValues(
  raw: Record<string, unknown> | undefined,
  target: Record<string, unknown>,
  descriptors: readonly FilterDescriptor[] = RECALL_FILTER_REGISTRY
): void {
  if (!raw) return;
  for (const d of descriptors) {
    const value = raw[d.name];
    if (d.presentInStructured(value)) target[d.name] = value;
  }
}

/**
 * Assign every present GET query-string filter value from `params` onto
 * `target`. A field is only parsed when its raw string is non-empty (the
 * pre-registry `if (params.x) ...` truthy gate), then `parseQueryValue`
 * converts it into the filter's wire shape.
 */
export function assignQueryFilterValues(
  params: Record<string, string | undefined>,
  target: Record<string, unknown>,
  descriptors: readonly FilterDescriptor[] = RECALL_FILTER_REGISTRY
): void {
  for (const d of descriptors) {
    const raw = params[d.name];
    if (raw) {
      const parsed = d.parseQueryValue(raw);
      if (parsed !== undefined) target[d.name] = parsed;
    }
  }
}

/**
 * Derive the post-fusion SQL WHERE-clause fragments + bound params for every
 * `'sqlColumn'`-kind descriptor present in `filters` — the registry-driven
 * replacement for src/search/search.ts's hand-rolled `addEqOrIn` helper.
 * `'custom'`-kind descriptors (e.g. `entity`) are skipped here; their
 * surface applies its own resolution (candidate-set intersection, etc.)
 * before or after this call as appropriate.
 *
 * A single value produces `col = ?`; a non-empty array produces
 * `col IN (...)` (OR-semantics); an empty array is treated as "no
 * constraint" (skipped), never "match nothing" — mirrors FEAT-423's
 * `type[]` / `project`/`agent` semantics exactly.
 */
export function applySqlColumnFilters(
  filters: Record<string, unknown>,
  descriptors: readonly FilterDescriptor[] = RECALL_FILTER_REGISTRY
): { clauses: string[]; params: (string | number)[] } {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  for (const d of descriptors) {
    if (d.apply.kind !== 'sqlColumn') continue;
    const value = filters[d.name];
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      clauses.push(`${d.apply.column} IN (${value.map(() => '?').join(',')})`);
      params.push(...(value as Array<string | number>));
    } else {
      clauses.push(`${d.apply.column} = ?`);
      params.push(value as string | number);
    }
  }
  return { clauses, params };
}

/**
 * Derive the post-fusion SQL WHERE-clause fragments + bound params for every
 * `'sqlRangeColumn'`-kind descriptor present in `filters` (FEAT-429 SLICE-B)
 * — parallel to `applySqlColumnFilters` above but for numeric comparison
 * filters (e.g. `since` -> `created_at >= ?`) rather than equality/IN-list
 * filters. A separate function rather than widening `applySqlColumnFilters`
 * itself, since the equal/IN-only callers of that function should not need
 * to reason about a comparison operator.
 */
export function applySqlRangeFilters(
  filters: Record<string, unknown>,
  descriptors: readonly FilterDescriptor[] = RECALL_FILTER_REGISTRY
): { clauses: string[]; params: (string | number)[] } {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  for (const d of descriptors) {
    if (d.apply.kind !== 'sqlRangeColumn') continue;
    const value = filters[d.name];
    if (value === undefined) continue;
    const sqlOp = d.apply.op === 'gte' ? '>=' : d.apply.op;
    clauses.push(`${d.apply.column} ${sqlOp} ?`);
    params.push(value as string | number);
  }
  return { clauses, params };
}
