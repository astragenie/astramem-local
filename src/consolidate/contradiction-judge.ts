/**
 * FEAT-456 SLICE-1: contradiction judge — a single-pair LLM classification
 * call wired into the pairwise scan in consolidate.ts. Pure, side-effect-
 * free: this module never touches the DB, never persists anything; the
 * caller (consolidate.ts) owns what happens with the verdict.
 *
 * Reuses `ProviderSet.llm.extraction` (the same provider already used for
 * structured JSON extraction, stage 5) — no new `llm.judge` config surface
 * (design §1.3).
 */

import { z } from 'zod';
import type { LLMProvider } from '../contracts/llm.js';

/**
 * Stable marker embedded in the system prompt so mock-providers.ts's
 * MockLLMProvider can route judge calls to a dedicated deterministic branch
 * BEFORE the `opts.json === true` extraction check would otherwise
 * misclassify them (both the judge and extraction ask for `json: true`).
 * Single source of truth — imported by mock-providers.ts, not duplicated.
 */
export const CONTRADICTION_JUDGE_MARKER = 'astramem-contradiction-judge-v1';

export type JudgeVerdictLabel = 'agrees' | 'refines' | 'contradicts' | 'unrelated';

export interface JudgeVerdict {
  verdict: JudgeVerdictLabel;
  confidence: number;
}

const JudgeVerdictSchema = z.object({
  verdict: z.enum(['agrees', 'refines', 'contradicts', 'unrelated']),
  confidence: z.number().min(0).max(1),
});

const SYSTEM_PROMPT = `${CONTRADICTION_JUDGE_MARKER}. You are comparing two memory statements about the same
entity/topic to decide their relationship. Respond with a single JSON object:
{"verdict": "agrees"|"refines"|"contradicts"|"unrelated", "confidence": <0..1>}.
agrees = same fact, different wording. refines = B adds detail to A without conflicting.
contradicts = A and B cannot both be true as stated. unrelated = not actually about the
same fact despite similar wording.`;

/**
 * Never-fatal fallback: a parse failure or a thrown/rejected `chat()` call
 * is treated as `{ verdict: 'unrelated', confidence: 0 }` — matches the
 * "never block a run on a bad LLM response" pattern already used by
 * `estimateLlmJudgedJunk` (server/queries/memory-health-deep.ts) and the
 * config-value governance pattern in `resolveAutoAcceptThreshold`.
 */
const FALLBACK_VERDICT: JudgeVerdict = { verdict: 'unrelated', confidence: 0 };

export interface JudgeableAtom {
  text: string;
  created_at: number;
}

export async function judgeContradiction(
  llm: LLMProvider,
  a: JudgeableAtom,
  b: JudgeableAtom,
  opts: { log?: (message: string) => void } = {},
): Promise<JudgeVerdict> {
  const log = opts.log ?? ((message: string) => console.warn(message));
  try {
    const result = await llm.chat(
      [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: `Statement A (${a.created_at}): ${a.text}\nStatement B (${b.created_at}): ${b.text}`,
        },
      ],
      { temperature: 0, json: true },
    );
    const parsed = JudgeVerdictSchema.safeParse(JSON.parse(result.text));
    if (!parsed.success) {
      log(`[contradiction-judge] unparsable judge response — treating as unrelated: ${parsed.error.message}`);
      return FALLBACK_VERDICT;
    }
    return parsed.data;
  } catch (err) {
    log(
      `[contradiction-judge] judge call failed — treating as unrelated: ` +
      `${err instanceof Error ? err.message : String(err)}`,
    );
    return FALLBACK_VERDICT;
  }
}
