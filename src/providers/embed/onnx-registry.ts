import type { OnnxDType, OnnxPoolingStrategy } from '../../contracts/embed.js';
import { QUERY_PREFIX_BY_MODEL } from '../../contracts/embed.js';

/**
 * ADR-018 SLICE-1 — Risk A resolution (artifact sourcing).
 *
 * `mixedbread-ai/mxbai-embed-large-v1`'s own HF repo publishes a first-party
 * ONNX export under `/onnx` (confirmed live via the HF API 2026-07-15):
 *   - onnx/model.onnx            ~1.34 GB (fp32)
 *   - onnx/model_fp16.onnx       ~669 MB  (fp16)
 *   - onnx/model_quantized.onnx  ~337 MB  (int8/"q8")
 * No self-convert fallback is needed for SLICE-1 — this satisfies ADR-018's
 * first blocking acceptance criterion.
 *
 * Pinned by exact commit SHA, never `'main'` — an upstream re-export could
 * otherwise silently shift weights under an already-installed daemon with
 * no version bump to notice by (the same "success and failure look
 * identical" failure class ADR-015 exists to kill). Re-verify via
 * `GET https://huggingface.co/api/models/mixedbread-ai/mxbai-embed-large-v1`
 * before ever bumping this constant.
 */
export const DEFAULT_ONNX_HF_MODEL_ID = 'mixedbread-ai/mxbai-embed-large-v1';
export const DEFAULT_ONNX_REVISION = 'b33106f585b9ce46904ad7443a3b52b7a63e231c';

/** `@huggingface/transformers`' dtype->filename-suffix map resolves `'q8'`
 * to `onnx/model_quantized.onnx` (the smallest first-party artifact, see
 * above) — the default for SLICE-1. Override to `'fp16'`/`'fp32'` via
 * `config.onnxEmbed.dtype` for higher fidelity at the cost of download size;
 * see ADR-018 Risk B (geometry-parity gate, deferred to SLICE-3). */
export const DEFAULT_ONNX_DTYPE: OnnxDType = 'q8';

/** Fallback pooling strategy for any `config.embedding.model` string absent
 * from `ONNX_MODEL_REGISTRY` below — preserves SLICE-1/2's original
 * behavior for an unregistered/custom model rather than silently guessing
 * `'cls'` for a model this repo has never verified. Both registered models
 * (mxbai-embed-large-v1, bge-m3) override this via their registry entry. */
export const DEFAULT_ONNX_POOLING: OnnxPoolingStrategy = 'mean';

/** Canonical model label `OnnxEmbedProvider` falls back to when
 * `config.model` is unset — the `ONNX_MODEL_REGISTRY` key this repo has
 * measured/verified as the default onnx embedder (see
 * docs/research/20260715-onnx-embedder-benchmark-results.md). */
export const DEFAULT_MODEL_LABEL = 'mxbai-embed-large-v1';

/**
 * ADR-018 SLICE-5 — model registry. Adding a THIRD onnx model going forward
 * should be exactly one new entry here (plus a `QUERY_PREFIX_BY_MODEL` entry
 * in contracts/embed.ts if the model needs a query-side instruction prefix)
 * — not a provider code change. Keyed by the canonical `config.embedding.model`
 * label (matches `OnnxEmbedProvider.model`, NOT the HF repo id — mirrors the
 * existing `QUERY_PREFIX_BY_MODEL` keying convention in contracts/embed.ts).
 *
 * `config.onnxEmbed.{revision,dtype,pooling}` (and the constructor's
 * matching `OnnxEmbedConfig` fields) OVERRIDE a registry entry's defaults
 * when set explicitly — the registry supplies defaults, not hardcoded
 * finals, so an operator can still pin a different revision/dtype/pooling
 * for a registered model without a code change.
 *
 * `queryPrefix` here is NOT read by the provider itself (query-prefix
 * resolution happens exactly once, upstream, in
 * `providers/index.ts::buildEmbedProvider` via `resolveEmbedQueryPrefix` +
 * `QUERY_PREFIX_BY_MODEL` — see that function's doc comment). It is
 * duplicated onto each registry entry here ONLY as an audit trail sourced
 * directly from `QUERY_PREFIX_BY_MODEL` (never a second hand-typed string —
 * see the object literal below) so a reviewer can see the full per-model
 * picture in one place; `tests/providers/embed/onnx.test.ts` pins each
 * entry's `queryPrefix` against a hardcoded literal (S4 cleanup — a prior
 * version compared this field back to `QUERY_PREFIX_BY_MODEL`, which is
 * tautological since that is exactly where the value below is sourced
 * from) so a silent drift in either place still fails a test.
 */
