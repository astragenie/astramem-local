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
 *  - rename `capture_source` -> the canonical `source` (CONTRACT-FREEZE §1,
 *    astragenie/memory#759: "source maps to local's provenance").
 */
import type { SearchHit } from '../search/search.js';

export function toWireHit(hit: SearchHit): unknown {
  const { source: _fusionLeg, capture_source, reranked: _reranked, rerank_score: _rerankScore, ...rest } = hit;
  return { ...rest, ...(capture_source !== undefined ? { source: capture_source } : {}) };
}
