export interface EmbedHealth {
  ok: boolean;
  model: string;
  dim: number;
  error?: string;
}

/**
 * ADR-018 SLICE-2 cleanup: single source of truth for the ONNX embed
 * provider's weight-precision knob. Previously declared independently in
 * BOTH `src/providers/embed/onnx.ts` (`export type OnnxDType`) and
 * `src/config/config.ts` (`onnxEmbed.dtype`'s inline `'q8' | 'fp16' |
 * 'fp32'` literal union) — two hand-written copies of the same three-value
 * union with nothing forcing them to stay in sync (S1 review MEDIUM
 * finding). Hoisted here since `config.ts` already imports
 * `DEFAULT_EMBED_DIM` from this file for the same "one coordinated-change
 * surface" reason (see that constant's own doc comment above `dim`'s
 * declaration). `onnx.ts` re-exports this for backward-compatible imports.
 */
export type OnnxDType = 'q8' | 'fp16' | 'fp32';

/**
 * ADR-018 SLICE-5: pooling strategy for the in-process ONNX embedding
 * provider — hoisted here (same "single source of truth" rationale as
 * `OnnxDType` above) since `config.ts`'s `onnxEmbed.pooling` field and
 * `onnx.ts`'s per-model registry both need this union without a second
 * hand-written copy.
 *
 * SLICE-1/2 hardcoded mean pooling (`poolMeanNormalize`) for every ONNX
 * model. That was corrected in SLICE-5: `mixedbread-ai/mxbai-embed-large-v1`'s
 * own model card states CLS pooling is its DEFAULT ("works really well with
 * cls pooling (default) but also with mean pooling") — the opposite of what
 * ADR-018's text assumed. `bge-m3` (BAAI FlagEmbedding) also uses CLS
 * pooling (`last_hidden_state[:, 0]`, then L2-normalize) as its documented
 * dense-retrieval strategy. Both registered models in `onnx.ts`'s
 * `ONNX_MODEL_REGISTRY` now default to `'cls'`; `'mean'` remains fully
 * supported (`poolMeanNormalize` is still exported and still the fallback
 * for any model absent from the registry) — this is a corrected per-model
 * DEFAULT, not a removal of mean pooling. See
 * `docs/research/20260715-bge-m3-onnx-model-matrix.md` for the evidence
 * trail (BAAI FlagEmbedding source + official BGE docs + mxbai's own model
 * card, all independently confirming CLS).
 */
export type OnnxPoolingStrategy = 'mean' | 'cls';

/**
 * Default/legacy embedding dimension (FEAT-409). This is the ONE source of
 * truth every coordinated surface derives from: config default
 * (config.ts), embed providers (ollama.ts / azure-openai.ts `dim` ctor
 * arg), the vec schema (migrations/001-init.sql's `__EMBED_DIM__`
 * placeholder, substituted by storage/migrate.ts), the boot-time dim
 * preflight (doctor/probes/embed-probe.ts), and the eval/mock providers.
 *
 * Matches both `mxbai-embed-large` (Ollama default, native 1024) and
 * `text-embedding-3-*` (Azure, configured via `dimensions: 1024`).
 *
 * Changing `config.embedding.dim` for a FRESH database is a plain config
 * edit — migrate() bakes the configured dim into `memories_vec` at
 * creation. Changing it for an EXISTING database with live data requires
 * the resumable re-embed procedure (`astramem-local reembed-dim`, migration
 * 011 / docs/embed-dim-migration.md) because sqlite-vec's vec0 virtual
 * table fixes its dim at CREATE TABLE time — there is no ALTER for it.
 */
export const DEFAULT_EMBED_DIM = 1024;

/**
 * Embedding provider. `dim` is provider-instance-scoped (constructor arg,
 * defaulting to DEFAULT_EMBED_DIM) rather than a fixed literal — FEAT-409
 * parameterized what was a v1 system-wide invariant. All memories embedded
 * by one provider instance must share its `dim`; switching providers/models
 * (even at the same dim) still requires a re-embed pass since different
 * models are different geometric spaces. Doctor enforces the
 * configured-vs-actual dim match at startup (embed-probe.ts).
 */
