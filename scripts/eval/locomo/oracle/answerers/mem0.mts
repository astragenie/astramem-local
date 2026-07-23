/**
 * `mem0` — an `Answerer` that swaps our prompt for Mem0's VERBATIM
 * `ANSWER_PROMPT` (`docs/research/20260723-mem0-zep-locomo-harness-extraction.md`
 * §A1, sourced from `evaluation/prompts.py` @ `mem0ai/mem0` commit
 * `aae5989e78`), to test whether our ~35%-of-questions abstention rate on
 * even PERFECT evidence (gold-turns x current/strong) is a property of OUR
 * answer prompt or of the underlying evidence/model. Mem0's prompt commits
 * to a short answer instead of offering an abstention path at all — the
 * INSTRUCTIONS list has no "if you don't know, say so" clause, unlike our
 * own `buildAnswerPrompt` (`../../answer.mts`), which explicitly asks for
 * `"no information available"` when the notes are insufficient. Everything
 * else — hits, deployment tier, token budget, no-reasoning-effort — is held
 * IDENTICAL to `strong.mts` so the ONLY variable between `strong` and `mem0`
 * in a factorial run is the prompt.
 *
 * VERBATIM vs ADAPTED (read before touching the prompt text):
 * - INSTRUCTIONS (all 8) and APPROACH (all 7) numbered lists below are
 *   copied character-for-character from the source doc, including the
 *   "less than 5-6 words" cap and the step-by-step commit-to-answer
 *   framing — THAT wording is the entire experiment; do not paraphrase it.
 * - `{{speaker_1_memories}}` / `{{speaker_2_memories}}` (two blocks keyed by
 *   `{{speaker_N_user_id}}`) are COLLAPSED into a single pooled `Memories:`
 *   block. This is not a convenience shortcut: `Answerer.answer(question,
 *   hits, ctx)` (harness.mts's frozen Contract 2) is never told which
 *   `sample_id` a question belongs to, only the flat `SearchHit[]` evidence
 *   and the whole dataset — so there is no per-hit speaker attribution to
 *   split on even though `LoCoMoSample.conversation.speaker_a/speaker_b`
 *   exist elsewhere in the dataset. Mem0's OWN harness hit the identical
 *   problem when prompting a downstream system with no speaker-tagged
 *   memories (querying Zep as a baseline) and solved it the same way — see
 *   the doc's §A1 note on the `ANSWER_PROMPT_ZEP` variant ("single
 *   {{memories}} block, no per-speaker split"). This answerer follows that
 *   precedent rather than inventing a new one.
 *
 * MODEL: Azure **gpt-4o** — gpt-4o-mini (Mem0's own paper/code default) is
 * NOT deployed on this Azure resource (only gpt-4o, gpt-5-mini,
 * text-embedding-3-small; see `strong.mts`'s header for the same
 * substitution). Deployment, token budget (400), and the omission of
 * `reasoningEffort` (gpt-4o rejects it outright) are copied from
 * `strong.mts` verbatim so `strong` vs `mem0` isolates the PROMPT effect
 * with everything else pinned. This deliberately does NOT add Mem0's own
 * `temperature=0.0` (`ACCURACY_PROMPT`'s sibling, the answer-generation call
 * in Mem0's source also pins temperature — doc §A1) — adding it here would
 * introduce a second variable against `strong`, which omits temperature
 * entirely (Azure default). If a byte-faithful Mem0 reproduction is wanted
 * later, that is a separate knob, not this comparison.
 *
 * `Answerer.id` MUST equal the filename stem — this file's id is `mem0`,
 * matching `mem0.mts`.
 */
import type { Answerer, EvidenceContext } from '../harness.mts';
import type { SearchHit } from '../../../shared/daemon-client.js';
import { azureChatComplete } from '../../../shared/azure-client.js';

