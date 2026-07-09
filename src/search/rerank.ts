/**
 * Cross-encoder rerank stage (issue #26, ADR-005 cloud-parity seam).
 *
 * ADR-005 ruled local ships v1 with "no reranker (CPU budget)" — this stage
 * is the OFF-by-default seam that lets a future rerank rollout happen via
 * config flip + eval evidence, without ever touching search()'s default
 * behavior. It mirrors the cloud engine's `ICrossEncoderRanker` shape
 * (StubCrossEncoderRanker / HttpCrossEncoderRanker, config
 * `Search:CrossEncoder.{Enabled,TopK,Provider,TimeoutMs}`) described in
 * issue #26, adapted to this repo's provider-abstraction pattern
 * (contracts/embed.ts's `EmbedProvider`).
 *
 * Contract:
 *  - `CrossEncoderProvider.score()` returns a query-conditioned relevance
 *    score per candidate id, clamped to [0,1] by the stage (defense-in-depth,
 *    same posture as fuseScores() in fuse.ts) so the wire score contract
 *    holds regardless of what a future provider returns.
 *  - The stage only reranks the top `topK` fused hits (cost control) and
 *    leaves everything beyond that position untouched, in its original
 *    fused order.
 *  - On timeout or provider error, the stage falls back to the un-reranked
 *    fused order for the WHOLE call (never a partial reorder) — degrades
 *    quality, never availability, matching the cloud engine's fallback
 *    contract from issue #26.
 *  - FEAT-452: a hit the stage actually reorders gains `reranked`/
 *    `rerank_score`/`explanation` (see `RerankFields` below) rather than
 *    having its `score` overwritten in place — `score` always stays the
 *    original fused value, so a caller can tell a fused score from a
 *    reranked one instead of losing the fused value the moment rerank runs.
 */

import type { Config } from '../config/config.js';
import { childLogger } from '../log/logger.js';

/** One post-fusion candidate handed to the reranker. */
export interface CrossEncoderCandidate {
  id: string;
  text: string;
  /** Pre-rerank fused score — providers may ignore it or blend with it. */
  fusedScore: number;
}

export interface CrossEncoderProvider {
  readonly name: 'mock' | 'http';
  /** Score every candidate against `query`. Returned map need not cover every
   * id — a missing id falls back to its original fused score (see
   * `applyRerank`). Scores need not be pre-clamped to [0,1]; the stage clamps
   * defensively before use. */
  score(query: string, candidates: CrossEncoderCandidate[]): Promise<Map<string, number>>;
}

/**
 * Deterministic MOCK cross-encoder: lexical (Jaccard) token overlap between
 * the query and candidate text, in [0,1]. This is NOT a real cross-encoder —
 * it carries no semantic signal beyond shared tokens — but it is fully
 * deterministic (no network, no model, no seed drift across OSes/CI), which
 * is exactly what a rerank-stage unit test and the ADR-005 eval harness need
 * to prove the stage is correctly wired end-to-end. `HttpCrossEncoderProvider`
 * (below) plugs a real sidecar in behind the same `CrossEncoderProvider`
 * interface without touching `applyRerank`.
 */
export class MockCrossEncoderProvider implements CrossEncoderProvider {
  readonly name = 'mock' as const;

  async score(query: string, candidates: CrossEncoderCandidate[]): Promise<Map<string, number>> {
    const queryTokens = tokenize(query);
    const out = new Map<string, number>();
    for (const c of candidates) {
      out.set(c.id, jaccard(queryTokens, tokenize(c.text)));
    }
    return out;
  }
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/i)
      .filter(Boolean),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export interface HttpCrossEncoderConfig {
  /** Base URL of the sidecar's rerank endpoint (config.crossEncoder.sidecarUrl). */
  url: string;
  /** Optional model id forwarded in the request body (config.crossEncoder.model). */
  model?: string;
  /** Per-request abort budget. Independent of (but normally set to)
   * `RerankOpts.timeoutMs` — see `buildCrossEncoderProvider`. */
  timeoutMs?: number;
  /** Test-only seam: injected fetch so unit tests never hit the network. */
  fetchImpl?: typeof fetch;
}

/** One entry of a TEI-style `/rerank` response. */
interface HttpRerankResult {
  index: number;
  score: number;
}

type HttpRerankResponse = HttpRerankResult[] | { results?: HttpRerankResult[] };

const DEFAULT_HTTP_TIMEOUT_MS = 300;