export interface OnnxModelRegistryEntry {
  /** Hugging Face repo id to load from `@huggingface/transformers`. */
  readonly hfRepo: string;
  /** Pinned HF revision (commit SHA) — never `'main'` (ADR-018 Risk A
   * discipline: an upstream re-export could otherwise silently shift
   * weights under an already-installed daemon with no version bump to
   * notice by). */
  readonly defaultRevision: string;
  /** ORT weight precision this model's default artifact resolves to. */
  readonly defaultDtype: OnnxDType;
  /** Pooling strategy this model's own documentation specifies as correct
   * (see `OnnxPoolingStrategy`'s doc comment in contracts/embed.ts for the
   * evidence trail). */
  readonly pooling: OnnxPoolingStrategy;
  /** Audit-trail copy of `QUERY_PREFIX_BY_MODEL[key]` — see interface doc
   * comment above; not read by the provider at runtime. */
  readonly queryPrefix: string;
}

export const ONNX_MODEL_REGISTRY: Readonly<Record<string, OnnxModelRegistryEntry>> = {
  /**
   * mixedbread-ai/mxbai-embed-large-v1 — first-party ONNX export (see
   * DEFAULT_ONNX_HF_MODEL_ID's doc comment above for artifact provenance).
   * SLICE-5 correction: pooling defaults to `'cls'`, not `'mean'` —
   * mxbai's own model card: "works really well with cls pooling (default)
   * but also with mean pooling." SLICE-1/2 had this backwards (assumed
   * mean was the documented default); see
   * docs/research/20260715-bge-m3-onnx-model-matrix.md's "Contradictions"
   * section for the full evidence trail. Mean pooling remains fully
   * available — set `config.onnxEmbed.pooling: 'mean'` to restore the
   * SLICE-1/2 behavior for an existing install if a re-verification ever
   * warrants it.
   */
  'mxbai-embed-large-v1': {
    hfRepo: DEFAULT_ONNX_HF_MODEL_ID,
    defaultRevision: DEFAULT_ONNX_REVISION,
    defaultDtype: DEFAULT_ONNX_DTYPE,
    pooling: 'cls',
    queryPrefix: QUERY_PREFIX_BY_MODEL['mxbai-embed-large-v1'] ?? '',
  },
  /**
   * Xenova/bge-m3 — community ONNX export maintained by the
   * transformers.js maintainer org itself (not a one-off community
   * conversion); ~430x the monthly downloads of the next-largest
   * alternative and the only bge-m3 ONNX export tagged
   * `library_name: transformers.js`. Pinned by exact commit SHA per the
   * same "never main" discipline as mxbai. Dense retrieval pooling is CLS
   * per BAAI's own FlagEmbedding source (`last_hidden_state[:, 0]`, class
   * default `sentence_pooling_method="cls"`) — NOT mean. No published
   * numeric parity check between this ONNX export and FlagEmbedding's
   * PyTorch reference exists (knowledge gap) — see the gated live smoke
   * test below for this repo's own first-party sanity check. Full
   * artifact/pooling research: docs/research/20260715-bge-m3-onnx-model-matrix.md.
   */
  'bge-m3': {
    hfRepo: 'Xenova/bge-m3',
    defaultRevision: '4de13258303883538bd53b696b452bf8099f0858',
    defaultDtype: 'q8',
    pooling: 'cls',
    queryPrefix: QUERY_PREFIX_BY_MODEL['bge-m3'] ?? '',
  },
};
