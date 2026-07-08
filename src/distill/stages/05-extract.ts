/**
 * Stage 5 — Extract (LLM JSON-mode per chunk)
 *
 * Emits typed atoms {type, text, importance, confidence, evidence}.
 * Zod-validates the JSON response. A parse/validation failure throws
 * TransientError — LLM JSON output is stochastic, so the worker retries
 * (with backoff, up to its normal attempt cap) before poisoning the job,
 * rather than dropping a whole session's memories on one bad sample.
 * Throws BudgetExceeded if over cap.
 */

import { z } from 'zod';
import type { LLMProvider, ChatMsg } from '../../contracts/index.js';
import {
  AtomSchema,
  EXTRACTION_SYSTEM_PROMPT,
  type Atom,
} from '../prompts/extract.js';
import { BudgetTracker, BudgetExceeded } from '../../budget/tracker.js';
import { TransientError } from '../../pipeline/errors.js';

/**
 * Lenient wrapper: accepts any objects in the atoms array so that individual
 * bad atoms (short text, unknown type, etc.) don't reject the whole response.
 * Valid atoms are filtered with AtomSchema after JSON parsing.
 */
const LenientExtractionSchema = z.object({ atoms: z.array(z.unknown()) });

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
 *
 * Parse / Zod validation failure → throws TransientError. The worker
 * classifies this as transient and retries (with backoff) up to its normal
 * attempt cap before poisoning the job — LLM JSON output is stochastic (the
 * same chunk can parse cleanly on the very next call), so a single flaky
 * sample must not permanently drop a session's memories.
 *
 * Follow-up (not yet wired): EXTRACTION_STRICT_PROMPT already exists as a
 * stricter variant, but no attempt number is threaded from the worker's
 * retry count down into this function, so retries currently reuse the base
 * prompt rather than escalating to it.
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

  const result = await callExtract(text, EXTRACTION_SYSTEM_PROMPT, provider);
  budget.record(result.usageUsd);

  const parsed = tryParseAtoms(result.text);
  if (parsed !== null) {
    return { chunkIndex, atoms: parsed, usageUsd: result.usageUsd, retried: false };
  }

  // Parse / schema failure — LLM JSON output is stochastic, so treat it as
  // transient and let the worker retry (up to its attempt cap) instead of
  // poisoning on a single bad sample.
  throw new TransientError(
    `[extract] chunk ${chunkIndex}: Zod/JSON parse failed — raw: ${result.text.slice(0, 200)}`,
  );
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
 * Try to parse the LLM response into an Atom[].
 * Strips markdown fences if present.
 *
 * Returns an Atom[] (possibly empty) when the JSON is structurally valid and
 * contains an `atoms` array — even if individual atoms are malformed (they
 * are silently dropped via AtomSchema filtering).
 *
 * Returns null only when the raw text is not parseable JSON or is missing the
 * top-level `atoms` key — this is the signal for a TransientError (see
 * extractChunk above).
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

    // Use the lenient schema — only requires `atoms` to be an array
    const wrapper = LenientExtractionSchema.safeParse(parsed);
    if (!wrapper.success) return null;

    // Filter atoms individually: drop those that fail strict AtomSchema
    // (short text, unknown type, out-of-range numbers, etc.)
    return wrapper.data.atoms.filter((a) => AtomSchema.safeParse(a).success) as Atom[];
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
