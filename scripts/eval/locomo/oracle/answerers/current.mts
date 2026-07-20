/**
 * Reference `Answerer` — wraps the exact pipeline
 * `scripts/eval/locomo/answer.mts` uses for the real benchmark path:
 * `buildAnswerPrompt(question, hits)` -> `azureChatComplete(...)` against
 * the same deployment, with the same token-budget/reasoning-effort
 * resolution (mirrored via the identical `ASTRA_LOCOMO_ANSWER_MAX_TOKENS`/
 * `ASTRA_LOCOMO_ANSWER_EFFORT` env vars answer.mts reads).
 *
 * Deliberately NOT imported from answer.mts: those two constants
 * (`ANSWER_MAX_COMPLETION_TOKENS`/`ANSWER_REASONING_EFFORT`) are
 * module-private there, and answer.mts is the FIXED cheap benchmark
 * answerer — a prior team decision ("do not modify answer.mts or its
 * prompt, the PR will be rejected") exists specifically to keep that file's
 * behavior byte-stable across every scored run. Exporting two already-
 * existing consts would be a zero-behavior-change visibility edit, but this
 * file avoids touching answer.mts at all rather than relitigate that
 * decision for a one-line convenience. Duplicating the tiny env-var
 * resolution here keeps this answerer's cells directly comparable to every
 * existing `run.mts`/`judge.mts` score in `docs/eval-runs/LEDGER.md`.
 *
 * `Answerer.id` MUST equal the filename stem — this file's id is
 * `current`, matching `current.mts`.
 */
import type { Answerer, EvidenceContext } from '../harness.mts';
import type { SearchHit } from '../../../shared/daemon-client.js';
import { buildAnswerPrompt } from '../../answer.mts';
import { azureChatComplete } from '../../../shared/azure-client.js';

// Mirrors answer.mts's identical A/B knobs (v2 plan C2) byte-for-byte —
// same env vars, same defaults, same clamp logic — so this stays comparable
// to the frozen benchmark answerer under the same overrides.
const ANSWER_MAX_COMPLETION_TOKENS = (() => {
  const raw = process.env.ASTRA_LOCOMO_ANSWER_MAX_TOKENS;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 150;
})();
const ANSWER_REASONING_EFFORT = ((): 'minimal' | 'low' | 'medium' | 'high' => {
  const v = process.env.ASTRA_LOCOMO_ANSWER_EFFORT;
  return v === 'low' || v === 'medium' || v === 'high' ? v : 'minimal';
})();

const current: Answerer = {
  id: 'current',
  async answer(question: string, hits: SearchHit[], ctx: EvidenceContext): Promise<string> {
    const prompt = buildAnswerPrompt(question, hits);
    const hypothesis = await azureChatComplete(ctx.azureCfg, {
      deployment: ctx.azureCfg.answererDeployment,
      messages: [{ role: 'user', content: prompt }],
      maxCompletionTokens: ANSWER_MAX_COMPLETION_TOKENS,
      reasoningEffort: ANSWER_REASONING_EFFORT,
    });
    return hypothesis.trim();
  },
};

export default current;
