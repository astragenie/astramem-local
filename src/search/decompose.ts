/**
 * Query decomposition stage (WS6, LoCoMo multi-hop workstream, ADR-005
 * seam pattern — mirrors src/search/rerank.ts).
 *
 * Multi-hop questions ("What does the person who gave Melanie the painting
 * do for work?") need two chained retrievals — one query embedding rarely
 * matches both the "who gave the painting" fact and the "what do they do"
 * fact. `search()` runs exactly one FTS+vec pass per call, so the second
 * hop is invisible to it today. This stage splits the caller's query into
 * sub-queries, retrieves candidates for each, and merges them into the
 * fused candidate set as a BOUNDED, capped, separately-normalized addition
 * — never a re-normalization of the primary candidates.
 *
 * OFF by default (config.multiHop.enabled: false) — `resolveDecomposeOpts`
 * returns `undefined` in that case and `search()` takes its pre-WS6 code
 * path with zero extra branches, byte-identical to before this file existed.
 *
 * Dilution bound (the risk this whole stage exists to manage — see
 * fuse.ts's `normalizeScores`, a min-max over whatever candidate array it's
 * given): supplemental (sub-query-sourced) candidates are fused in their
 * OWN, separate `fuseHits()` call — never merged into the primary
 * candidate array before normalization — so the primary hits' scores are
 * computed by the exact same call, with the exact same inputs, as if this
 * stage didn't run at all. Supplemental candidates are then capped to at
 * most `maxSupplemental` (ranked by their own fused score) and damped by
 * `supplementalWeight` (< 1), so a supplemental hit's final score can never
 * reach what an undamped, equally-strong direct hit would have scored —
 * bounding how much of the merged ranking a decomposition-only candidate
 * can ever claim. See search.ts's merge step for where this is applied.
 *
 * Cost/latency bound (AC-4): decomposition is a per-recall LLM call on a
 * hot, latency-sensitive path, so it is triple-gated —
 *  - `minQueryWords`: a cheap, network-free skip for queries that are
 *    obviously single-hop (short lookups), so the common case never pays
 *    for a decomposer call at all.
 *  - `timeoutMs`: a hard per-call budget; a slow/hung decomposer degrades
 *    to zero sub-queries (single-pass behavior for that call) rather than
 *    blocking the request — matches rerank.ts's fallback contract.
 *  - `maxSubQueries`: caps how many sub-queries (and therefore extra
 *    gather/fuse work) one decomposition can ever produce.
 */

import type { Config } from '../config/config.js';
import type { LLMProvider } from '../contracts/llm.js';
import { childLogger } from '../log/logger.js';

export interface QueryDecomposer {
  readonly name: 'mock' | 'llm';
  /** Return 0+ sub-queries. An empty array means "no decomposition needed"
   *  (or the decomposer couldn't produce one) — callers treat that exactly
   *  like the stage being disabled for this call. */
  decompose(query: string): Promise<string[]>;
}

/**
 * Deterministic MOCK decomposer: NOT a real decomposer — it carries no
 * semantic understanding of the query, just a heuristic split on common
 * multi-hop relative-clause markers ("who"/"which"/"that") and the
 * coordinating conjunction "and". This is fully deterministic (no network,
 * no model) which is exactly what a unit test and `provider: 'mock'` need
 * to prove the stage is correctly wired end-to-end. `LlmQueryDecomposer`
 * (below) plugs a real LLM in behind the same `QueryDecomposer` interface
 * without touching any merge/caller code.
 */
export class MockQueryDecomposer implements QueryDecomposer {
  readonly name = 'mock' as const;

  async decompose(query: string): Promise<string[]> {
    const parts = query
      .split(/\b(?:who|which|whom|that|and)\b/i)
      .map(s => s.trim())
      .filter(s => s.length > 0 && s.split(/\s+/).length >= 2);
    if (parts.length < 2) return [];
    return parts.slice(0, 2);
  }
}

/**
 * Real LLM-backed decomposer (WS6). Asks the model for a JSON array of up
 * to `maxSubQueries` standalone search queries that together could retrieve
 * every fact a multi-hop question needs. A single-hop question is expected
 * to yield `[]` (or one element equal to the input) — either way the
 * caller's `getSubQueries` treats `<2` sub-queries as "nothing to add".
 *
 * Parsing is lenient by design: any non-JSON, non-array, or non-string-array
 * response is treated as "no sub-queries" (empty array), not an error —
 * a decomposer that can't produce a clean split is exactly equivalent to a
 * query that doesn't need decomposing, from the caller's point of view.
 * Genuine provider failures (network error, thrown exception) still
 * propagate so `getSubQueries`'s timeout/error fallback logs them.
 */
export class LlmQueryDecomposer implements QueryDecomposer {
  readonly name = 'llm' as const;

  constructor(
    private readonly provider: LLMProvider,
    private readonly maxSubQueries: number,
  ) {}

  async decompose(query: string): Promise<string[]> {
    const result = await this.provider.chat(
      [
        {
          role: 'system',
          content:
            'You decompose a search query into up to ' + this.maxSubQueries +
            ' simpler standalone search queries that, together, could retrieve every fact ' +
            'needed to answer a multi-hop question. Return ONLY a JSON array of strings, ' +
            'no prose, no markdown fences. If the query already targets a single fact, ' +
            'return an empty array: []',
        },
        { role: 'user', content: query },
      ],
      { json: true, temperature: 0, maxTokens: 300 },
    );

    let parsed: unknown;
    try {
      parsed = JSON.parse(result.text);
    } catch {
      return [];
    }
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
      .map(s => s.trim())
      .slice(0, this.maxSubQueries);
  }
}

