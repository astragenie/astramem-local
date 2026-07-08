/**
 * LLM-judge scoring — Azure gpt-5-mini (reasoning_effort minimal), reusing
 * scripts/eval/longmemeval/lib/azure-client.ts + lib/config.ts rather than
 * re-deriving an Azure client. One judge call per (model, fixture) pair:
 * given the gold atom list and the model's extracted atoms, the judge
 * performs SEMANTIC matching (not string equality — paraphrases count) and
 * classifies every extracted atom, so recall/precision/junk-rate/type-
 * accuracy can all be computed from one response.
 */
import { azureChatComplete } from '../../longmemeval/lib/azure-client.js';
import type { AzureConfig } from '../../longmemeval/lib/config.js';
import type { GoldAtom } from './fixtures.js';

export interface JudgeAtomIn {
  type: string;
  text: string;
}

export type ExtractedVerdict = 'matches_gold' | 'reasonable_extra' | 'junk';

export interface ExtractedVerdictEntry {
  index: number;
  verdict: ExtractedVerdict;
  matched_gold_index: number | null;
  type_correct: boolean | null;
  reason: string;
}

export interface JudgeResult {
  extracted_verdicts: ExtractedVerdictEntry[];
  unmatched_gold_indices: number[];
}

export interface FixtureScore {
  fixtureId: string;
  goldCount: number;
  extractedCount: number;
  recall: number | null;
  precision: number | null;
  junkRate: number | null;
  typeAccuracy: number | null;
  overExtractionCount: number | null; // only meaningful when goldCount === 0
  judge: JudgeResult;
}

const JUDGE_SYSTEM_PROMPT = `You are grading a knowledge-extraction system for AI coding-agent transcripts.

You will be given:
1. GOLD ATOMS — the durable facts/decisions/lessons/commands/todos/notes/events a perfect extractor should have produced from a transcript.
2. EXTRACTED ATOMS — what a candidate extractor actually produced from the same transcript.

For EACH extracted atom, classify it as exactly one of:
- "matches_gold": it captures the same durable content as one specific gold atom (semantic match — paraphrasing, reordering, or different wording is fine; it does not need to match verbatim). Set matched_gold_index to that gold atom's index and type_correct to whether the extracted atom's "type" field equals that gold atom's "type".
- "reasonable_extra": genuinely useful, non-trivial, non-hallucinated durable knowledge that isn't covered by any gold atom (the gold list is not claimed to be 100% exhaustive). matched_gold_index null, type_correct null.
- "junk": trivial, redundant, hallucinated (not actually supported by the transcript), or a raw secret/credential/token that should never have been extracted verbatim (per the extraction system's own rule to skip secrets). matched_gold_index null, type_correct null.

Each gold atom may be matched by AT MOST ONE extracted atom (pick the best match if multiple extracted atoms are plausible; the rest are reasonable_extra or junk as appropriate — do not double-count).

Then list unmatched_gold_indices: gold atom indices that NO extracted atom matched (missed recall).

Output STRICT JSON only, no markdown, no commentary:
{
  "extracted_verdicts": [{"index": 0, "verdict": "matches_gold", "matched_gold_index": 2, "type_correct": true, "reason": "<one short sentence>"}, ...],
  "unmatched_gold_indices": [1, 3]
}
If there are zero extracted atoms, extracted_verdicts must be [] and unmatched_gold_indices must list every gold index.`;

function buildUserPrompt(goldAtoms: GoldAtom[], extracted: JudgeAtomIn[]): string {
  const goldBlock = goldAtoms.length
    ? goldAtoms.map((a, i) => `[${i}] (${a.type}) ${a.text}`).join('\n')
    : '(none — this transcript has nothing worth remembering; any extracted atom is an over-extraction)';
  const extractedBlock = extracted.length
    ? extracted.map((a, i) => `[${i}] (${a.type}) ${a.text}`).join('\n')
    : '(none extracted)';
  return `GOLD ATOMS:\n${goldBlock}\n\nEXTRACTED ATOMS:\n${extractedBlock}`;
}

