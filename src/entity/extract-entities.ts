/**
 * Entity-only LLM extraction (FEAT-402 AC-7) — used by the `entity-backfill`
 * command to extract entities from ALREADY-DISTILLED memory text, without
 * re-running the full 8-stage distill pipeline (no re-chunking, no atom
 * re-extraction, memory text and hash untouched). Distill-time extraction
 * (stage 5, src/distill/stages/05-extract.ts) instead emits entities inline
 * on each atom in the SAME LLM call — this module exists only for the
 * backfill's one-shot pass over pre-existing rows that predate that stage.
 *
 * Deliberately lenient: unlike stage 5's extractChunk (which throws
 * DeterministicError on parse failure and poisons the job), a bad response
 * here just returns [] and lets the caller log + move on. The corpus is
 * scanned by "not yet linked" (src/entity/backfill.ts), so a memory that got
 * an empty/failed extraction this run remains a valid candidate on the next
 * run — the backfill is naturally resumable without a checkpoint table.
 */

import { z } from 'zod';
import type { LLMProvider } from '../contracts/index.js';
import { AtomEntitySchema, type AtomEntity } from '../distill/prompts/extract.js';
import { BudgetTracker } from '../budget/tracker.js';

const LenientEntitiesSchema = z.object({ entities: z.array(z.unknown()) });

export const ENTITY_ONLY_SYSTEM_PROMPT = `You identify named things mentioned in a short piece of durable knowledge extracted from an AI coding agent transcript.

Output STRICT JSON matching:
{
  "entities": [
    { "name": "<named thing mentioned>", "kind": "product" | "tech" | "person" | "org" | "repo" | "concept" }
  ]
}

kind is one of:
- product: a named product or app (e.g. "AstraMemory", "GitHub Copilot")
- tech: a language/framework/library/tool/protocol (e.g. "Postgres", "TypeScript", "sqlite-vec")
- person: a named individual
- org: a company or organization
- repo: a named git repository or codebase
- concept: a named pattern, architecture, or idea (e.g. "bitemporal model", "CRDT")

List every specific named thing the text is ABOUT — not every word. If nothing specific is named, return {"entities": []}.`;

/**
 * Extract entities from one piece of already-distilled memory text.
 * Returns [] (never throws) on budget-exceeded, transport, or parse failure
 * — callers decide whether/how to surface that (the backfill CLI counts it
 * as "skipped", not "failed").
 */
export async function extractEntitiesForText(
  text: string,
  provider: LLMProvider,
  budget: BudgetTracker,
  capUsd: number,
): Promise<AtomEntity[]> {
  if (!text.trim()) return [];

  const promptChars = ENTITY_ONLY_SYSTEM_PROMPT.length + text.length;
  const estimateUsd = BudgetTracker.estimateUsd(promptChars, 0.000002, 0.000002);
  if (!budget.canSpend(estimateUsd, capUsd)) return [];

  let raw: string;
  let usageUsd: number;
  try {
    const result = await provider.chat(
      [
        { role: 'system', content: ENTITY_ONLY_SYSTEM_PROMPT },
        { role: 'user', content: `Identify entities in this text:\n\n${text}` },
      ],
      { temperature: 0.1, json: true, maxTokens: 400 },
    );
    raw = result.text;
    usageUsd = result.usage.usd;
  } catch {
    return [];
  }

  budget.record(usageUsd);
  return tryParseEntities(raw);
}

function tryParseEntities(raw: string): AtomEntity[] {
  try {
    let text = raw.trim();
    text = text.replace(/^```(?:json)?\n?/i, '').replace(/\n?```\s*$/i, '').trim();

    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end === -1) return [];

    const parsed: unknown = JSON.parse(text.slice(start, end + 1));
    const wrapper = LenientEntitiesSchema.safeParse(parsed);
    if (!wrapper.success) return [];

    return wrapper.data.entities.filter((e) => AtomEntitySchema.safeParse(e).success) as AtomEntity[];
  } catch {
    return [];
  }
}
