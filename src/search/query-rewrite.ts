/**
 * Query rewrite/expansion stage (FEAT-550, ADR-005 seam pattern — mirrors
 * src/search/decompose.ts and src/search/rerank.ts).
 *
 * Before retrieval, an optional cheap local LLM call rewrites/expands the
 * caller's query into alias/synonym/decomposition variants (entity-alias
 * forms, synonyms, sub-questions — e.g. "when did X move?" also produces "X
 * new apartment date"). Retrieval then runs over the union of the original
 * query and every variant; hits are merged by atom id keeping the MAX score
 * across all variant hit sets (see `mergeVariantHits` below and the merge
 * step in search.ts) — no new ranking model, no re-ordering within a single
 * variant's own result list, no damping (unlike WS6's supplemental-add
 * merge in decompose.ts, which this stage deliberately does NOT reuse — see
 * that module's dilution-bound doc comment for why a damped merge exists
 * there and not here).
 *
 * OFF by default (config.search.queryRewrite.mode: 'off') —
 * `resolveQueryRewriteOpts` returns `undefined` in that case and search()
 * takes its pre-FEAT-550 code path with zero extra branches, byte-identical
 * to before this file existed (AC-1). Even when `mode: 'enabled'`, search()
 * only actually invokes this stage when the caller ALSO passes `expand:
 * true` (`SearchOpts.expand`) — a synchronous local-model call on the hot
 * recall path is a real latency risk until measured (this FEAT's own "No
 * default-on for interactive recall until latency measured" scope fence),
 * so enabling the config only makes the capability AVAILABLE, never
 * default-on for a plain search() call.
 *
 * Fail-open contract (AC-2/AC-5): a rewrite call that throws, times out, or
 * exceeds its hard `timeoutMs` cap — OR that succeeds but produces zero
 * usable variants (empty/degenerate output, e.g. every variant echoes the
 * original query) — degrades exactly to pre-FEAT-550 behavior: retrieval
 * runs over the ORIGINAL QUERY ONLY. Both cases return `[]` from
 * `getQueryVariants`, never throw; the caller (search.ts) treats an empty
 * variant list identically regardless of which case produced it — this is
 * the same fallback posture `getSubQueries` (decompose.ts) and
 * `applyRerank` (rerank.ts) already carry.
 */

import type { Config } from '../config/config.js';
import type { LLMProvider } from '../contracts/llm.js';
import type { FusedHit } from './fuse.js';
import { childLogger } from '../log/logger.js';
import { withAbortableTimeout } from '../util/abortable-timeout.js';

export interface QueryRewriter {
  readonly name: 'mock' | 'llm';
  /**
   * Return 0+ rewritten query variants. An empty array means "no useful
   * rewrite" (or the rewriter couldn't produce one) — callers treat that
   * exactly like the stage being disabled for this call.
   *
   * `signal` fires when `getQueryVariants`'s timeout budget elapses (mirrors
   * `QueryDecomposer.decompose`'s contract) — a real (LLM-backed)
   * implementation must forward it into its provider call so a timeout
   * actually cancels the in-flight request instead of abandoning it.
   * `MockQueryRewriter` ignores it — it never does I/O.
   */
  rewrite(query: string, signal?: AbortSignal): Promise<string[]>;
}

/**
 * Deterministic MOCK rewriter: NOT a real rewriter — it carries no semantic
 * understanding, just a couple of cheap heuristic transforms (stripping a
 * leading interrogative word, and appending a generic broadening suffix) so
 * a unit test / `provider: 'mock'` can prove the stage is correctly wired
 * end to end without a model. `LlmQueryRewriter` (below) plugs a real LLM in
 * behind the same `QueryRewriter` interface without touching search.ts.
 */
export class MockQueryRewriter implements QueryRewriter {
  readonly name = 'mock' as const;

  async rewrite(query: string): Promise<string[]> {
    const trimmed = query.trim();
    if (!trimmed) return [];
    const variants: string[] = [];
    const stripped = trimmed.replace(/^(what|who|when|where|why|how)\s+/i, '').trim();
    if (stripped && stripped.toLowerCase() !== trimmed.toLowerCase()) variants.push(stripped);
    variants.push(`${trimmed} details`);
    return variants;
  }
}

