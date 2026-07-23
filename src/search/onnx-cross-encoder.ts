/**
 * In-process ONNX cross-encoder reranker (P2 retrieval overhaul, WT-B,
 * 2026-07-20). Implements `CrossEncoderProvider` (rerank.ts) the same way
 * `OnnxEmbedProvider` (providers/embed/onnx.ts) implements `EmbedProvider`:
 * a compact `@huggingface/transformers` model, loaded lazily + memoized,
 * CPU execution provider only (ADR-018 rejects GPU EPs for this repo — the
 * whole point of "local" is not allocating VRAM), offline-first via the
 * same `resolveLocalSnapshotDir` directory-path load this repo already
 * proved is the only offline-safe way to call `from_pretrained` (see that
 * function's doc comment in onnx.ts for the 2026-07-16 outage it fixes).
 *
 * Why a SEPARATE provider file from onnx.ts rather than folding into it:
 * cross-encoders are sequence-CLASSIFICATION models (`AutoModelForSequence
 * Classification`, one relevance logit per (query, text) pair) — a
 * structurally different model family, tokenizer call shape (`text_pair`),
 * and output shape (`logits`, not `last_hidden_state` + pooling) from the
 * feature-extraction embed models onnx.ts loads. Sharing the directory-
 * resolution + offline-load discipline via imported helpers (below) avoids
 * duplicating THAT logic while keeping the model-family-specific code
 * separate, same modularity onnx-registry.ts already established for the
 * embed side.
 */
import { cpus } from 'node:os';
import type { CrossEncoderCandidate, CrossEncoderProvider } from './rerank.js';
import {
  requiredSnapshotFiles,
  resolveLocalSnapshotDir,
} from '../providers/embed/onnx.js';
import type { OnnxDType } from '../contracts/embed.js';
import { childLogger } from '../log/logger.js';
import {
  DEFAULT_RERANK_DTYPE,
  DEFAULT_RERANK_HF_MODEL_ID,
  DEFAULT_RERANK_MODEL_LABEL,
  DEFAULT_RERANK_REVISION,
  RERANK_MODEL_REGISTRY,
} from './onnx-rerank-registry.js';

/** Mirrors onnx.ts's `defaultOnnxNumThreads` — never unbounded (background
 * daemon resource discipline), leaves >=1 core free, caps at 4 (ORT's
 * intra-op parallelism has sharply diminishing returns past that on CPU). */
function defaultRerankNumThreads(): number {
  return Math.max(1, Math.min(4, cpus().length - 1));
}
const DEFAULT_NUM_THREADS = defaultRerankNumThreads();

function clampNumThreads(n: number): number {
  return Math.max(1, Math.min(cpus().length, Math.floor(n)));
}

/** How many (query, text) pairs go through one `model()` call. Bounds peak
 * memory/latency for a single batch rather than tokenizing+running all
 * `topK` (default 40) candidates in one shot — a compact 6-layer model on
 * CPU still benefits from not building one huge padded batch. Overridable
 * via `config.crossEncoder.onnx.batchSize`. */
export const DEFAULT_BATCH_SIZE = 16;

/** Sigmoid — folds the model's raw single-label regression logit into
 * `applyRerank`'s `[0,1]` score contract. Monotonic, so rank order among
 * candidates is unaffected vs. using the raw logit directly; unlike a bare
 * clamp, it doesn't collapse every negative (irrelevant) logit to the same
 * 0, which would otherwise destroy relative ordering among the tail of the
 * candidate window. */
export function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/** Structural subset of `@huggingface/transformers`' `Tensor` actually used
 * here — mirrors `OnnxTensorLike` in onnx.ts. Real call sites always receive
 * a real `Tensor` instance; unit tests inject a fake one via the
 * `loadBackend` DI seam. */
export interface OnnxCrossEncoderTensorLike {
  readonly dims: number[];
  tolist(): unknown;
}

export interface OnnxCrossEncoderBatchEncoding {
  readonly [key: string]: unknown;
}

export interface OnnxCrossEncoderModelOutput {
  readonly logits: OnnxCrossEncoderTensorLike;
}

