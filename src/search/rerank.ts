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
 */

import type { Config } from '../config/config.js';

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
 * to prove the stage is correctly wired end-to-end. A real provider (TODO:
 * HTTP sidecar, see docs/runbooks/cross-encoder-rerank.md) plugs in behind
 * the same `CrossEncoderProvider` interface without touching `applyRerank`.
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

/** Resolved rerank options as consumed by `applyRerank` / `SearchOpts.rerank`. */
export interface RerankOpts {
  topK: number;
  timeoutMs: number;
  provider: CrossEncoderProvider;
}

/**
 * Build a `CrossEncoderProvider` from config. Throws for `provider: 'http'`
 * — the real sidecar client is a documented TODO (see
 * docs/runbooks/cross-encoder-rerank.md); wiring an HTTP call here without a
 * real sidecar to test against would be unverifiable, so it fails loudly at
 * startup instead of silently degrading every search.
 */
export function buildCrossEncoderProvider(config: Config['crossEncoder']): CrossEncoderProvider {
  if (config.provider === 'mock') return new MockCrossEncoderProvider();
  throw new Error(
    "crossEncoder.provider 'http' is not implemented yet (TODO — see docs/runbooks/cross-encoder-rerank.md). " +
      "Use provider: 'mock' or set crossEncoder.enabled: false.",
  );
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

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`cross-encoder rerank timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/**
 * Apply the rerank stage to an already-fused, already-ordered hit list.
 * Reorders only the first `opts.topK` hits by cross-encoder score; hits
 * beyond that position are appended unchanged, in their original relative
 * order. On timeout or provider error, returns `hits` completely unchanged
 * (whole-call fallback, not a partial reorder) — availability over quality.
 */
export async function applyRerank<T extends { id: string; text: string; score: number }>(
  query: string,
  hits: T[],
  opts: RerankOpts,
): Promise<T[]> {
  if (hits.length === 0) return hits;

  const head = hits.slice(0, opts.topK);
  const tail = hits.slice(opts.topK);

  try {
    const candidates: CrossEncoderCandidate[] = head.map(h => ({ id: h.id, text: h.text, fusedScore: h.score }));
    const scored = await withTimeout(opts.provider.score(query, candidates), opts.timeoutMs);

    const reranked = head
      .map(h => {
        const raw = scored.get(h.id);
        // Missing id or non-finite score: fall back to the fused score for
        // this hit rather than let one bad entry corrupt the sort.
        const score = raw === undefined || !Number.isFinite(raw) ? h.score : Math.min(1, Math.max(0, raw));
        return { ...h, score };
      })
      .sort((a, b) => b.score - a.score);

    return [...reranked, ...tail];
  } catch {
    // Timeout or provider failure: degrade to un-reranked order, never block
    // the request (mirrors cloud's fallback contract from issue #26).
    return hits;
  }
}
