/**
 * Shared `Retry-After` header parsing for LLM providers (azure-openai,
 * openai-compatible, codex-subscription, ollama). RFC 9110 §10.2.3 allows
 * either a delta-seconds integer or an HTTP-date. Returns milliseconds, or
 * `undefined` when the header is absent/unparseable/non-positive — callers
 * fall back to their own fixed exponential backoff in that case (see
 * worker.ts).
 *
 * Found 2026-07-13 (chunk-retry-amplification fix): none of the 4 providers
 * ever read this header — worker.ts's retry delay was always a blind
 * 1s/2s/4s guess against an undocumented limit, even when the provider told
 * it exactly how long to wait.
 */

/** Defensive cap: an upstream server returning a pathological Retry-After
 *  value (bug, or a misbehaving self-hosted openai-compatible endpoint)
 *  must not be able to wedge a job's retry for an unbounded amount of time.
 *  Set generously above worker.ts's own 60s exponential-backoff ceiling
 *  since a real 429 Retry-After can legitimately exceed it. */
const MAX_RETRY_AFTER_MS = 5 * 60_000;

export function parseRetryAfterMs(header: string | null | undefined): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (trimmed === '') return undefined;

  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (!Number.isFinite(seconds) || seconds < 0) return undefined;
    return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  }

  const dateMs = Date.parse(trimmed);
  if (Number.isNaN(dateMs)) return undefined;
  const deltaMs = dateMs - Date.now();
  if (deltaMs <= 0) return undefined;
  return Math.min(deltaMs, MAX_RETRY_AFTER_MS);
}