/** Resolved multi-hop decompose options as consumed by `getSubQueries` / `SearchOpts.decompose`. */
export interface DecomposeOpts {
  decomposer: QueryDecomposer;
  /** Cheap, network-free skip: queries with fewer words than this never
   *  reach the decomposer at all — single-hop lookups are typically short. */
  minQueryWords: number;
  maxSubQueries: number;
  /** Cap on how many NEW (not already in the primary candidate set) ids the
   *  merge step in search.ts may add, regardless of how many sub-queries ran. */
  maxSupplemental: number;
  /** Damping factor in (0,1] applied to every supplemental candidate's own
   *  fused score — bounds how much of the ranking a decomposition-only
   *  candidate can claim relative to an equally-strong direct hit. */
  supplementalWeight: number;
  timeoutMs: number;
}

/**
 * Build a `QueryDecomposer` from config. `provider: 'llm'` reuses the
 * existing extraction LLM provider machinery (src/providers/index.ts) —
 * `config.multiHop.model` optionally overrides the model, defaulting to
 * `config.llm.extraction.model` on `config.llm.extraction.provider` (no new
 * provider-selection surface invented for this one stage).
 */
export function buildQueryDecomposer(
  config: Config,
  buildLLMProvider: (providerName: Config['llm']['extraction']['provider'], model: string, config: Config) => LLMProvider,
): QueryDecomposer {
  if (config.multiHop.provider === 'mock') return new MockQueryDecomposer();
  const model = config.multiHop.model ?? config.llm.extraction.model;
  return new LlmQueryDecomposer(
    buildLLMProvider(config.llm.extraction.provider, model, config),
    config.multiHop.maxSubQueries,
  );
}

/**
 * Resolve `SearchOpts.decompose` from config: `undefined` when disabled (so
 * search() takes zero extra branches — same contract as
 * rerank.ts's `resolveRerankOpts`), or a fully-built `DecomposeOpts`
 * (decomposer instantiated once, reused per call) when enabled.
 */
export function resolveDecomposeOpts(
  config: Config,
  buildLLMProvider: (providerName: Config['llm']['extraction']['provider'], model: string, config: Config) => LLMProvider,
): DecomposeOpts | undefined {
  if (!config.multiHop.enabled) return undefined;
  return {
    decomposer: buildQueryDecomposer(config, buildLLMProvider),
    minQueryWords: config.multiHop.minQueryWords,
    maxSubQueries: config.multiHop.maxSubQueries,
    maxSupplemental: config.multiHop.maxSupplemental,
    // Defensive clamp — a bad config value must not blow past the [0,1]
    // wire score contract via an un-damped or negative supplemental score.
    supplementalWeight: Math.min(1, Math.max(0, config.multiHop.supplementalWeight)),
    timeoutMs: config.multiHop.timeoutMs,
  };
}

class DecomposeTimeoutError extends Error {}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new DecomposeTimeoutError(`query decomposition timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/**
 * Cheap, network-free gate (AC-4): a query shorter than `minQueryWords`
 * never reaches the decomposer. Exported so search.ts and tests can reason
 * about the gate without duplicating the word-count logic.
 */
export function needsDecomposition(query: string, minQueryWords: number): boolean {
  const words = query.trim().split(/\s+/).filter(Boolean);
  return words.length >= minQueryWords;
}

/**
 * Run the decompose stage for one query: the cheap-skip gate, then the
 * decomposer call under a hard timeout, then de-dup/cap. Returns `[]`
 * (never throws) on a short-circuited query, a timeout, a provider error,
 * or fewer than 2 usable sub-queries — every one of those cases means
 * "search.ts should treat this call exactly like single-pass search",
 * which is the fallback contract this stage promises (degrades quality,
 * never availability — same posture as rerank.ts).
 */
export async function getSubQueries(query: string, opts: DecomposeOpts): Promise<string[]> {
  if (!needsDecomposition(query, opts.minQueryWords)) return [];

  const log = childLogger({ stage: 'decompose', provider: opts.decomposer.name });
  const t0 = Date.now();
  try {
    const raw = await withTimeout(opts.decomposer.decompose(query), opts.timeoutMs);
    // De-dup (case-insensitive) and drop anything identical to the original
    // query — a decomposer that echoes the input back adds gather/fuse cost
    // for zero new candidates.
    const seen = new Set<string>([query.trim().toLowerCase()]);
    const cleaned: string[] = [];
    for (const sq of raw) {
      const key = sq.trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      cleaned.push(sq.trim());
      if (cleaned.length >= opts.maxSubQueries) break;
    }
    log.info({ outcome: 'ok', latency_ms: Date.now() - t0, subQueries: cleaned.length }, 'decompose stage complete');
    return cleaned;
  } catch (err) {
    const outcome = err instanceof DecomposeTimeoutError ? 'timeout' : 'error';
    log.warn(
      { outcome, latency_ms: Date.now() - t0, error_message: err instanceof Error ? err.message : String(err) },
      'decompose stage fallback to single-pass',
    );
    return [];
  }
}