/**
 * Real HTTP cross-encoder provider (issue #26/#94). Speaks the common
 * cross-encoder sidecar contract: a Hugging Face Text Embeddings Inference
 * (TEI) `/rerank`-shaped endpoint.
 *
 * Request:  `POST <url>` with JSON body `{ query, texts, model? }`, where
 *           `texts[i]` corresponds positionally to `candidates[i]`.
 * Response: either a bare array of `{ index, score }` (TEI's native shape,
 *           `index` into `texts`) or `{ results: [{ index, score }] }`
 *           (the wrapped shape some sidecars use). Either is accepted.
 *
 * Errors (non-2xx status, network failure, malformed/missing response
 * shape) are thrown rather than swallowed here — `applyRerank` is the single
 * place that converts a provider failure into the whole-call fallback to the
 * un-reranked fused order, so this provider must not silently return a
 * partial or empty map on failure (that would look like "no candidate
 * matched" instead of "the sidecar is unreachable").
 */
export class HttpCrossEncoderProvider implements CrossEncoderProvider {
  readonly name = 'http' as const;
  private readonly url: string;
  private readonly model: string | undefined;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(config: HttpCrossEncoderConfig) {
    this.url = config.url;
    this.model = config.model;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async score(query: string, candidates: CrossEncoderCandidate[]): Promise<Map<string, number>> {
    if (candidates.length === 0) return new Map();

    const log = childLogger({ provider: this.name, url: this.url });
    const t0 = Date.now();
    const body: Record<string, unknown> = {
      query,
      texts: candidates.map(c => c.text),
    };
    if (this.model) body['model'] = this.model;

    let res: Response;
    try {
      res = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const latency_ms = Date.now() - t0;
      log.warn({ latency_ms, error: err instanceof Error ? err.message : String(err) }, 'cross-encoder http request failed');
      throw new Error(
        `cross-encoder HTTP request to ${this.url} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (!res.ok) {
      const snippet = (await res.text().catch(() => '')).slice(0, 200);
      const latency_ms = Date.now() - t0;
      log.warn({ latency_ms, status: res.status }, 'cross-encoder http non-2xx response');
      throw new Error(`cross-encoder HTTP ${res.status} from ${this.url}: ${snippet}`);
    }

    const data = (await res.json()) as HttpRerankResponse;
    const results = Array.isArray(data) ? data : data.results;
    if (!Array.isArray(results)) {
      throw new Error(
        `cross-encoder HTTP response from ${this.url} missing a results array (expected TEI-style [{index,score}] or {results:[...]})`,
      );
    }

    const out = new Map<string, number>();
    for (const r of results) {
      const candidate = candidates[r.index];
      if (candidate !== undefined && Number.isFinite(r.score)) {
        out.set(candidate.id, r.score);
      }
    }

    const latency_ms = Date.now() - t0;
    log.info({ latency_ms, candidates: candidates.length, scored: out.size }, 'cross-encoder http rerank ok');
    return out;
  }
}

/** Resolved rerank options as consumed by `applyRerank` / `SearchOpts.rerank`. */
export interface RerankOpts {
  topK: number;
  timeoutMs: number;
  provider: CrossEncoderProvider;
}

/**
 * Build a `CrossEncoderProvider` from config. `provider: 'http'` requires
 * `sidecarUrl` — throws a clear config error at build time (startup) rather
 * than at first-search-time if it's missing. See
 * docs/runbooks/cross-encoder-rerank.md for the endpoint contract and how to
 * run a sidecar.
 */
export function buildCrossEncoderProvider(config: Config['crossEncoder']): CrossEncoderProvider {
  if (config.provider === 'mock') return new MockCrossEncoderProvider();
  if (!config.sidecarUrl) {
    throw new Error(
      "crossEncoder.provider 'http' requires crossEncoder.sidecarUrl to be set " +
        "(see docs/runbooks/cross-encoder-rerank.md). Set sidecarUrl or use provider: 'mock'.",
    );
  }
  return new HttpCrossEncoderProvider({
    url: config.sidecarUrl,
    model: config.model,
    timeoutMs: config.timeoutMs,
  });
}

/**
 * Resolve `SearchOpts.rerank` from config: `undefined` when disabled (so the
 * search pipeline takes zero extra branches when the feature is off), or a
 * fully-built `RerankOpts` (provider instantiated once, reused per call) when
 * enabled.
 */
export function resolveRerankOpts(config: Config): RerankOpts | undefined {
  if (!config.crossEncoder.enabled) return undefined;
  return {
    topK: config.crossEncoder.topK,
    timeoutMs: config.crossEncoder.timeoutMs,
    provider: buildCrossEncoderProvider(config.crossEncoder),
  };
}

/** Thrown by `withTimeout` — distinguished from a provider-thrown `Error` so
 * the outcome-tagged observability log below (FEAT-452) can tell "sidecar
 * too slow" (`timeout`) apart from "sidecar errored" (`error`). */
class RerankTimeoutError extends Error {}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new RerankTimeoutError(`cross-encoder rerank timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/**
 * ADR-005 `ScoreExplanation.signals[name]` shape
 * (contracts/schemas/retrieval-result.v1.schema.json), reused here so a
 * reranked hit's cross-encoder provenance is additive to — and validates
 * against — the shared retrieval-result contract's open signals map (FEAT-452).
 */
export interface RerankSignal {
  /** Fused score this hit carried into the cross-encoder call — same value as `score`. */
  raw: number;
  /** Rerank fully determines a reranked hit's position within `topK`, no blending with other signals — always 1. */
  weight: number;
  /** Clamped cross-encoder score — same value as the flat `rerank_score` below. */
  final: number;
}

/**
 * Rerank provenance a hit gains once the cross-encoder stage actually scores
 * it (FEAT-452). Present + `reranked: true` only on hits the stage scored
 * this call — i.e. within `opts.topK`, and the call didn't hit the
 * whole-call timeout/error fallback; absent everywhere else (not just
 * `false`), so an un-reranked hit's shape is identical to before this field
 * existed. `score` is left untouched by `applyRerank` regardless — it always
 * stays the original fused value.
 */
export interface RerankFields {
  reranked: true;
  rerank_score: number;
  explanation: { signals: { cross_encoder: RerankSignal } };
}

/**
 * Apply the rerank stage to an already-fused, already-ordered hit list.
 * Reorders only the first `opts.topK` hits by cross-encoder score; hits
 * beyond that position are appended unchanged, in their original relative
 * order. On timeout or provider error, returns `hits` completely unchanged
 * (whole-call fallback, not a partial reorder) — availability over quality.
 *
 * FEAT-452: reordered hits gain `RerankFields` (see above) rather than
 * having `score` overwritten with the cross-encoder value — `score` stays
 * the fused score, `rerank_score`/`explanation` carry the cross-encoder's
 * verdict as a distinct, additive signal.
 */
export async function applyRerank<T extends { id: string; text: string; score: number }>(
  query: string,
  hits: T[],
  opts: RerankOpts,
): Promise<Array<T & Partial<RerankFields>>> {
  if (hits.length === 0) return hits;

  const head = hits.slice(0, opts.topK);
  const tail = hits.slice(opts.topK);

  // Local observability parity (FEAT-452): mirrors the cloud engine's
  // outcome-tagged counters/histograms for its reranker. This repo has no
  // separate metrics registry — every stage that talks to a provider
  // (providers/llm/*, providers/embed/ollama.ts, this file's own
  // HttpCrossEncoderProvider.score() above) reports via structured
  // `latency_ms` + outcome pino log lines instead, which is the pattern
  // followed here: a log aggregator turns these into counters/histograms
  // the same way it would for the ~10 other call sites using this shape.
  const log = childLogger({ stage: 'rerank', provider: opts.provider.name });
  const t0 = Date.now();
  log.info({ topK: opts.topK, candidates: head.length }, 'rerank stage start');

  try {
    const candidates: CrossEncoderCandidate[] = head.map(h => ({ id: h.id, text: h.text, fusedScore: h.score }));
    const scored = await withTimeout(opts.provider.score(query, candidates), opts.timeoutMs);

    const reranked = head
      .map(h => {
        const raw = scored.get(h.id);
        // Missing id or non-finite score: fall back to the fused score for
        // this hit rather than let one bad entry corrupt the sort.
        const rerank_score = raw === undefined || !Number.isFinite(raw) ? h.score : Math.min(1, Math.max(0, raw));
        return {
          ...h,
          reranked: true as const,
          rerank_score,
          explanation: { signals: { cross_encoder: { raw: h.score, weight: 1, final: rerank_score } } },
        };
      })
      .sort((a, b) => b.rerank_score - a.rerank_score);

    log.info({ outcome: 'ok', latency_ms: Date.now() - t0, candidates: head.length }, 'rerank stage complete');
    return [...reranked, ...tail];
  } catch (err) {
    // Timeout or provider failure: degrade to un-reranked order, never block
    // the request (mirrors cloud's fallback contract from issue #26). No
    // hit in this path gains RerankFields — the whole call is untouched, not
    // just the missing-score fallback inside the try block above.
    const outcome = err instanceof RerankTimeoutError ? 'timeout' : 'error';
    log.warn(
      { outcome, latency_ms: Date.now() - t0, error_message: err instanceof Error ? err.message : String(err) },
      'rerank stage fallback to un-reranked order',
    );
    return hits;
  }
}
