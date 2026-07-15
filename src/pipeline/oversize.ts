/**
 * FEAT-507 — shared oversize-atom constants/helpers.
 *
 * `reembed` jobs were poisoning at a steady rate in production (~16/hr,
 * observed 2026-07-15): every failure was `Ollama embed failed: HTTP 500 —
 * {"error":"the input length exceeds the context length"}` after 3 retry
 * attempts. The content exceeds the embed model's context window, so the
 * failure is deterministic — retrying is pure waste, and the memory
 * permanently poisons instead of ever getting an embedding.
 *
 * This module is the single source of truth for "oversize" — both
 * `handlers/reembed.ts` (truncate-before-embed + reclassify) and
 * `oversize-scanner.ts` (find already-poisoned candidates) import from here
 * rather than each carrying its own threshold, per FEAT-507's requirement
 * that "oversize" be defined from one explicit, named constant.
 */

import { DeterministicError } from './errors.js';

/**
 * mxbai-embed-large-v1's native max sequence length is 512 tokens
 * (BERT-based encoder — mixedbread-ai/mxbai-embed-large-v1 model card).
 * Ollama's `/api/embeddings` endpoint has no per-call context-sizing knob
 * the way its `/api/chat` endpoint's `num_ctx` does (see
 * providers/llm/ollama.ts) — this is a fixed property of the model, not
 * something that can be sized per request.
 *
 * KNOWN LIMITATION: this is tuned to the shipped default embed model, not
 * derived from the configured provider's actual capability. A differently
 * configured embed model with a larger window will be truncated more
 * aggressively than strictly necessary — safe (never corrupts data), just
 * not optimally tight. Making this provider-aware is a follow-up, not part
 * of this slice (embed provider internals are out of scope — see
 * `isContextLengthExceededError`'s doc comment below).
 */
const EMBED_CONTEXT_TOKENS = 512;

/**
 * Mirrors the `CHARS_PER_TOKEN` heuristic `providers/llm/ollama.ts` uses for
 * `num_ctx` sizing (~4 chars/token for English prose) — duplicated rather
 * than imported: that constant lives in the LLM chat provider layer, not the
 * embed provider layer, and is a one-line rough estimate, not a shared
 * contract (same reasoning `ollama.ts` itself gives for not importing
 * `distill/stages/03-chunk.ts`'s copy).
 */
const CHARS_PER_TOKEN = 4;

/**
 * The character budget `reembedHandler` truncates to before calling the
 * embed provider, and the threshold `oversize-scanner.ts` uses to find
 * already-poisoned candidates. 85% margin below the hard token ceiling — the
 * chars/4 estimate is rough, and truncating a little early is cheap; a
 * repeat "context length exceeded" 500 after "fixing" it is not.
 */
export const EMBED_MAX_INPUT_CHARS = Math.floor(EMBED_CONTEXT_TOKENS * CHARS_PER_TOKEN * 0.85);

/** True when `text` would exceed the embed context budget unmodified. */
export function isOversizeText(text: string): boolean {
  return text.length > EMBED_MAX_INPUT_CHARS;
}

/**
 * Truncate to the embed budget. This is the "cheap default" FEAT-507 AC-1
 * calls for — chunk-and-average was considered and explicitly deferred
 * pending retrieval-quality evidence (see FEAT-507 spec notes); a truncated
 * embedding beats a poisoned job with none.
 */
export function truncateForEmbedding(text: string): { text: string; truncated: boolean } {
  if (text.length <= EMBED_MAX_INPUT_CHARS) return { text, truncated: false };
  return { text: text.slice(0, EMBED_MAX_INPUT_CHARS), truncated: true };
}

/**
 * FEAT-507 AC-2: Ollama's embed endpoint returns a 500 with this exact
 * message shape when input exceeds the model's context window — matches the
 * observed production error verbatim ("the input length exceeds the context
 * length"). `OllamaEmbedProvider` (src/providers/embed/ollama.ts — out of
 * this slice's scope, owned by the ONNX-provider slice) classifies every
 * >=500 as `TransientError`, which is correct for a genuinely transient 500
 * but wrong for this deterministic one: no retry will ever make an oversize
 * input smaller. `reembedHandler` uses this to reclassify the failure
 * BEFORE it reaches the worker's retry router (`failure-classifier.ts`),
 * rather than editing the provider's own classification.
 */
export function isContextLengthExceededError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const m = err.message.toLowerCase();
  return m.includes('context length') || m.includes('input length exceeds');
}

/**
 * Wraps a single-text embed call so a deterministic context-length overflow
 * (see `isContextLengthExceededError`) is reclassified as `DeterministicError`
 * before it reaches the worker — every other failure (network, 429, a
 * genuinely transient 500) passes through unchanged.
 */
export async function embedWithOversizeGuard(
  text: string,
  embed: { embed(texts: string[]): Promise<Float32Array[]> },
  memoryId: string,
  originalLength: number,
): Promise<Float32Array[]> {
  try {
    return await embed.embed([text]);
  } catch (err) {
    if (isContextLengthExceededError(err)) {
      throw new DeterministicError(
        `Embed input still exceeds context budget after truncation to ${text.length} chars ` +
        `(memory ${memoryId}, original ${originalLength} chars): ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    }
    throw err;
  }
}