/**
 * Narrow surface over AutoTokenizer + AutoModelForSequenceClassification
 * actually used by this provider — tokenize a (query, text) pair batch ->
 * run -> read logits. Mirrors `OnnxBackend` (onnx.ts)'s DI-seam shape so
 * unit tests can inject a fake backend instead of downloading the real
 * model artifact.
 */
export interface OnnxCrossEncoderBackend {
  tokenize(queries: string[], texts: string[]): Promise<OnnxCrossEncoderBatchEncoding>;
  run(inputs: OnnxCrossEncoderBatchEncoding): Promise<OnnxCrossEncoderModelOutput>;
}

/**
 * Extract per-pair relevance scores from a model output — exported standalone
 * (not inlined) so unit tests can exercise the exact production scoring math
 * against hand-built synthetic tensors, with no ONNX session and no model
 * download (mirrors `poolMeanNormalize`'s testability rationale in onnx.ts).
 * `logits.tolist()` is `number[][]` shaped `[batch, num_labels]`; this
 * model's registry entry is always a single-label regression head
 * (`id2label: {0: LABEL_0}`), so row `[0]` is the relevance logit.
 */
export function extractSigmoidScores(output: OnnxCrossEncoderModelOutput): number[] {
  const nested = output.logits.tolist() as number[][];
  return nested.map((row) => sigmoid(row[0] ?? 0));
}

interface ResolvedOnnxRerankLoadOpts {
  hfModelId: string;
  revision: string;
  dtype: OnnxDType;
  cacheDir?: string;
  modelPath?: string;
  numThreads: number;
}

/**
 * Default backend loader — dynamically imports `@huggingface/transformers`
 * (same "keep the heavy dependency chain out of every boot path that never
 * selects this provider" posture as onnx.ts's `loadTransformersBackend`) and
 * wires `AutoTokenizer` + `AutoModelForSequenceClassification` on the CPU
 * execution provider only.
 */
async function loadTransformersCrossEncoderBackend(
  opts: ResolvedOnnxRerankLoadOpts,
): Promise<OnnxCrossEncoderBackend> {
  const { AutoTokenizer, AutoModelForSequenceClassification, env } = await import('@huggingface/transformers');
  const log = childLogger({ provider: 'onnx-rerank-loader', model: opts.hfModelId });

  // Offline-first: reuses onnx.ts's `resolveLocalSnapshotDir` — loading a
  // complete cached snapshot by DIRECTORY path never touches the network
  // (see that function's doc comment for the 2026-07-16 outage class this
  // avoids: `from_pretrained(repoId, {revision})` issues a network HEAD on
  // every load regardless of cache state).
  const snapshotDir = resolveLocalSnapshotDir(opts, (env as { cacheDir?: string }).cacheDir);

  const modelId = snapshotDir ?? opts.hfModelId;
  const pretrainedOpts: Record<string, unknown> = {};
  if (snapshotDir) {
    log.info({ snapshot_dir: snapshotDir }, 'onnx-rerank: loading model from local snapshot (offline)');
  } else {
    pretrainedOpts.revision = opts.revision;
    if (opts.modelPath) {
      throw new Error(
        `onnx-rerank: config.crossEncoder.onnx.modelPath is set ("${opts.modelPath}") but no complete ` +
          `snapshot for ${opts.hfModelId}@${opts.revision} (dtype ${opts.dtype}) was found ` +
          `at "${opts.modelPath}" or a nested "<hfModelId>/<revision>" subdirectory of it ` +
          `(modelPath is an air-gapped override — no other location is consulted when it is set). ` +
          `Expected files: ${requiredSnapshotFiles(opts.dtype).join(', ')}`,
      );
    }
    if (opts.cacheDir) {
      pretrainedOpts.cache_dir = opts.cacheDir;
    }
    log.warn(
      { hf_model_id: opts.hfModelId, revision: opts.revision },
      'onnx-rerank: no local snapshot found — downloading from the hub (requires network)',
    );
  }

  const tokenizer = await AutoTokenizer.from_pretrained(modelId, pretrainedOpts);
  const model = await AutoModelForSequenceClassification.from_pretrained(modelId, {
    ...pretrainedOpts,
    dtype: opts.dtype,
    device: 'cpu',
    session_options: { intraOpNumThreads: opts.numThreads },
  });

  return {
    async tokenize(queries, texts) {
      return tokenizer(queries, { text_pair: texts, padding: true, truncation: true }) as unknown as OnnxCrossEncoderBatchEncoding;
    },
    async run(inputs) {
      return (await model(inputs)) as unknown as OnnxCrossEncoderModelOutput;
    },
  };
}

