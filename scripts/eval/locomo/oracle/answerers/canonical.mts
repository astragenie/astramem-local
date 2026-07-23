/**
 * `Answerer` that renders the MINIMAL, most judge-friendly exact-answer
 * form -- a bare date/name/number/short phrase, never a full sentence. Its
 * entire purpose is SCORER-ARTIFACT isolation (v2 plan §"Phase 1 — the
 * oracle factorial", `harness.mts`'s own header): `current.mts` reuses
 * `answer.mts`'s real prompt, which explicitly asks for "a short phrase,
 * not a sentence", but a real model still sometimes over-answers ("The
 * event happened on 3 May 2023." vs the reference-answer style "3 May
 * 2023") and the token-F1/llm-judge scorers can penalize that phrasing gap
 * even when the underlying fact is correct.
 *
 * Crossed against `gold-turns` (perfect evidence) in the factorial table,
 * this cell answers one specific question definitively: given evidence that
 * cannot be blamed, and an answerer whose OUTPUT FORM cannot be blamed
 * either, is there still a ceiling? If `gold-turns x canonical` scores
 * meaningfully below ~1.0, the remaining gap can only be the metric/judge
 * itself (LoCoMo's F1 is comma/`;`-split-aware but still a lexical-overlap
 * metric; the llm-judge pass has its own failure modes) -- NOT extraction,
 * NOT retrieval, NOT answering. That is the whole reason this file exists
 * and is intentionally NOT just `current.mts` with a shorter prompt: it has
 * to be the best-case answerer, not a middling one, or a low score here
 * would be ambiguous between "answerer flaw" and "scorer flaw" again.
 *
 * Deliberately its own prompt, NOT `buildAnswerPrompt` from `answer.mts`:
 * that prompt (and `answer.mts` itself) is the FIXED cheap benchmark
 * answerer -- a prior team decision ("do not modify answer.mts or its
 * prompt") keeps its behavior byte-stable across every scored run, so this
 * file has its own tightened prompt instead of parameterizing that one.
 *
 * Sampling knobs: this deliberately raises `reasoning_effort` from
 * `current.mts`'s `minimal` default to `low` -- the v2 plan's own notes
 * observed `low` helping this Azure model family produce tighter, more
 * literal extractions on this kind of "give me the minimal answer" task.
 * Raising effort shifts more of the completion-token budget into HIDDEN
 * reasoning (see `answer.mts`'s own A/B-knob comment: "low+150 can truncate
 * answers to empty, FEAT-450 precedent"), so the token budget is raised
 * alongside it (300, vs `current.mts`'s 150) rather than left at the
 * `minimal`-tuned default -- a truncated-to-empty canonical answer would
 * silently look like a scorer-ceiling finding when it was actually a
 * starved completion budget.
 *
 * `Answerer.id` MUST equal the filename stem -- this file's id is
 * `canonical`, matching `canonical.mts`.
 */
import type { Answerer, EvidenceContext } from '../harness.mts';
import type { SearchHit } from '../../../shared/daemon-client.js';
import { azureChatComplete } from '../../../shared/azure-client.js';

// Own A/B knobs, deliberately separate from answer.mts's/current.mts's
// ASTRA_LOCOMO_ANSWER_* env vars -- canonical's tuned defaults (effort=low,
// tokens=300) are intentionally different from current's (effort=minimal,
// tokens=150), so sharing the env var names would make it impossible to
// override just one answerer without also perturbing the other.
const CANONICAL_MAX_COMPLETION_TOKENS = (() => {
  const raw = process.env.ASTRA_LOCOMO_CANONICAL_MAX_TOKENS;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 300;
})();
const CANONICAL_REASONING_EFFORT = ((): 'minimal' | 'low' | 'medium' | 'high' => {
  const v = process.env.ASTRA_LOCOMO_CANONICAL_EFFORT;
  return v === 'minimal' || v === 'medium' || v === 'high' ? v : 'low';
})();

function buildCanonicalPrompt(question: string, hits: SearchHit[]): string {
  const notes = hits.length > 0
    ? hits.map((h, i) => `${i + 1}. ${h.text}`).join('\n')
    : '(no memories were retrieved for this question)';
  return [
    'You extract the MINIMAL exact answer to a question, using ONLY the memory notes below.',
    'Output ONLY the answer itself. Do not restate the question, do not explain, do not hedge, do not write a full sentence.',
    'Style: a bare date as "D Month YYYY", a bare name, a bare number, or at most 5 words -- never a sentence.',
    'If the notes do not contain enough information to answer, or the question presupposes something not supported by the notes, output exactly: "no information available" -- do not guess.',
    '',
    'Memory notes:',
    notes,
    '',
    `Question: ${question}`,
    'Answer (minimal form only):',
  ].join('\n');
}

const canonical: Answerer = {
  id: 'canonical',
  async answer(question: string, hits: SearchHit[], ctx: EvidenceContext): Promise<string> {
    const prompt = buildCanonicalPrompt(question, hits);
    const hypothesis = await azureChatComplete(ctx.azureCfg, {
      deployment: ctx.azureCfg.answererDeployment,
      messages: [{ role: 'user', content: prompt }],
      maxCompletionTokens: CANONICAL_MAX_COMPLETION_TOKENS,
      reasoningEffort: CANONICAL_REASONING_EFFORT,
    });
    return hypothesis.trim();
  },
};

export default canonical;