/**
 * Real LLM-backed rewriter (FEAT-550). Asks the model for a JSON array of up
 * to `maxVariants` alternative standalone search queries — alias forms,
 * synonyms, simple decompositions — that would retrieve the same
 * information as the original query. A query with no useful rewrite is
 * expected to yield `[]`; the caller's `getQueryVariants` treats fewer than
 * 1 usable variant as "nothing to add" either way.
 *
 * Parsing follows `LlmQueryDecomposer`'s exact tolerant-extraction posture
 * (issue #261 precedent): a clean JSON array is the expected shape; a JSON
 * object is accepted as a fallback (its keys); anything else yields `[]`,
 * never an error. Genuine provider failures (network error, thrown
 * exception) still propagate so `getQueryVariants`'s timeout/error fallback
 * logs them.
 */
export class LlmQueryRewriter implements QueryRewriter {
  readonly name = 'llm' as const;

  constructor(
    private readonly provider: LLMProvider,
    private readonly maxVariants: number,
  ) {}

  async rewrite(query: string, signal?: AbortSignal): Promise<string[]> {
    const result = await this.provider.chat(
      [
        {
          role: 'system',
          content:
            'You rewrite a search query into up to ' + this.maxVariants +
            ' alternative standalone search queries — entity-alias forms, synonyms, and simple ' +
            'decompositions — that together would help retrieve the same information. Return ONLY ' +
            'a JSON array of strings, no prose, no markdown fences. If no useful rewrite exists, ' +
            'return an empty array: []',
        },
        { role: 'user', content: query },
      ],
      {
        json: true,
        jsonSchema: { type: 'array', items: { type: 'string' } },
        temperature: 0,
        maxTokens: 300,
        signal,
      },
    );

    return extractVariants(result.text)
      .map(s => s.trim())
      .filter(s => s.length > 0)
      .slice(0, this.maxVariants);
  }
}

/**
 * Tolerant extraction of a variant list from a rewriter's raw response text
 * — mirrors decompose.ts's `extractSubQueries` exactly (same live-evidence
 * rationale: some local models return a JSON object instead of an array).
 */
function extractVariants(raw: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (Array.isArray(parsed)) {
    return parsed.filter((s): s is string => typeof s === 'string');
  }
  if (parsed !== null && typeof parsed === 'object') {
    return Object.keys(parsed as Record<string, unknown>);
  }
  return [];
}

/** Resolved query-rewrite options as consumed by `getQueryVariants` / `SearchOpts.queryRewrite`. */
export interface QueryRewriteOpts {
  rewriter: QueryRewriter;
  maxVariants: number;
  timeoutMs: number;
  /**
   * Cap on the merged (original query + every variant) fused candidate set
   * size — bounds the cost of the downstream meta/memory-row join, not a
   * relevance judgment. See `mergeVariantHits` below.
   */
  maxCandidates: number;
}

/**
 * Build a `QueryRewriter` from config. `provider: 'llm'` reuses the existing
 * extraction LLM provider machinery (src/providers/index.ts) —
 * `config.search.queryRewrite.model` optionally overrides the model,
 * defaulting to `config.llm.extraction.model` on
 * `config.llm.extraction.provider` (no new provider-selection surface
 * invented for this one stage — same posture as `buildQueryDecomposer`).
 */
export function buildQueryRewriter(
  config: Config,
  buildLLMProvider: (providerName: Config['llm']['extraction']['provider'], model: string, config: Config) => LLMProvider,
): QueryRewriter {
  if (config.search.queryRewrite.provider === 'mock') return new MockQueryRewriter();
  const model = config.search.queryRewrite.model ?? config.llm.extraction.model;
  return new LlmQueryRewriter(
    buildLLMProvider(config.llm.extraction.provider, model, config),
    config.search.queryRewrite.maxVariants,
  );
}

/**
 * Resolve `SearchOpts.queryRewrite` from config: `undefined` when
 * `mode !== 'enabled'` (so search() takes zero extra branches — same
 * contract as `resolveDecomposeOpts`/`resolveRerankOpts`), or a fully-built
 * `QueryRewriteOpts` (rewriter instantiated once, reused per call) when
 * enabled. Note this only makes the stage AVAILABLE — see this module's doc
 * comment for the additional per-call `expand: true` gate search() applies.
 */
