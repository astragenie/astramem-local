/**
 * Bounded-concurrency map for the distill chunk-level LLM fan-out
 * (FEAT-487 — 04-compact.ts / 05-extract.ts). Hand-rolled — no dependency
 * (p-limit et al) for something this small.
 *
 * INVARIANTS (see 04-compact.ts / 05-extract.ts callers for how these map
 * onto the budget-gated chunk loop):
 *
 * 1. Concurrency ceiling: at most `limit` calls to `fn` are ever in flight
 *    simultaneously. `limit=1` degenerates to a single worker draining
 *    items 0..n-1 strictly in order, one at a time — BYTE-IDENTICAL to the
 *    pre-FEAT-487 sequential `for…of await` loop this replaces.
 *
 * 2. Result order: the returned array is indexed by INPUT position, not
 *    completion order — callers (compact()/extract()) index results by
 *    chunk index, so a chunk that finishes late must not shift its
 *    neighbors.
 *
 * 3. Stop-on-error dispatch: as soon as any `fn` call rejects, no NEW item
 *    is dispatched — a worker checks the stop flag before claiming its next
 *    index. Already-dispatched (in-flight) calls are NOT cancelled (a
 *    started Promise can't be un-started) and are allowed to settle.
 *    This is what turns "the loop stops at the first BudgetExceeded" from a
 *    sequential-loop accident into a concurrency-safe guarantee: once a
 *    chunk's own `budget.assertCanSpend` throws, the remaining chunks in
 *    the queue never get a chance to also check-and-maybe-pass against a
 *    stale (not-yet-recorded) budget total.
 *
 *    KNOWN COMPROMISE (documented, not fixed here — see FEAT-487 handoff):
 *    the check-then-record budget sequence still lives inside
 *    compactChunk()/extractChunk() themselves (out of scope for this helper
 *    to touch), so up to `limit - 1` chunks already in flight when the
 *    FIRST BudgetExceeded fires may have passed their own budget check
 *    against a stale total and go on to actually spend. Worst-case overspend
 *    is bounded by `(limit - 1)` chunk-estimates, not by the full remaining
 *    queue like a naive `Promise.all` — and at the default limit of 2, that
 *    bound is a single chunk's estimate. Eliminating the race entirely would
 *    need an in-memory spend reservation inside compactChunk/extractChunk,
 *    which is out of this slice's scope.
 *
 * 4. Error propagation: the exact error instance that caused the stop is
 *    rethrown as-is once every in-flight call has settled — never wrapped in
 *    an AggregateError. If multiple calls reject, whichever settles first
 *    (temporally) wins; for limit=1 that is always the same chunk the
 *    sequential loop would have thrown on.
 */
import type { Config } from '../config/config.js';

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  let stopped = false;
  let hasError = false;
  let firstError: unknown;

  async function worker(): Promise<void> {
    for (;;) {
      if (stopped) return;
      const idx = next++;
      if (idx >= items.length) return;
      try {
        results[idx] = await fn(items[idx] as T, idx);
      } catch (err) {
        if (!hasError) {
          hasError = true;
          firstError = err;
        }
        stopped = true;
        return;
      }
    }
  }

  const workerCount = Math.max(1, Math.min(limit, items.length || 1));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  if (hasError) throw firstError;
  return results;
}

/** Hard bounds for `config.distill.chunkConcurrency`, mirroring
 *  `resolveWorkerConcurrency`'s [1,8] clamp for `config.pipeline.concurrency`
 *  (src/pipeline/worker.ts) — a bad/hand-edited config value must never
 *  block daemon boot or unboundedly hammer Ollama. */
const MIN_CHUNK_CONCURRENCY = 1;
const MAX_CHUNK_CONCURRENCY = 8;

/**
 * Resolve the chunk-level fan-out width from config, clamped to
 * [MIN_CHUNK_CONCURRENCY, MAX_CHUNK_CONCURRENCY]. Non-finite/non-positive/
 * non-numeric values fall back to 1 (the safe, byte-identical-to-sequential
 * default) rather than throwing — a malformed config must never block a
 * pipeline run.
 *
 * Setting `distill.chunkConcurrency: 1` is the documented safety valve: it
 * reproduces the pre-FEAT-487 sequential compact()/extract() behavior
 * exactly (see mapWithConcurrency's limit=1 case above).
 */
export function resolveChunkConcurrency(config: Config): number {
  const raw = config.distill?.chunkConcurrency;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return MIN_CHUNK_CONCURRENCY;
  const truncated = Math.trunc(raw);
  return Math.min(MAX_CHUNK_CONCURRENCY, Math.max(MIN_CHUNK_CONCURRENCY, truncated || MIN_CHUNK_CONCURRENCY));
}
