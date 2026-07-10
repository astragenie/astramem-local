/**
 * Named retrieval presets (FEAT-454) — a small, discoverable UX layer over
 * capability the daemon already has, not a new retrieval engine.
 *
 * `preset` is deliberately NOT named `mode`: `mode` is a live, required field
 * in the shared cross-product retrieval-query contract with different
 * semantics (`keyword|semantic|hybrid` routing, driven cloud-side by
 * `SearchQuery.cs`/`MemoryQueryService.cs`) — reusing the name here would
 * collide with it. This FEAT is scoped **local + MCP-only**; there is no
 * shared-contract schema change and no cloud mirroring (see FEAT-454).
 *
 *   - `default`  today's fusion weights, unmodified — byte-identical ranking
 *                (AC-1 snapshot test: tests/eval/retrieval-eval.test.ts).
 *   - `recent`   freshness-weighted — boosts the δ (freshness) fusion weight
 *                so newer memories rank higher.
 *   - `exact`    BM25-first — boosts the α (lexical) fusion weight so literal
 *                term matches dominate over semantic similarity.
 *   - `entity`   routes to the existing entity filter (`SearchFilters.entity`,
 *                src/search/search.ts:75-85); requires the caller to also
 *                supply `filters.entity` — there is no default entity to
 *                scope to, so an entity-preset query without one is a 400,
 *                not a silent no-op (AC-3).
 *   - `temporal` routes to the existing bitemporal filter
 *                (`SearchFilters.as_of`, src/search/search.ts:190-195);
 *                requires `filters.as_of` for the same reason. Architecture
 *                review decision (AC-3): a temporal query with no point in
 *                time to travel to is a caller error, not an accidental
 *                fallback to "now" — that fallback would silently reinterpret
 *                a scoping mistake as an unscoped current-snapshot query.
 *
 * Every preset's weights are built by scaling the CALLER's own resolved base
 * weights — never a hand-rolled literal — and the result is always re-run
 * through `applyFusionGovernance` (src/config/config.ts:334, AC-2). For
 * `default`/`entity`/`temporal` (no weight scaling) that governance pass is a
 * no-op on already-governed input, which is what makes AC-1's byte-identical
 * guarantee structural rather than incidental — the same path a scaled
 * preset goes through simply has nothing to clamp.
 */

import { applyFusionGovernance, type Config } from '../config/config.js';
import type { SearchFilters } from './search.js';

export const RETRIEVAL_PRESETS = ['default', 'recent', 'exact', 'entity', 'temporal'] as const;
export type RetrievalPreset = (typeof RETRIEVAL_PRESETS)[number];

/** Thrown by `validatePresetFilters` when a preset's required filter is
 * missing — callers (routes, MCP tools) catch this and turn it into a 400 /
 * `isError` response naming the missing filter (AC-3). */
export class PresetValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PresetValidationError';
  }
}

// Relative boost multipliers applied to the caller's own base weight — never
// an absolute literal — before the governance ceiling is re-applied below.
const RECENT_FRESHNESS_MULTIPLIER = 4;
const EXACT_BM25_MULTIPLIER = 2;

/**
 * Resolve the fusion weights for one request's `preset`, from the base
 * `search` config already in effect. Always funnels through
 * `applyFusionGovernance` (AC-2) — see module doc comment for why that keeps
 * `default` byte-identical (AC-1) rather than merely "usually the same".
 */
export function resolvePresetWeights(preset: RetrievalPreset, base: Config['search']): Config['search'] {
  switch (preset) {
    case 'recent':
      return applyFusionGovernance({ ...base, delta: base.delta * RECENT_FRESHNESS_MULTIPLIER });
    case 'exact':
      return applyFusionGovernance({ ...base, alpha: base.alpha * EXACT_BM25_MULTIPLIER });
    case 'default':
    case 'entity':
    case 'temporal':
      return applyFusionGovernance({ ...base });
  }
}

/**
 * AC-3: `entity`/`temporal` route to existing filters with no sensible
 * default — an entity-preset query with no `filters.entity`, or a
 * temporal-preset query with no `filters.as_of`, is a caller error (400),
 * not a silent fallback. Every other preset has no required filter. Called
 * AFTER the caller's filters are fully parsed (so `filters.as_of` is already
 * the resolved epoch-ms value, not the raw ISO string).
 */
export function validatePresetFilters(
  preset: RetrievalPreset,
  filters: Pick<SearchFilters, 'entity' | 'as_of'>,
): void {
  if (preset === 'entity' && filters.entity === undefined) {
    throw new PresetValidationError(
      'preset=entity requires an entity filter to be supplied ' +
      '(GET /search: ?entity=..., POST /recall: filters.entity, MCP: entity arg)',
    );
  }
  if (preset === 'temporal' && filters.as_of === undefined) {
    throw new PresetValidationError(
      'preset=temporal requires an as_of filter to be supplied ' +
      '(GET /search: ?as_of=..., POST /recall: filters.as_of, MCP: as_of arg)',
    );
  }
}
