export interface EmbedHealth {
  ok: boolean;
  model: string;
  dim: number;
  error?: string;
}

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
