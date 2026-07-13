/**
 * Stage 4 — Compact (LLM call per chunk)
 *
 * Removes redundancy, repeated thinking, false starts from each chunk.
 * Preserves decisions, file paths, commands, errors, rationale.
 *
 * Budget: checks cap before each call, records after.
 * Throws BudgetExceeded if over cap (caller moves job to paused).
 */

import type { LLMProvider, ChatMsg } from '../../contracts/index.js';
import type { Chunk } from './03-chunk.js';
import { BudgetTracker, BudgetExceeded } from '../../budget/tracker.js';
import { mapWithConcurrency } from '../concurrency.js';
import { chunkCheckpoints } from '../chunk-checkpoint.js';

export { BudgetExceeded };

const COMPACT_SYSTEM = `You are a transcript compressor for AI coding agent sessions.

Compress the provided transcript chunk. Remove:
- Repeated or near-identical lines
- Thinking-out-loud that reaches no conclusion
- False starts and self-corrections that don't change the outcome
- Generic acknowledgment phrases ("Sure!", "Of course!", "I'll help you with that")

PRESERVE:
- All decisions and chosen approaches
- All file paths and commands
- All error messages, stderr output, and permission errors from failed tool
  calls — EVEN IF the failure was never resolved or explained. An unresolved
  failure is still durable knowledge; do not drop it for lack of a fix.
- All error messages and their resolutions
- All rationale and architectural reasoning
- All TODO items and pending work
- Named tools, version numbers, and other named entities (products, repos,
  people, orgs) — keep them verbatim, don't paraphrase away a specific name
  or number

If the chunk covers multiple distinct topics, keep at least one line per
topic — do not compress a multi-topic chunk down to only its most prominent
topic.

Output plain text only. No markdown formatting. No commentary.`;

export interface CompactResult {
  index: number;
  text: string;
  usageUsd: number;
}

/**
 * Compact a single chunk via LLM.
 * Returns the compressed text and actual USD cost.
 */
export async function compactChunk(
  chk: Chunk,
  provider: LLMProvider,
  budget: BudgetTracker,
  capUsd: number,
): Promise<CompactResult> {
  if (!chk.text.trim()) {
    return { index: chk.index, text: '', usageUsd: 0 };
  }

  const messages: ChatMsg[] = [
    { role: 'system', content: COMPACT_SYSTEM },
    { role: 'user', content: chk.text },
  ];

  // Estimate cost: prompt = system + user text chars
  const promptChars = COMPACT_SYSTEM.length + chk.text.length;
  // For Ollama providers, usd=0 always — use a negligible estimate to pass budget check
  // For Azure, pricing is handled after the call via usage.usd
  const estimateUsd = BudgetTracker.estimateUsd(promptChars, 0.000002, 0.000002);

  budget.assertCanSpend(estimateUsd, capUsd);

  const result = await provider.chat(messages, {
    temperature: 0.1,
    maxTokens: 2000,
  });

  // Record actual cost (0 for Ollama, real for Azure)
  budget.record(result.usage.usd);

  return {
    index: chk.index,
    text: result.text.trim(),
    usageUsd: result.usage.usd,
  };
}

/**
 * Compact all chunks, up to `concurrency` at a time (FEAT-487).
 *
 * Stops dispatching further chunks at the first BudgetExceeded (or any other
 * error) — caller catches and pauses job. Results stay in chunk-index order
 * regardless of completion order. See src/distill/concurrency.ts for the
 * full invariant contract `mapWithConcurrency` provides.
 *
 * `concurrency` defaults to 1 — BYTE-IDENTICAL to the pre-FEAT-487
 * sequential `for…of await` loop this replaces. Production callers resolve
 * the real value from config via `resolveChunkConcurrency`
 * (src/distill/pipeline.ts).
 *
 * `jobKey` (chunk-retry-amplification fix) opts into per-chunk
 * checkpointing: chunks whose result is already cached under `jobKey` (from
 * an earlier call — i.e. a worker-level job retry re-invoking compact() from
 * scratch) are skipped entirely rather than re-dispatched, and every fresh
 * success is cached before compact() returns. Omitted (the default), this
 * function is byte-identical to its pre-fix behavior — no cache lookup, no
 * cache write, every call re-dispatches every chunk. Production callers pass
 * `ctx.sourceHash` (see pipeline.ts) — stable across retries of the same job
 * because it's derived from transcript content, not a per-attempt id.
 */
export async function compact(
  chunks: Chunk[],
  provider: LLMProvider,
  budget: BudgetTracker,
  capUsd: number,
  concurrency = 1,
  jobKey?: string,
): Promise<CompactResult[]> {
  if (!jobKey) {
    return mapWithConcurrency(chunks, concurrency, (chk) => compactChunk(chk, provider, budget, capUsd));
  }

  const pending: Chunk[] = [];
  const cached: CompactResult[] = [];
  for (const chk of chunks) {
    const hit = chunkCheckpoints.get<CompactResult>(jobKey, 'compact', chk.index);
    if (hit !== undefined) cached.push(hit);
    else pending.push(chk);
  }

  const fresh = await mapWithConcurrency(pending, concurrency, async (chk) => {
    const result = await compactChunk(chk, provider, budget, capUsd);
    chunkCheckpoints.set(jobKey, 'compact', chk.index, result);
    return result;
  });

  return [...cached, ...fresh].sort((a, b) => a.index - b.index);
}
