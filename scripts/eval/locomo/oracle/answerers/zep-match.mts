/**
 * `zep-match` — the answerer configured to match Zep's published LoCoMo
 * reader EXACTLY: gpt-5.4 at reasoning_effort=medium. Zep's 94.7% uses
 * reader = gpt-5.4 (reasoning medium) + a gpt-5.4 chain-of-thought judge; this
 * answerer reproduces the reader half. gpt-5.4 was provisioned on this Azure
 * resource on 2026-07-20 specifically for this experiment (GlobalStandard,
 * consumption-billed).
 *
 * Same `buildAnswerPrompt(question, hits)` and same hits as `current` /
 * `strong`, so across the {current, strong, zep-match} answerer columns the
 * ONLY variable is the answering model:
 *   current   = gpt-5-mini,  effort minimal  (our frozen cheap benchmark reader)
 *   strong    = gpt-4o                        (frontier lower bound)
 *   zep-match = gpt-5.4,      effort medium   (Zep's exact reader)
 *
 * The JUDGE is held constant (gpt-5-mini via runLlmJudge) across all three, so
 * this stays a clean same-judge A/B isolating the READER effect. Matching
 * Zep's ABSOLUTE number would also need their gpt-5.4 CoT judge; that is a
 * separate axis and out of scope for "does a stronger reader lift OUR score".
 *
 * gpt-5.4 is a reasoning model: it takes `reasoning_effort` + a
 * `max_completion_tokens` budget that must cover the HIDDEN reasoning tokens,
 * not just the visible answer. Budget is set high (2000) so a medium-effort
 * reasoning trace on a short factual answer cannot truncate the visible answer
 * to empty (the FEAT-450 starved-completion failure mode). Overridable via
 * `ASTRA_LOCOMO_ZEP_*`.
 *
 * `Answerer.id` MUST equal the filename stem — this file's id is `zep-match`,
 * matching `zep-match.mts`.
 */
import type { Answerer, EvidenceContext } from '../harness.mts';
import type { SearchHit } from '../../../shared/daemon-client.js';
import { buildAnswerPrompt } from '../../answer.mts';
import { azureChatComplete } from '../../../shared/azure-client.js';

const ZEP_DEPLOYMENT = process.env.ASTRA_LOCOMO_ZEP_DEPLOYMENT ?? 'gpt-5.4';
const ZEP_MAX_COMPLETION_TOKENS = (() => {
  const raw = process.env.ASTRA_LOCOMO_ZEP_MAX_TOKENS;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 2000;
})();
const ZEP_REASONING_EFFORT = ((): 'minimal' | 'low' | 'medium' | 'high' => {
  const v = process.env.ASTRA_LOCOMO_ZEP_EFFORT;
  return v === 'minimal' || v === 'low' || v === 'high' ? v : 'medium';
})();

const zepMatch: Answerer = {
  id: 'zep-match',
  async answer(question: string, hits: SearchHit[], ctx: EvidenceContext): Promise<string> {
    const prompt = buildAnswerPrompt(question, hits);
    const hypothesis = await azureChatComplete(ctx.azureCfg, {
      deployment: ZEP_DEPLOYMENT,
      messages: [{ role: 'user', content: prompt }],
      maxCompletionTokens: ZEP_MAX_COMPLETION_TOKENS,
      reasoningEffort: ZEP_REASONING_EFFORT,
    });
    return hypothesis.trim();
  },
};

export default zepMatch;
