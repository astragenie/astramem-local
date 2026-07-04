/**
 * Tier-2 "prompt-assisted" inference (FEAT-403 AC-4).
 *
 * Runs only when tier-1 (session cwd/project_id, see derive-repo.ts +
 * backfill.ts) found nothing to derive from. Grounded ONLY in the
 * (repo, project) vocabulary already present elsewhere in the tagged
 * corpus — the model is told to pick among known pairs or return null, never
 * to invent a new name from thin air. Any parse failure, empty vocabulary,
 * or provider error resolves to confidence 0 so the caller (backfill.ts)
 * leaves the memory untagged rather than risk a mis-tag.
 */

import { z } from 'zod';
import type { LLMProvider, ChatMsg } from '../contracts/index.js';

export interface TagCandidatePair {
  repo: string | null;
  project: string | null;
}

export interface Tier2InferResult {
  repo: string | null;
  project: string | null;
  confidence: number;
}

export type Tier2InferFn = (
  memoryText: string,
  knownPairs: TagCandidatePair[],
) => Promise<Tier2InferResult>;

const Tier2ResponseSchema = z.object({
  repo: z.string().nullable().optional(),
  project: z.string().nullable().optional(),
  confidence: z.number().min(0).max(1),
});

const TIER2_SYSTEM_PROMPT = `You infer which repository/project a memory (fact, decision, or lesson) belongs to. You will be given a list of already-known repo/project pairs seen elsewhere in this corpus, and the memory's text. Pick ONE known pair if the text gives clear evidence, or return null for both fields if there is no clear signal — never invent a new repo/project name. Respond with strict JSON only: {"repo": string|null, "project": string|null, "confidence": number between 0 and 1}. confidence reflects how certain you are the memory belongs to the chosen pair; use a low confidence (< 0.5) when unsure.`;

/**
 * Default tier-2 inference, backed by an injected LLMProvider (reuse the
 * existing provider abstraction — src/contracts/llm.ts, src/providers/index.ts
 * — rather than a bespoke HTTP call).
 */
export function makeLlmTier2Infer(llm: LLMProvider): Tier2InferFn {
  return async (memoryText, knownPairs) => {
    if (knownPairs.length === 0) {
      // No known vocabulary to ground a guess in — never invent from thin air.
      return { repo: null, project: null, confidence: 0 };
    }

    const pairsList = knownPairs
      .map(p => `- repo=${p.repo ?? 'null'} project=${p.project ?? 'null'}`)
      .join('\n');
    const messages: ChatMsg[] = [
      { role: 'system', content: TIER2_SYSTEM_PROMPT },
      {
        role: 'user',
        content: `Known repo/project pairs seen in this corpus:\n${pairsList}\n\nMemory text:\n${memoryText}\n\nWhich pair (if any) does this memory belong to?`,
      },
    ];

    try {
      const result = await llm.chat(messages, { temperature: 0, json: true, maxTokens: 200 });
      return parseTier2Response(result.text) ?? { repo: null, project: null, confidence: 0 };
    } catch {
      return { repo: null, project: null, confidence: 0 };
    }
  };
}

/** Parse the LLM's JSON response, stripping markdown fences if present. */
function parseTier2Response(raw: string): Tier2InferResult | null {
  try {
    let text = raw.trim();
    text = text.replace(/^```(?:json)?\n?/i, '').replace(/\n?```\s*$/i, '').trim();

    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end === -1) return null;

    const parsedJson: unknown = JSON.parse(text.slice(start, end + 1));
    const validated = Tier2ResponseSchema.safeParse(parsedJson);
    if (!validated.success) return null;

    return {
      repo: validated.data.repo ?? null,
      project: validated.data.project ?? null,
      confidence: validated.data.confidence,
    };
  } catch {
    return null;
  }
}
