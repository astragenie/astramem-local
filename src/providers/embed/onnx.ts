import type { EmbedHealth, EmbedProvider, OnnxDType } from '../../contracts/embed.js';
import { DEFAULT_EMBED_DIM } from '../../contracts/embed.js';
import { childLogger } from '../../log/logger.js';

// ADR-018 SLICE-2 cleanup: re-exported for backward-compatible imports —
// the type itself now lives in contracts/embed.ts (single source of truth,
// see that file's doc comment) alongside config.ts's `onnxEmbed.dtype`
// field, closing the S1-review duplicate-declaration MEDIUM finding.
export type { OnnxDType };

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

const DEFAULT_MODEL_LABEL = 'mxbai-embed-large-v1';
/** ORT intraOpNumThreads cap — never unbounded (mirrors this repo's
 * NUM_CTX_CAP discipline: a background daemon must never be allowed to
 * silently claim unbounded local resources). */
const DEFAULT_NUM_THREADS = 4;

// ---------------------------------------------------------------------------
// Narrow seam over @huggingface/transformers
// ---------------------------------------------------------------------------
// Lets unit tests inject a fake backend instead of downloading the real
// 337MB-1.34GB model artifact (SLICE-1 AC: pure-logic tests always-on, the
// real-backend integration test gated behind ASTRA_TEST_ONNX_LIVE=1 — see
// tests/providers/embed/onnx.test.ts).

/** Structural subset of `@huggingface/transformers`' `Tensor` actually used
 * here — real call sites always receive a real `Tensor` instance. */
export interface OnnxTensorLike {
  readonly dims: number[];
  tolist(): unknown;
}

export interface OnnxBatchEncoding {
  readonly attention_mask: OnnxTensorLike;
  readonly [key: string]: unknown;
}

export interface OnnxModelOutput {
  readonly last_hidden_state: OnnxTensorLike;
}

/**
 * Narrow surface over AutoTokenizer + AutoModel actually used by this
 * provider — tokenize -> run -> pool, mirroring
 * `@huggingface/transformers`' own `FeatureExtractionPipeline` internals
 * exactly (`tokenizer(texts, {padding:true, truncation:true})` ->
 * `model(inputs)` -> `mean_pooling(last_hidden_state, attention_mask)` ->
 * `.normalize(2, -1)`). `pool()` reuses the library's own tested
 * pooling/normalize tensor math rather than hand-rolling the arithmetic —
 * ADR-018 Risk B calls out a hand-rolled reimplementation as exactly where a
 * silent geometry-parity bug would hide.
 */
export interface OnnxBackend {
  tokenize(texts: string[]): Promise<OnnxBatchEncoding>;
  run(inputs: OnnxBatchEncoding): Promise<OnnxModelOutput>;
  /** Mean-pool + L2-normalize. Returns one flat unit vector per input text,
   * in input order. */
  pool(output: OnnxModelOutput, attentionMask: OnnxTensorLike): Promise<Float32Array[]>;
}

/**
 * Mean-pool `output.last_hidden_state` over `attentionMask`, then
 * L2-normalize — exported standalone (not inlined in the default backend)
 * so unit tests can exercise the EXACT production pooling/normalize code
 * path against hand-built synthetic `Tensor`s, with no ONNX session and no
 * model download (`Tensor` construction and `mean_pooling`/`.normalize()`
 * are pure tensor math, not inference — see
 * tests/providers/embed/onnx.test.ts). Reuses
 * `@huggingface/transformers`' own tested `mean_pooling` + `Tensor.normalize`
 * rather than hand-rolling the arithmetic (ADR-018 Risk B).
 */
export async function poolMeanNormalize(
  output: OnnxModelOutput,
  attentionMask: OnnxTensorLike,
): Promise<Float32Array[]> {
  const { mean_pooling } = await import('@huggingface/transformers');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pooled = mean_pooling(output.last_hidden_state as any, attentionMask as any).normalize(2, -1);
  const nested = pooled.tolist() as number[][];
  return nested.map((row) => new Float32Array(row));
}

interface ResolvedOnnxLoadOpts {
  hfModelId: string;
  revision: string;
  dtype: OnnxDType;
  cacheDir?: string;
  modelPath?: string;
  numThreads: number;
}

/**
 * Default backend loader — dynamically imports `@huggingface/transformers`
 * (keeps the multi-hundred-MB dependency chain, incl. `onnxruntime-node`'s
 * native binary, out of every daemon boot path that never selects
 * `provider: onnx`) and wires `AutoTokenizer` + `AutoModel` on the **CPU
 * execution provider only** — ADR-018 explicitly rejects GPU EPs for v1,
 * since allocating VRAM defeats the entire point of this provider.
 */
