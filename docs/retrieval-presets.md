# Named retrieval presets (FEAT-454)

`preset` selects a named routing over retrieval capability the daemon
already has — no new scoring engine, no new filters. It is a **local +
MCP-only** surface this slice; there is no shared-contract schema change and
no cloud mirroring.

> Why not call it `mode`? `mode` is already a live, required field in the
> shared cross-product retrieval-query contract
> (`contracts/schemas/retrieval-query.v1.schema.json`) with different
> semantics — `keyword|semantic|hybrid` routing, driven cloud-side by
> `SearchQuery.cs` / `MemoryQueryService.cs`. Reusing that name for this
> concept would collide with it, so this FEAT uses `preset` instead.

## Presets

| Preset | Behavior | Requires |
|---|---|---|
| `default` | Today's fusion weights, unmodified. Omitting `preset` entirely is identical. | — |
| `recent` | Freshness-weighted — boosts the δ (freshness) fusion weight so newer memories rank higher. | — |
| `exact` | BM25-first — boosts the α (lexical) fusion weight so literal term matches dominate over semantic similarity. | — |
| `entity` | Routes to the existing entity filter (see [docs/recall-filters.md](recall-filters.md)). | `filters.entity` (or `entity`/`?entity=`) — **400 without it** |
| `temporal` | Routes to the existing bitemporal filter (`as_of`). | `filters.as_of` (or `as_of`) — **400 without it** |

`entity`/`temporal` deliberately error rather than silently falling back to
an unfiltered/now query — a preset that promises entity- or time-scoped
retrieval with nothing to scope to is a caller mistake, not something to
paper over.

Every preset's weights are constructed by scaling the caller's own resolved
base weights — never a hand-rolled literal — and always pass back through
`applyFusionGovernance` (`src/config/config.ts:334`), so a preset can never
exceed the operator's configured component ceiling. See
`src/search/presets.ts` for the exact multipliers and rationale.

## Wire contract

### `GET /search`

```
GET /search?q=sqlite&preset=recent
GET /search?q=priya+nair&preset=entity&entity=Priya+Nair
GET /search?q=adopt+postgres&preset=temporal&as_of=2026-07-01T00:00:00Z
```

### `POST /recall` (and MCP `recall_memory`)

```jsonc
{
  "text": "sqlite adoption decision",
  "limit": 5,
  "preset": "exact"
}
```

### MCP `search_memory` / `recall_memory`

Same `preset` argument, same enum, documented inline in each tool's
`inputSchema` description.

## Errors

An out-of-enum `preset` value is a 400 (REST) / tool-call rejection (MCP),
same shape as an invalid `type` filter value. `preset=entity` with no entity
filter, or `preset=temporal` with no `as_of`, is a 400 naming the missing
filter — not a silently unfiltered result.

## Tests / evidence

- Unit (weight resolution + governance + AC-3 validation):
  `tests/search/presets.test.ts`.
- REST + MCP end-to-end parity, including the AC-3 400/`isError` cases:
  `tests/mcp/preset-parity.test.ts`.
- AC-1 byte-identical `default` ranking snapshot (mirrors the AC-6 zeta=0
  pattern): `tests/eval/retrieval-eval.test.ts`.

## Related

- FEAT-454 spec: `.claude/artifacts/loop/backlog/triaged/FEAT-454.md` (or its
  post-completion location once the slice closes).
- [docs/recall-filters.md](recall-filters.md) — the `entity`/`as_of` filters
  `entity`/`temporal` route to.
- `src/config/config.ts` `applyFusionGovernance` — the shared governance seam
  every preset's weights are built through (FEAT-428).
