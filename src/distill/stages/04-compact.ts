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
- All error messages and their resolutions
- All rationale and architectural reasoning
- All TODO items and pending work

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
 * Compact all chunks in sequence.
 * Stops at first BudgetExceeded — caller catches and pauses job.
 */
export async function compact(
  chunks: Chunk[],
  provider: LLMProvider,
  budget: BudgetTracker,
  capUsd: number,
): Promise<CompactResult[]> {
  const results: CompactResult[] = [];
  for (const chk of chunks) {
    results.push(await compactChunk(chk, provider, budget, capUsd));
  }
  return results;
}