async function loadTransformersBackend(opts: ResolvedOnnxLoadOpts): Promise<OnnxBackend> {
  const { AutoTokenizer, AutoModel } = await import('@huggingface/transformers');

  const pretrainedOpts: Record<string, unknown> = { revision: opts.revision };
  if (opts.modelPath) {
    // Explicit local override — offline/air-gapped install, no download.
    pretrainedOpts.local_files_only = true;
    pretrainedOpts.cache_dir = opts.modelPath;
  } else if (opts.cacheDir) {
    pretrainedOpts.cache_dir = opts.cacheDir;
  }

  const tokenizer = await AutoTokenizer.from_pretrained(opts.hfModelId, pretrainedOpts);
  const model = await AutoModel.from_pretrained(opts.hfModelId, {
    ...pretrainedOpts,
    dtype: opts.dtype,
    device: 'cpu',
    session_options: { intraOpNumThreads: opts.numThreads },
  });

  return {
    async tokenize(texts) {
      return tokenizer(texts, { padding: true, truncation: true }) as unknown as OnnxBatchEncoding;
    },
    async run(inputs) {
      return (await model(inputs)) as unknown as OnnxModelOutput;
    },
    pool: poolMeanNormalize,
  };
}

export interface OnnxEmbedConfig {
  /** Canonical model label used for `QUERY_PREFIX_BY_MODEL` lookups +
   * display — NOT the HF repo id. Defaults to `'mxbai-embed-large-v1'`. */
  model?: string;
  /** FEAT-409: expected output dim — defaults to DEFAULT_EMBED_DIM (1024).
   * Set from config.embedding.dim by providers/index.ts. */
  dim?: number;
  /** RECALL-S1: query-side embedding instruction prefix — resolved by
   * providers/index.ts via resolveEmbedQueryPrefix, not this constructor.
   * See EmbedProvider.queryPrefix (src/contracts/embed.ts). Defaults to ''
   * (no prefix). */
  queryPrefix?: string;
  /** HF repo id to load from. Defaults to DEFAULT_ONNX_HF_MODEL_ID. */
  hfModelId?: string;
  /** Pinned HF revision (commit SHA) — never `'main'`. Defaults to
   * DEFAULT_ONNX_REVISION. */
  revision?: string;
  /** ORT weight precision. Defaults to DEFAULT_ONNX_DTYPE ('q8'). */
  dtype?: OnnxDType;
  /** Local cache directory for downloaded weights. S2 wires this to
   * `<dataDir>/models/onnx/` per ADR-018 (deferred) — unset here defers to
   * the library's own default cache resolution. */
  cacheDir?: string;
  /** Explicit local filesystem override — takes precedence over any
   * download when set (offline/air-gapped installs). */
  modelPath?: string;
  /** ORT intraOpNumThreads cap. Defaults to DEFAULT_NUM_THREADS (4). */
  numThreads?: number;
  /** Test/DI seam only — overrides the default `@huggingface/transformers`
   * backed loader so unit tests can inject a fake backend instead of
   * downloading the real model. Production code never sets this. */
  loadBackend?: (opts: {
    hfModelId: string;
    revision: string;
    dtype: OnnxDType;
    cacheDir?: string;
    modelPath?: string;
    numThreads: number;
  }) => Promise<OnnxBackend>;
}

export class OnnxEmbedProvider implements EmbedProvider {
  readonly name = 'onnx' as const;
  readonly model: string;
  readonly dim: number;
  readonly queryPrefix: string;
  private readonly hfModelId: string;
  private readonly revision: string;
  private readonly dtype: OnnxDType;
  private readonly cacheDir: string | undefined;
  private readonly modelPath: string | undefined;
  private readonly numThreads: number;
  private readonly loadBackend: (opts: ResolvedOnnxLoadOpts) => Promise<OnnxBackend>;
  private backendPromise: Promise<OnnxBackend> | null = null;

  constructor(config: OnnxEmbedConfig = {}) {
    this.model = config.model ?? DEFAULT_MODEL_LABEL;
    this.dim = config.dim ?? DEFAULT_EMBED_DIM;
    this.queryPrefix = config.queryPrefix ?? '';
    this.hfModelId = config.hfModelId ?? DEFAULT_ONNX_HF_MODEL_ID;
    this.revision = config.revision ?? DEFAULT_ONNX_REVISION;
    this.dtype = config.dtype ?? DEFAULT_ONNX_DTYPE;
    this.cacheDir = config.cacheDir;
    this.modelPath = config.modelPath;
    this.numThreads = config.numThreads ?? DEFAULT_NUM_THREADS;
    this.loadBackend = config.loadBackend ?? loadTransformersBackend;
  }