/**
 * Tolerant parse: gpt-5-mini occasionally emits a close-but-not-exact key
 * name (observed live: "extracted_verds" instead of "extracted_verdicts").
 * Rather than hard-failing the whole benchmark run on that kind of harmless
 * variance (an earlier version did exactly that and crashed a 4-model run
 * partway through, losing already-computed scores for prior models), accept
 * a small set of known aliases and default a missing unmatched-indices array
 * to empty rather than rejecting the whole response.
 */
function tryParseJudge(raw: string): JudgeResult | null {
  try {
    let text = raw.trim();
    text = text.replace(/^```(?:json)?\n?/i, '').replace(/\n?```\s*$/i, '').trim();
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end === -1) return null;
    const parsed = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;

    const verdictsRaw = parsed['extracted_verdicts'] ?? parsed['extracted_verds'] ?? parsed['verdicts'];
    const unmatchedRaw = parsed['unmatched_gold_indices'] ?? parsed['unmatched_gold'] ?? parsed['unmatched'] ?? [];
    if (!Array.isArray(verdictsRaw) || !Array.isArray(unmatchedRaw)) return null;
    return { extracted_verdicts: verdictsRaw as ExtractedVerdictEntry[], unmatched_gold_indices: unmatchedRaw as number[] };
  } catch {
    return null;
  }
}

export async function judgeFixture(
  cfg: AzureConfig,
  fixtureId: string,
  goldAtoms: GoldAtom[],
  extracted: JudgeAtomIn[],
): Promise<FixtureScore> {
  // Fast path: nothing gold, nothing extracted — a perfect score, no LLM call needed (saves spend).
  if (goldAtoms.length === 0 && extracted.length === 0) {
    return {
      fixtureId, goldCount: 0, extractedCount: 0,
      recall: null, precision: null, junkRate: 0, typeAccuracy: null, overExtractionCount: 0,
      judge: { extracted_verdicts: [], unmatched_gold_indices: [] },
    };
  }

  const messages = [
    { role: 'system' as const, content: JUDGE_SYSTEM_PROMPT },
    { role: 'user' as const, content: buildUserPrompt(goldAtoms, extracted) },
  ];
  const raw = await azureChatComplete(cfg, { messages, maxCompletionTokens: 2000, reasoningEffort: 'minimal', deployment: cfg.answererDeployment });

  let parsed = tryParseJudge(raw);
  if (!parsed) {
    // One retry with a stricter follow-up, mirroring 05-extract.ts's
    // parse-failure retry — an LLM judge occasionally wraps JSON in prose or
    // uses an off-schema key; a single retry recovers most of these without
    // taking down the whole benchmark run over one flaky response.
    const retryRaw = await azureChatComplete(cfg, {
      messages: [...messages, { role: 'assistant' as const, content: raw }, { role: 'user' as const, content: 'That was not valid JSON matching the required schema. Reply with ONLY the JSON object — no prose, no markdown fences.' }],
      maxCompletionTokens: 2000,
      reasoningEffort: 'minimal',
      deployment: cfg.answererDeployment,
    });
    parsed = tryParseJudge(retryRaw);
  }
  if (!parsed) {
    throw new Error(`judge response for fixture ${fixtureId} did not parse as JSON after retry — raw: ${raw.slice(0, 300)}`);
  }

  const matches = parsed.extracted_verdicts.filter(v => v.verdict === 'matches_gold');
  const junk = parsed.extracted_verdicts.filter(v => v.verdict === 'junk');
  const goldMatchedCount = goldAtoms.length - parsed.unmatched_gold_indices.length;

  const recall = goldAtoms.length > 0 ? goldMatchedCount / goldAtoms.length : null;
  const precision = extracted.length > 0 ? (extracted.length - junk.length) / extracted.length : (goldAtoms.length === 0 ? null : null);
  const junkRate = extracted.length > 0 ? junk.length / extracted.length : 0;
  const typeCorrectCount = matches.filter(m => m.type_correct === true).length;
  const typeAccuracy = matches.length > 0 ? typeCorrectCount / matches.length : null;
  const overExtractionCount = goldAtoms.length === 0 ? extracted.length : null;

  return {
    fixtureId,
    goldCount: goldAtoms.length,
    extractedCount: extracted.length,
    recall,
    precision,
    junkRate,
    typeAccuracy,
    overExtractionCount,
    judge: parsed,
  };
}