// Own knobs, deliberately separate from strong.mts's ASTRA_LOCOMO_STRONG_*
// (and current.mts's/canonical.mts's/zep-match.mts's own) env vars — same
// reasoning as those files: sharing names would make it impossible to
// override one answerer without perturbing its siblings. Defaults are
// copied from strong.mts's values on purpose (see header).
const MEM0_DEPLOYMENT = process.env.ASTRA_LOCOMO_MEM0_DEPLOYMENT ?? 'gpt-4o';
const MEM0_MAX_COMPLETION_TOKENS = (() => {
  const raw = process.env.ASTRA_LOCOMO_MEM0_MAX_TOKENS;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 400;
})();

/**
 * Mem0's `ANSWER_PROMPT`, verbatim except the memory-injection slots (see
 * header). `{{speaker_1_memories}}`/`{{speaker_2_memories}}` collapse into
 * one pooled block; `{{speaker_1_user_id}}`/`{{speaker_2_user_id}}` are
 * dropped along with the per-speaker headers since this answerer has no
 * speaker identity to name (harness Contract 2 passes flat `SearchHit[]`,
 * never a `sample_id`).
 */
function buildMem0AnswerPrompt(question: string, hits: SearchHit[]): string {
  const memories = hits.length > 0
    ? hits.map(h => h.text).join('\n')
    : '(no memories were retrieved for this question)';
  return [
    'You are an intelligent memory assistant tasked with retrieving accurate information from conversation memories.',
    '',
    '# CONTEXT:',
    'You have access to memories from two speakers in a conversation. These memories contain',
    'timestamped information that may be relevant to answering the question.',
    '',
    '# INSTRUCTIONS:',
    '1. Carefully analyze all provided memories from both speakers',
    '2. Pay special attention to the timestamps to determine the answer',
    '3. If the question asks about a specific event or fact, look for direct evidence in the memories',
    '4. If the memories contain contradictory information, prioritize the most recent memory',
    '5. If there is a question about time references (like "last year", "two months ago", etc.),',
    '   calculate the actual date based on the memory timestamp. For example, if a memory from',
    '   4 May 2022 mentions "went to India last year," then the trip occurred in 2021.',
    '6. Always convert relative time references to specific dates, months, or years. For example,',
    '   convert "last year" to "2022" or "two months ago" to "March 2023" based on the memory',
    '   timestamp. Ignore the reference while answering the question.',
    '7. Focus only on the content of the memories from both speakers. Do not confuse character',
    '   names mentioned in memories with the actual users who created those memories.',
    '8. The answer should be less than 5-6 words.',
    '',
    '# APPROACH (Think step by step):',
    '1. First, examine all memories that contain information related to the question',
    '2. Examine the timestamps and content of these memories carefully',
    '3. Look for explicit mentions of dates, times, locations, or events that answer the question',
    '4. If the answer requires calculation (e.g., converting relative time references), show your work',
    '5. Formulate a precise, concise answer based solely on the evidence in the memories',
    '6. Double-check that your answer directly addresses the question asked',
    '7. Ensure your final answer is specific and avoids vague time references',
    '',
    'Memories:',
    '',
    memories,
    '',
    `Question: ${question}`,
    '',
    'Answer:',
  ].join('\n');
}

const mem0: Answerer = {
  id: 'mem0',
  async answer(question: string, hits: SearchHit[], ctx: EvidenceContext): Promise<string> {
    const prompt = buildMem0AnswerPrompt(question, hits);
    const hypothesis = await azureChatComplete(ctx.azureCfg, {
      deployment: MEM0_DEPLOYMENT,
      messages: [{ role: 'user', content: prompt }],
      maxCompletionTokens: MEM0_MAX_COMPLETION_TOKENS,
      // NO reasoningEffort (gpt-4o rejects it) and NO temperature override —
      // matches strong.mts exactly so this cell isolates the PROMPT effect.
    });
    return hypothesis.trim();
  },
};

export default mem0;