  /**
   * Lazy, memoized session load (ADR-018 "Startup preload" decision): the
   * constructor never eagerly loads the ORT session or triggers a weight
   * download, mirroring `CodexSubscriptionLLMProvider`'s "no
   * construction-time throw" posture (providers/index.ts) — selecting
   * `provider: onnx` without a reachable model artifact does not crash
   * daemon boot, it surfaces through `embed()`/`health()` instead. The
   * FIRST real call after boot (or after switching to `onnx` in config)
   * pays session-load + possible first-run download latency inline; every
   * subsequent call in the process lifetime reuses the memoized session. A
   * failed load is NOT memoized, so a transient failure (e.g. network
   * unreachable on first download attempt) can be retried on the next call
   * rather than permanently wedging the provider.
   */
  private getBackend(): Promise<OnnxBackend> {
    if (!this.backendPromise) {
      this.backendPromise = this.loadBackend({
        hfModelId: this.hfModelId,
        revision: this.revision,
        dtype: this.dtype,
        cacheDir: this.cacheDir,
        modelPath: this.modelPath,
        numThreads: this.numThreads,
      }).catch((err: unknown) => {
        this.backendPromise = null;
        throw err;
      });
    }
    return this.backendPromise;
  }

  /**
   * ADR-018 SLICE-2 — startup preload. Public, idempotent wrapper around
   * `getBackend()`: triggers the SAME lazy, memoized session load the first
   * `embed()`/`health()` call would (no separate code path, no risk of
   * loading the model twice or diverging from that contract) — it just lets
   * a caller (serve.ts) trigger the load proactively, in the BACKGROUND, at
   * boot, so the daemon's first real `embed()` call after startup doesn't
   * pay the cold session-load / possible first-run weight-download latency
   * inline. Does not change the class's documented lazy-load posture (see
   * `getBackend()`'s doc comment above): a `preload()` that is never called
   * still leaves the provider fully lazy, and `preload()` itself still
   * never runs at construction time — only when a caller (serve.ts, gated
   * to `provider: 'onnx'` only) explicitly invokes it. Rejects on failure —
   * callers must catch and WARN, not let it crash the caller's own boot
   * path (mirrors every other opt-in preflight in this daemon: cold-start
   * failure degrades, it never crashes).
   */
  async preload(): Promise<void> {
    await this.getBackend();
  }

  /**
   * `signal` (issue #261 contract, honestly narrowed for in-process
   * inference): in-process ORT inference has no `fetch`-style mid-call
   * abort plumbing into the native session — a signal is checked BETWEEN
   * texts in this per-text loop (mirroring `OllamaEmbedProvider`'s loop
   * shape) and throws immediately once set, but a signal that fires
   * mid-inference on one text will NOT interrupt that single in-flight
   * `run()` call; it completes, then the next loop iteration's check aborts
   * the remaining batch. This is a materially weaker cancellation guarantee
   * than the HTTP providers have (ADR-018) — documented here, not silently
   * implied to match.
   */
  async embed(texts: string[], signal?: AbortSignal): Promise<Float32Array[]> {
    if (texts.length === 0) return [];

    const log = childLogger({ provider: this.name, model: this.model });
    const backend = await this.getBackend();
    const results: Float32Array[] = [];

    for (const text of texts) {
      if (signal?.aborted) {
        throw signal.reason instanceof Error
          ? signal.reason
          : new DOMException('The operation was aborted', 'AbortError');
      }

      const t0 = Date.now();
      const encoded = await backend.tokenize([text]);
      const output = await backend.run(encoded);
      const pooled = await backend.pool(output, encoded.attention_mask);
      const vec = pooled[0];

      if (!vec) {
        throw new Error('ONNX embed produced no output vector for input text');
      }
      if (vec.length !== this.dim) {
        throw new Error(
          `ONNX embed dimension mismatch: expected ${this.dim}, got ${vec.length} (model: ${this.model})`,
        );
      }

      const latency_ms = Date.now() - t0;
      log.info({ latency_ms, tokens_in: 0, tokens_out: this.dim }, 'onnx embed ok');
      results.push(vec);
    }

    return results;
  }

  /**
   * No HTTP call to an always-on external service, unlike
   * `OllamaEmbedProvider`'s `/api/tags` GET or `AzureOpenAIEmbedProvider`'s
   * embed ping — this is an in-process check (ADR-018 constraint #7).
   * Verifies the model loads (reusing the same lazy/memoized session as
   * `embed()`) and that a smoke inference on `'ping'` produces a vector of
   * the expected `dim`. NOTE: on a cold cache with no `modelPath`
   * configured, this can still trigger the same one-time weight download
   * `embed()`'s first call would — "no network call" describes the shape of
   * this method (no request/response to a runtime service), not a
   * guarantee that zero bytes ever cross the wire on a cold first call.
   */
  async health(): Promise<EmbedHealth> {
    try {
      const backend = await this.getBackend();
      const encoded = await backend.tokenize(['ping']);
      const output = await backend.run(encoded);
      const pooled = await backend.pool(output, encoded.attention_mask);
      const vec = pooled[0];

      if (!vec || vec.length !== this.dim) {
        return {
          ok: false,
          model: this.model,
          dim: this.dim,
          error: `smoke inference produced dim ${vec?.length ?? 0}, expected ${this.dim}`,
        };
      }

      return { ok: true, model: this.model, dim: this.dim };
    } catch (err) {
      return {
        ok: false,
        model: this.model,
        dim: this.dim,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