export interface EmbedProvider {
  readonly name: 'ollama' | 'azure-openai' | 'onnx';
  readonly model: string;
  readonly dim: number;
  /**
   * RECALL-S1: asymmetric query-side instruction prefix. Some retrieval
   * embedding models (e.g. `mxbai-embed-large`) are instruction-sensitive —
   * a *query* and the *passage that answers it* only land near each other
   * in vector space when the query is prefixed with the model's documented
   * search-instruction string; passages must NOT receive it (measured
   * +17.5 MRR from getting this right on mxbai-embed-large alone).
   *
   * Resolved ONCE at provider-construction time by `buildEmbedProvider`
   * (src/providers/index.ts) via `resolveEmbedQueryPrefix` below, from
   * `config.embedding.model` (+ optional `config.embedding.queryPrefix`
   * override) — never computed ad hoc at a call site. `''`/undefined means
   * "no prefix" (the correct default for a model not in
   * `QUERY_PREFIX_BY_MODEL`, and for every mock/test provider that omits
   * this field).
   *
   * Applied in exactly one place — `src/search/search.ts`'s vector-embed
   * call site — and ONLY to the string handed to `embed.embed([...])`, never
   * to the FTS5 query text and never to document embedding
   * (`src/distill/stages/08-embed-index.ts` must never read this field: the
   * asymmetry query-side-only vs. document-side-none *is* the fix, and
   * prefixing both sides would cancel the benefit).
   */
  readonly queryPrefix?: string;
  /**
   * `signal` (issue #261): caller-supplied cancellation, combined with (not
   * replacing) the provider's own internal timeout — same contract as
   * `ChatOpts.signal` in contracts/llm.ts. Optional so existing callers that
   * don't need a caller-scoped budget are unaffected.
   */
  embed(texts: string[], signal?: AbortSignal): Promise<Float32Array[]>;
  health(): Promise<EmbedHealth>;
}

/**
 * RECALL-S1: built-in embedding-model -> query-side instruction-prefix
 * registry. Keys are exact `config.embedding.model` values. A model absent
 * from this map resolves to `''` (no prefix) in `resolveEmbedQueryPrefix` —
 * an unrecognized model must never silently inherit another model's
 * instruction string; a WRONG prefix measurably hurts retrieval, it is not
 * a harmless no-op.
 *
 * `mxbai-embed-large`: per the model card (mixedbread-ai/mxbai-embed-large-v1
 * on Hugging Face), queries must be prefixed with this exact string for
 * retrieval tasks; documents/passages take no prompt at all — confirmed
 * query-side-only is correct, no document re-embed is implied by this fix.
 *
 * `bge-m3`: FEAT-501 stage 1 verification (2026-07-14) — explicit empty
 * entry, NOT an absence relying on the map's default fallback, so the
 * determination is auditable rather than indistinguishable from "nobody
 * checked yet." Confirmed via the model's own HuggingFace card FAQ
 * (huggingface.co/BAAI/bge-m3): "The only difference is that the BGE-M3
 * model no longer requires adding instructions to the queries" — i.e.
 * unlike bge-v1.5 (which DOES need "Represent this sentence for searching
 * relevant passages:"), bge-m3 dense retrieval takes queries and passages
 * with no instruction prefix on either side. Do not add one without a
 * re-verified source. See docs/research/20260714-feat-501-embed-model-ab.md.
 *
 * `mxbai-embed-large-v1`: ADR-018 SLICE-1 — the canonical
 * `config.embedding.model` string for the `onnx` provider
 * (`OnnxEmbedProvider`'s default `model` label), distinct from the Ollama
 * entry's tag-style `mxbai-embed-large` key even though both resolve to the
 * same underlying model weights (Ollama's GGUF vs. this repo's first-party
 * ONNX export) and therefore the same query-side instruction string per the
 * same model card. Deliberately an explicit second entry, not a rename of
 * the Ollama key or a fallback through it — ADR-018 flags this exact
 * resolution as a blocking SLICE-1 decision so the prefix can never
 * silently fall through to `''` for the onnx path.
 */
export const QUERY_PREFIX_BY_MODEL: Readonly<Record<string, string>> = {
  'mxbai-embed-large': 'Represent this sentence for searching relevant passages: ',
  'mxbai-embed-large-v1': 'Represent this sentence for searching relevant passages: ',
  'bge-m3': '',
};

/**
 * Resolve the query-side embedding instruction prefix for `model`.
 * `explicitOverride` is `config.embedding.queryPrefix` — when the operator
 * has set it (including `''` to force no prefix even for a model listed in
 * `QUERY_PREFIX_BY_MODEL`), it wins outright over the built-in map. Absent a
 * configured override, falls back to `QUERY_PREFIX_BY_MODEL[model]`,
 * defaulting to `''` (no prefix) for any model not listed there.
 */
export function resolveEmbedQueryPrefix(model: string, explicitOverride?: string): string {
  if (explicitOverride !== undefined) return explicitOverride;
  return QUERY_PREFIX_BY_MODEL[model] ?? '';
}
