/**
 * toWireHit — projects a SearchHit (src/search/search.ts) onto the canonical
 * astramem-retrieval-result@1 hit shape (contracts/schemas/
 * retrieval-result.v1.schema.json). Promoted (FEAT-532 L1) from the inline
 * copy tests/contracts/conformance.test.ts proved against a REAL search()
 * response — the test now imports this instead of redefining it, and
 * src/server/routes/search.ts's POST /recall route uses it to wrap the wire
 * response in the canonical envelope.
 *
 * The only wire-mapping the retrieval@1 (additionalProperties: false) hit
 * shape needs from SearchHit:
 *  - drop the internal fusion-leg `source` (fts/vec/both) — pre-dates the
 *    canonical contract, has no place in the closed schema, still consumed
 *    internally by the CLI table / dashboard debug page (never on the wire).
 *  - drop `reranked`/`rerank_score` — fully recoverable from
 *    `explanation.signals.cross_encoder` presence/`.final` once merged, so
 *    nothing is lost by omitting them from the wire.
 *  - drop `correction_pending` (issue #352B) — the closed hit shape's
 *    property whitelist doesn't include it (adding it there is a cross-repo
 *    contract change: SaaS + plugin both consume this schema, out of scope
 *    for this local-only slice). The marker still surfaces on GET /search
 *    and the MCP search_memory/recall_memory tools, which serialize
 *    SearchHit directly rather than through this closed envelope.
 *  - rename `capture_source` -> the canonical `source` (CONTRACT-FREEZE §1,
 *    astragenie/memory#759: "source maps to local's provenance").
 *  - drop `evidence` (P2 retrieval-overhaul, 2026-07-20) — same posture as
 *    `correction_pending`: the closed hit shape's property whitelist doesn't
 *    include it yet (adding it there is a cross-repo contract change). The
 *    rerank stage already benefited from it server-side before this
 *    projection ever runs (search() populates `SearchHit.evidence` and
 *    scores the cross-encoder against it BEFORE `toWireHit` is called), so
 *    dropping it here loses no retrieval-quality signal — only the raw
 *    excerpt string itself, which still surfaces on GET /search and the MCP
 *    search_memory/recall_memory tools.
 */
import type { SearchHit } from '../search/search.js';

export function toWireHit(hit: SearchHit): unknown {
  const {
    source: _fusionLeg,
    capture_source,
    reranked: _reranked,
    rerank_score: _rerankScore,
    correction_pending: _correctionPending,
    evidence: _evidence,
    ...rest
  } = hit;
  return { ...rest, ...(capture_source !== undefined ? { source: capture_source } : {}) };
}