export interface OnnxCrossEncoderConfig {
  /** Canonical model label — `RERANK_MODEL_REGISTRY` lookup key, NOT the HF
   * repo id. Defaults to `DEFAULT_RERANK_MODEL_LABEL`
   * ('ms-marco-MiniLM-L-6-v2'). */
  model?: string;
  /** HF repo id to load from. Defaults to the registry entry's `hfRepo`,
   * falling back to `DEFAULT_RERANK_HF_MODEL_ID` for an unregistered
   * model. */
  hfModelId?: string;
  /** Pinned HF revision (commit SHA) — never `'main'`. */
  revision?: string;
  /** ORT weight precision. */
  dtype?: OnnxDType;
  /** Local cache directory for downloaded weights. `resolveRerankOpts`
   * (rerank.ts) defaults this to `<dataDir>/models/onnx/` — the SAME root
   * `providers/index.ts` uses for the embed model (ADR-018 S2); different
   * HF repo ids nest under distinct subdirectories, so embed and rerank
   * weights coexist there without collision. */
  cacheDir?: string;
  /** Explicit local snapshot override for offline/air-gapped installs — see
   * `resolveLocalSnapshotDir`'s doc comment (onnx.ts) for the exact lookup
   * rule when this is set. */
  modelPath?: string;
  /** ORT intraOpNumThreads cap. Defaults to `DEFAULT_NUM_THREADS`. */
  numThreads?: number;
  /** Pairs per `model()` call. Defaults to `DEFAULT_BATCH_SIZE` (16). */
  batchSize?: number;
  /** Test/DI seam only — overrides the default `@huggingface/transformers`
   * backed loader so unit tests can inject a fake backend instead of
   * downloading the real model. Production code never sets this. */
  loadBackend?: (opts: ResolvedOnnxRerankLoadOpts) => Promise<OnnxCrossEncoderBackend>;
}

export class OnnxCrossEncoderProvider implements CrossEncoderProvider {
  readonly name = 'onnx' as const;
  readonly model: string;
  private readonly hfModelId: string;
  private readonly revision: string;
  private readonly dtype: OnnxDType;
  private readonly cacheDir: string | undefined;
  private readonly modelPath: string | undefined;
  private readonly numThreads: number;
  private readonly batchSize: number;
  private readonly loadBackend: (opts: ResolvedOnnxRerankLoadOpts) => Promise<OnnxCrossEncoderBackend>;
  private backendPromise: Promise<OnnxCrossEncoderBackend> | null = null;

