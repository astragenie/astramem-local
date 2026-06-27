/**
 * Stage 5 — Extract (LLM JSON-mode per chunk)
 *
 * Emits typed atoms {type, text, importance, confidence, evidence}.
 * Zod-validates the JSON response. Retries once with a stricter prompt
 * on parse failure. Throws BudgetExceeded if over cap.
 */

import type { LLMProvider, ChatMsg } from '../../contracts/index.js';
import {
  AtomSchema,
  ExtractionSchema,
  EXTRACTION_SYSTEM_PROMPT,
  EXTRACTION_STRICT_PROMPT,
  type Atom,
} from '../prompts/extract.js';
import { BudgetTracker, BudgetExceeded } from '../../budget/tracker.js';

export { BudgetExceeded };
export type { Atom };

export interface ExtractResult {
  chunkIndex: number;
  atoms: Atom[];
  usageUsd: number;
  retried: boolean;
}

/**
 * Extract atoms from a single compacted chunk.
 * On JSON parse / Zod validation failure: retries once with stricter prompt.
 * If retry also fails: returns empty atoms (not a fatal error — log and continue).
 */
export async function extractChunk(
  chunkIndex: number,
  text: string,
  provider: LLMProvider,
  budget: BudgetTracker,
  capUsd: number,
): Promise<ExtractResult> {
  if (!text.trim()) {
    return { chunkIndex, atoms: [], usageUsd: 0, retried: false };
  }

  const promptChars = EXTRACTION_SYSTEM_PROMPT.length + text.length;
  const estimateUsd = BudgetTracker.estimateUsd(promptChars, 0.000002, 0.000002);

  budget.assertCanSpend(estimateUsd, capUsd);

  // First attempt
  const firstResult = await callExtract(text, EXTRACTION_SYSTEM_PROMPT, provider);
  budget.record(firstResult.usageUsd);

  const firstParsed = tryParseAtoms(firstResult.text);
  if (firstParsed !== null) {
    return { chunkIndex, atoms: firstParsed, usageUsd: firstResult.usageUsd, retried: false };
  }

  // Retry with stricter prompt
  const retryEstimate = BudgetTracker.estimateUsd(
    EXTRACTION_STRICT_PROMPT.length + text.length,
    0.000002,
    0.000002,
  );
  budget.assertCanSpend(retryEstimate, capUsd);

  const retryResult = await callExtract(text, EXTRACTION_STRICT_PROMPT, provider);
  budget.record(retryResult.usageUsd);

  const retryParsed = tryParseAtoms(retryResult.text);
  const totalUsd = firstResult.usageUsd + retryResult.usageUsd;

  if (retryParsed !== null) {
    return { chunkIndex, atoms: retryParsed, usageUsd: totalUsd, retried: true };
  }

  // Both attempts failed — log and return empty (not fatal)
  console.warn(
    `[extract] chunk ${chunkIndex}: parse failed after retry — yielding 0 atoms. Raw: ${retryResult.text.slice(0, 200)}`,
  );
  return { chunkIndex, atoms: [], usageUsd: totalUsd, retried: true };
}

async function callExtract(
  text: string,
  systemPrompt: string,
  provider: LLMProvider,
): Promise<{ text: string; usageUsd: number }> {
  const messages: ChatMsg[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `Extract knowledge atoms from this transcript chunk:\n\n${text}` },
  ];

  const result = await provider.chat(messages, {
    temperature: 0.1,
    json: true,
    maxTokens: 1500,
  });

  return { text: result.text, usageUsd: result.usage.usd };
}

/**
 * Try to parse the LLM response as ExtractionSchema.
 * Strips markdown fences if present.
 * Returns null on any parse failure.
 */
function tryParseAtoms(raw: string): Atom[] | null {
  try {
    let text = raw.trim();

    // Strip markdown code fences
    text = text.replace(/^```(?:json)?\n?/i, '').replace(/\n?```\s*$/i, '').trim();

    // Find the outermost JSON object
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end === -1) return null;

    const jsonStr = text.slice(start, end + 1);
    const parsed: unknown = JSON.parse(jsonStr);
    const validated = ExtractionSchema.safeParse(parsed);

    if (!validated.success) return null;

    // Filter atoms that pass AtomSchema individually (belt-and-suspenders)
    return validated.data.atoms.filter(a => AtomSchema.safeParse(a).success);
  } catch {
    return null;
  }
}

/**
 * Extract atoms from all compacted chunks.
 * Stops at first BudgetExceeded.
 */
export async function extract(
  chunks: Array<{ index: number; text: string }>,
  provider: LLMProvider,
  budget: BudgetTracker,
  capUsd: number,
): Promise<ExtractResult[]> {
  const results: ExtractResult[] = [];
  for (const chk of chunks) {
    results.push(await extractChunk(chk.index, chk.text, provider, budget, capUsd));
  }
  return results;
}
