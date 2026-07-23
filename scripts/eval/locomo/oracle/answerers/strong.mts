/**
 * `strong` — a STRONGER-reader `Answerer` for the answerer-ceiling experiment
 * (2026-07-20). Identical to `current` in every respect EXCEPT the model: it
 * uses the exact same `buildAnswerPrompt(question, hits)` and the same hits,
 * so the ONLY variable between the `current` and `strong` columns of a
 * factorial run is the answering model. This isolates the answerer's
 * contribution to the LoCoMo score, which the oracle factorial attributed
 * ~87% of the gap-to-Zep to.
 *
 * Zep's published 94.7% uses reader = gpt-5.4 (reasoning medium) + a gpt-5.4
 * chain-of-thought judge. gpt-5.4 is NOT deployed on this Azure resource
 * (only gpt-4o, gpt-5-mini, text-embedding-3-small are), so `strong` uses
 * **gpt-4o** — the strongest reader available here and a genuine frontier
 * model vs the deliberately-cheap `gpt-5-mini` `current` answerer. This is a
 * strictly weaker stand-in for gpt-5.4, so any lift it produces is a LOWER
 * BOUND on what Zep's reader would give on the same evidence.
 *
 * The JUDGE is deliberately held constant (still gpt-5-mini via
 * `runLlmJudge`) across both answerer columns — so `current` vs `strong` is a
 * clean same-judge A/B measuring the answerer effect. Matching Zep's ABSOLUTE
 * number would additionally require the gpt-5.4 CoT judge, which we also don't
 * have on Azure; that is out of scope for this experiment, which asks only
 * "does a stronger reader lift OUR pipeline's score" — a relative question a
 * fixed judge answers correctly.
 *
 * gpt-4o is NOT a reasoning model: it accepts `max_completion_tokens` but
 * rejects `reasoning_effort`, so this answerer omits effort entirely (passing
 * it would error the request). Token budget is raised (400) vs current's 150
 * because gpt-4o has no hidden-reasoning budget to protect and may phrase
 * slightly longer; the judge scores meaning, not length.
 *
 * `Answerer.id` MUST equal the filename stem — this file's id is `strong`,
 * matching `strong.mts`.
 */
import type { Answerer, EvidenceContext } from '../harness.mts';
import type { SearchHit } from '../../../shared/daemon-client.js';
import { buildAnswerPrompt } from '../../answer.mts';
import { azureChatComplete } from '../../../shared/azure-client.js';

// Own knobs, separate from current's ASTRA_LOCOMO_ANSWER_* — the strong
// answerer's deployment/budget are intentionally different, so sharing env
// vars would make it impossible to override one without perturbing the other.
const STRONG_DEPLOYMENT = process.env.ASTRA_LOCOMO_STRONG_DEPLOYMENT ?? 'gpt-4o';
const STRONG_MAX_COMPLETION_TOKENS = (() => {
  const raw = process.env.ASTRA_LOCOMO_STRONG_MAX_TOKENS;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 400;
})();

const strong: Answerer = {
  id: 'strong',
  async answer(question: string, hits: SearchHit[], ctx: EvidenceContext): Promise<string> {
    const prompt = buildAnswerPrompt(question, hits);
    const hypothesis = await azureChatComplete(ctx.azureCfg, {
      deployment: STRONG_DEPLOYMENT,
      messages: [{ role: 'user', content: prompt }],
      maxCompletionTokens: STRONG_MAX_COMPLETION_TOKENS,
      // NO reasoningEffort — gpt-4o rejects it.
    });
    return hypothesis.trim();
  },
};

export default strong;