  constructor(config: OnnxCrossEncoderConfig = {}) {
    this.model = config.model ?? DEFAULT_RERANK_MODEL_LABEL;
    const registryEntry = RERANK_MODEL_REGISTRY[this.model];
    this.hfModelId = config.hfModelId ?? registryEntry?.hfRepo ?? DEFAULT_RERANK_HF_MODEL_ID;
    this.revision = config.revision ?? registryEntry?.defaultRevision ?? DEFAULT_RERANK_REVISION;
    this.dtype = config.dtype ?? registryEntry?.defaultDtype ?? DEFAULT_RERANK_DTYPE;
    this.cacheDir = config.cacheDir;
    this.modelPath = config.modelPath;
    this.numThreads = config.numThreads !== undefined ? clampNumThreads(config.numThreads) : DEFAULT_NUM_THREADS;
    // A fractional 0<batchSize<1 (e.g. 0.5) passes the old `>0` guard and
    // then `Math.floor` collapsed it to 0 — `score()`'s
    // `for (i=0;i<len;i+=this.batchSize)` then never advances `i` (issue #17).
    // Against the REAL onnxruntime backend this doesn't hang: `session.run()`
    // runs inside a `setImmediate` macrotask, and calling the tokenizer with
    // an empty batch throws on the first iteration — that throw propagates
    // out of `score()` into `applyRerank`'s catch, which silently falls back
    // to fused order. So the actual observable failure is a SILENT no-op
    // rerank on every call, not a hang. Either way the fix is the same: floor
    // FIRST, then require the result be >=1 before accepting it — 0,
    // negative, and NaN (a non-numeric override) all fall back to
    // DEFAULT_BATCH_SIZE. The clamp itself is logged at WARN rather than
    // applied silently — silently substituting a default for a bad override
    // is exactly the "success and failure look identical" class ADR-015
    // exists to kill; the whole value of this fix is making the misconfig
    // VISIBLE, not just harmless.
    const flooredBatchSize = Math.floor(config.batchSize ?? 0);
    // NOTE: `flooredBatchSize < 1` would silently miss the NaN case — every
    // comparison against NaN (including `< 1`) is false, so a NaN override
    // would fall back to DEFAULT_BATCH_SIZE below without ever logging the
    // warn. `!(flooredBatchSize >= 1)` is the NaN-safe negation (NaN >= 1 is
    // false, so `!false` is true) and matches the fallback condition below
    // exactly, rather than drifting into a second, subtly different check.
    if (config.batchSize !== undefined && !(flooredBatchSize >= 1)) {
      childLogger({ provider: 'onnx', model: this.model }).warn(
        { configured_batch_size: config.batchSize, effective_batch_size: DEFAULT_BATCH_SIZE },
        'onnx cross-encoder: config.crossEncoder.onnx.batchSize must floor to >=1 — ' +
          'falling back to DEFAULT_BATCH_SIZE instead of silently no-op-ing every rerank call',
      );
    }
    this.batchSize = flooredBatchSize >= 1 ? flooredBatchSize : DEFAULT_BATCH_SIZE;
    this.loadBackend = config.loadBackend ?? loadTransformersCrossEncoderBackend;
  }

  /**
   * Lazy, memoized session load — same posture as `OnnxEmbedProvider`
   * (onnx.ts): the constructor never triggers a weight download or session
   * load; the FIRST real `score()` call after boot (or after config
   * selects this provider) pays that cost inline, every subsequent call in
   * the process lifetime reuses the memoized session. A failed load is NOT
   * memoized, so a transient failure can be retried on the next call.
   */
  private getBackend(): Promise<OnnxCrossEncoderBackend> {
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
   * Public, idempotent wrapper around `getBackend()` — same shape as
   * `OnnxEmbedProvider.preload()` — lets a future caller trigger the model
   * load proactively at daemon boot instead of paying it on the first real
   * search request. Not wired into `serve.ts` by this change (out of this
   * worktree's scope — `serve.ts` boot wiring belongs to whichever change
   * next touches daemon startup); `score()` alone is fully correct without
   * it, just cold on the first call.
   */
  async preload(): Promise<void> {
    await this.getBackend();
  }

  /**
   * `signal`: mirrors `OnnxEmbedProvider.embed()`'s honestly-narrowed
   * cancellation contract — in-process ORT inference has no `fetch`-style
   * mid-call abort plumbing, so the signal is checked BETWEEN batches and
   * throws immediately once set, but a signal that fires mid-batch will not
   * interrupt that in-flight `run()` call.
   */
  async score(query: string, candidates: CrossEncoderCandidate[], signal?: AbortSignal): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (candidates.length === 0) return out;

    const log = childLogger({ provider: this.name, model: this.model });
    const t0 = Date.now();
    const backend = await this.getBackend();

    for (let i = 0; i < candidates.length; i += this.batchSize) {
      if (signal?.aborted) {
        throw signal.reason instanceof Error
          ? signal.reason
          : new DOMException('The operation was aborted', 'AbortError');
      }

      const batch = candidates.slice(i, i + this.batchSize);
      const queries = batch.map(() => query);
      const texts = batch.map((c) => c.text);
      const encoded = await backend.tokenize(queries, texts);
      const output = await backend.run(encoded);
      const scores = extractSigmoidScores(output);

      for (let j = 0; j < batch.length; j++) {
        const candidate = batch[j];
        const score = scores[j];
        if (candidate !== undefined && score !== undefined) {
          out.set(candidate.id, score);
        }
      }
    }

    const latency_ms = Date.now() - t0;
    log.info({ latency_ms, device: 'cpu', candidates: candidates.length, scored: out.size }, 'onnx cross-encoder rerank ok');
    return out;
  }
}
