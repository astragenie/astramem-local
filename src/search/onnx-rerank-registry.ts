import type { OnnxDType } from '../contracts/embed.js';

/**
 * P2 retrieval overhaul (2026-07-20, WT-B) — pinned artifact for the default
 * in-process ONNX cross-encoder reranker.
 *
 * `Xenova/ms-marco-MiniLM-L-6-v2` is the transformers.js-maintained ONNX
 * export of `cross-encoder/ms-marco-MiniLM-L-6-v2` (sentence-transformers'
 * own reference MS MARCO cross-encoder — 6-layer, 384-hidden, single-label
 * regression head, `sbert_ce_default_activation_function: Identity`, so the
 * raw logit IS the relevance score — `OnnxCrossEncoderProvider` applies a
 * sigmoid to fold it into `applyRerank`'s `[0,1]` contract, same posture as
 * every other `CrossEncoderProvider`). Compact (~23MB int8-quantized,
 * ~90MB fp32) — "compact local cross-encoder" per the retrieval overhaul
 * plan (P2), not a multi-hundred-MB reranker. Confirmed live via the HF API
 * 2026-07-20 (`GET https://huggingface.co/api/models/Xenova/ms-marco-MiniLM-L-6-v2`).
 *
 * Pinned by exact commit SHA, never `'main'` — mirrors ADR-018's embed-model
 * discipline (`src/providers/embed/onnx-registry.ts`'s
 * `DEFAULT_ONNX_REVISION` doc comment): an upstream re-export could
 * otherwise silently shift weights under an already-installed daemon with
 * no version bump to notice by.
 */
export const DEFAULT_RERANK_HF_MODEL_ID = 'Xenova/ms-marco-MiniLM-L-6-v2';
export const DEFAULT_RERANK_REVISION = 'a09144355adeed5f58c8ed011d209bf8ee5a1fec';

/** `@huggingface/transformers`' dtype->filename-suffix map resolves `'q8'` to
 * `onnx/model_quantized.onnx` — the smallest first-party artifact for this
 * model (confirmed present in the repo's file listing alongside fp16/fp32),
 * same default posture as `onnx-registry.ts`'s `DEFAULT_ONNX_DTYPE`. */
export const DEFAULT_RERANK_DTYPE: OnnxDType = 'q8';

/** Canonical model label `OnnxCrossEncoderProvider` falls back to when
 * `config.crossEncoder.model` is unset — the `RERANK_MODEL_REGISTRY` key for
 * the pinned default above. Mirrors `onnx-registry.ts`'s
 * `DEFAULT_MODEL_LABEL` convention (a short label, NOT the HF repo id). */
export const DEFAULT_RERANK_MODEL_LABEL = 'ms-marco-MiniLM-L-6-v2';

/**
 * Model registry for the in-process ONNX cross-encoder reranker. Mirrors
 * `src/providers/embed/onnx-registry.ts`'s `ONNX_MODEL_REGISTRY` shape and
 * "add a model = one entry" intent — adding a second reranker (e.g. a BGE or
 * mxbai cross-encoder) is one new entry here, not a provider code change.
 * Keyed by the canonical `config.crossEncoder.model` label, NOT the HF repo
 * id (matches `OnnxCrossEncoderProvider.model`).
 */
export interface RerankModelRegistryEntry {
  /** Hugging Face repo id to load from `@huggingface/transformers`. */
  readonly hfRepo: string;
  /** Pinned HF revision (commit SHA) — never `'main'`. */
  readonly defaultRevision: string;
  /** ORT weight precision this model's default artifact resolves to. */
  readonly defaultDtype: OnnxDType;
}

export const RERANK_MODEL_REGISTRY: Readonly<Record<string, RerankModelRegistryEntry>> = {
  'ms-marco-MiniLM-L-6-v2': {
    hfRepo: DEFAULT_RERANK_HF_MODEL_ID,
    defaultRevision: DEFAULT_RERANK_REVISION,
    defaultDtype: DEFAULT_RERANK_DTYPE,
  },
};
