import type { Check, CheckResult } from '../types.js';

// ─── Check: Budget cap blindness under codex-subscription (FEAT-479 AC-15) ──

/**
 * codex-subscription (`src/providers/llm/codex-subscription.ts`) always
 * reports `usage.usd: 0` — a ChatGPT subscription has no per-token price, so
 * there is nothing for `BudgetTracker` to meter (see that provider's own
 * `chat()` comment: "Subscription-quota usage has no per-token USD price —
 * always 0", matching `pricing.ts`'s "unknown model" convention rather than
 * inventing a number). `checkBudget` above reads `budget_spend.usd_total`
 * against `dailyBudgetUsd` and reports "under cap" — which is true but
 * MEANINGLESS the moment either `llm.compaction` or `llm.extraction` is
 * pinned to codex-subscription, because that provider's spend never moves
 * the meter checkBudget is reading. An operator relying on the cap for cost
 * control would see an all-green "$0.00 / $10.00" budget row and reasonably
 * (and wrongly) conclude the cap is protecting them.
 *
 * Deliberately a SEPARATE, unconditional-while-configured check (same
 * posture as `checkProxyCaptureReminder`/`checkDevNoAuth`) rather than
 * folded into `checkBudget` itself — the two checks answer different
 * questions ("is today's metered spend under cap" vs "does the cap apply to
 * this provider at all") and collapsing them would bury the second, more
 * important one inside a check that stays green.
 */
export function checkBudgetCapCodexBlind(dailyBudgetUsd: number, codexSubscriptionInUse: boolean): Check {
  return {
    name: 'Budget cap vs codex-subscription',
    async run(): Promise<CheckResult> {
      if (!codexSubscriptionInUse || dailyBudgetUsd <= 0) {
        return { ok: true, message: 'budget cap applies normally (codex-subscription not in use)' };
      }
      return {
        ok: false,
        message:
          `daily budget cap ($${dailyBudgetUsd.toFixed(2)}) does NOT meter codex-subscription — ` +
          `it always reports usage.usd: 0 (ChatGPT subscription quota has no per-token price), so ` +
          `extraction/compaction spend under this provider is invisible to the cap and will never ` +
          `pause distillation.`,
        fix:
          'Cost control for codex-subscription is your ChatGPT plan quota, not config.budget.daily_usd — ' +
          'monitor usage at chatgpt.com, not `astramem-local budget`.',
      };
    },
  };
}