export function resolveQueryRewriteOpts(
  config: Config,
  buildLLMProvider: (providerName: Config['llm']['extraction']['provider'], model: string, config: Config) => LLMProvider,
): QueryRewriteOpts | undefined {
  if (config.search.queryRewrite.mode !== 'enabled') return undefined;
  return {
    rewriter: buildQueryRewriter(config, buildLLMProvider),
    maxVariants: config.search.queryRewrite.maxVariants,
    timeoutMs: config.search.queryRewrite.timeoutMs,
    maxCandidates: config.search.queryRewrite.maxCandidates,
  };
}

class QueryRewriteTimeoutError extends Error {}

/**
 * Run the rewrite stage for one query: the rewriter call under a hard
 * timeout, then de-dup/cap. Returns `[]` (never throws) on a timeout, a
 * provider error, or fewer than 1 usable variant (echo of the original
 * query, blank strings) — every one of those cases means "search.ts should
 * treat this call exactly like the stage never ran," which is the fallback
 * contract this stage promises (degrades quality, never availability — same
 * posture as decompose.ts/rerank.ts, and satisfies AC-2/AC-5 together: a
 * hard failure and a "succeeded but useless" result are indistinguishable
 * to the caller, both fail open).
 */
export async function getQueryVariants(query: string, opts: QueryRewriteOpts): Promise<string[]> {
  const log = childLogger({ stage: 'query-rewrite', provider: opts.rewriter.name });
  const t0 = Date.now();
  try {
    const raw = await withAbortableTimeout(
      (signal) => opts.rewriter.rewrite(query, signal),
      opts.timeoutMs,
      () => new QueryRewriteTimeoutError(`query rewrite timed out after ${opts.timeoutMs}ms`),
    );
    // De-dup (case-insensitive) and drop anything identical to the original
    // query — a rewriter that echoes the input back adds gather/fuse cost
    // for zero new candidates.
    const seen = new Set<string>([query.trim().toLowerCase()]);
    const cleaned: string[] = [];
    for (const v of raw) {
      const key = v.trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      cleaned.push(v.trim());
      if (cleaned.length >= opts.maxVariants) break;
    }
    log.info({ outcome: 'ok', latency_ms: Date.now() - t0, variants: cleaned.length }, 'query-rewrite stage complete');
    return cleaned;
  } catch (err) {
    const outcome = err instanceof QueryRewriteTimeoutError ? 'timeout' : 'error';
    log.warn(
      { outcome, latency_ms: Date.now() - t0, error_message: err instanceof Error ? err.message : String(err) },
      'query-rewrite stage fallback to original-query-only',
    );
    return [];
  }
}

/**
 * AC-3 fusion: merge the primary (original-query) fused hits with N
 * variants' own separately-fused hit lists by atom id, keeping the MAX
 * score across all lists — no damping, no re-ordering within any one list's
 * own result set, no new ranking model. The primary list's hits are ALWAYS
 * part of the returned union (seeded first, below) even when every variant
 * returns zero hits.
 *
 * The merged union is then capped to `maxCandidates` (ranked by score) — a
 * cost bound on the downstream meta/memory-row join, not a relevance
 * judgment: a low-scoring primary hit CAN be displaced by the cap when
 * enough higher-scoring variant hits exist. This is deliberately simpler
 * than WS6's damped-supplemental merge (decompose.ts) — FEAT-550 is
 * explicitly scoped to "no new ranking model, no re-ordering," so a
 * straightforward max-by-id union is the right instrument here, not a
 * dilution-bounded blend.
 */
export function mergeVariantHits(
  primary: FusedHit[],
  variants: FusedHit[][],
  maxCandidates: number,
): FusedHit[] {
  const byId = new Map<string, FusedHit>();
  for (const hit of primary) byId.set(hit.id, hit);
  for (const variantHits of variants) {
    for (const hit of variantHits) {
      const existing = byId.get(hit.id);
      if (!existing || hit.score > existing.score) byId.set(hit.id, hit);
    }
  }
  return Array.from(byId.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, maxCandidates);
}
