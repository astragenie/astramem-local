/**
 * FEAT-543 AC-6 — optional LLM-judge pass over MERGED-text quality.
 *
 * The mechanical tier (tests/eval/consolidation-eval.test.ts, run under
 * `vitest run` in CI) only checks WHETHER runConsolidation's merge/propose/
 * untouched decision matches a gold label — it never asks whether a merged
 * atom's resulting text actually preserved both sides' information. That
 * second question needs an LLM judge, which is why it lives here instead of
 * in the vitest file: this repo's eval convention (extraction-bench's
 * lib/judge.ts, scripts/eval/shared/azure-client.ts) is that any real LLM
 * call is operator-triggered and metered, never part of the default CI
 * gate — same reasoning FEAT-482 exists to enforce for the contradiction
 * judge inside runConsolidation itself.
 *
 * Fencing (AC-6): this script is a NO-OP unless CONSOLIDATION_EVAL_JUDGE=1
 * is set in the invoking shell. tests/eval/consolidation-eval.test.ts never
 * imports this file and never invokes it — the two are wired together only
 * by convention (an operator runs this manually after reading the
 * mechanical tier's run artifact), exactly like extraction-bench's
 * `--llm-judge` flag is additive to, not part of, its default run.
 *
 * STATUS: skeleton only (FEAT-543 slice scope — "a stub/script skeleton is
 * acceptable; the judge itself is NOT required to be functional this
 * slice, only correctly fenced"). Wiring a real merged-text-quality judge
 * is a follow-up: read scripts/eval/consolidation-bench/results/latest-run.json
 * for merged pairs, reconstruct each winner/loser text pair, and reuse
 * resolveAzureConfig()/azureChatComplete() (scripts/eval/shared/config.ts,
 * scripts/eval/shared/azure-client.ts) the same way extraction-bench's
 * lib/judge.ts does — one call per merged pair, asking whether the winning
 * atom's text still carries every fact the loser's text carried.
 *
 * Usage (once implemented):
 *   CONSOLIDATION_EVAL_JUDGE=1 bun scripts/eval/consolidation-bench/judge-merged-text-quality.mts
 */

const OPT_IN_VAR = 'CONSOLIDATION_EVAL_JUDGE';

function main(): void {
  if (process.env[OPT_IN_VAR] !== '1') {
    // eslint-disable-next-line no-console
    console.log(
      `[consolidation-bench] ${OPT_IN_VAR} is not set to '1' — skipping the merged-text-quality ` +
      'judge pass entirely (no LLM call attempted). Set it explicitly to opt in.',
    );
    return;
  }

  // eslint-disable-next-line no-console
  console.log(
    '[consolidation-bench] merged-text-quality judge is not yet implemented (FEAT-543 slice scope — ' +
    'fencing only). See this file\'s header comment for the intended follow-up shape.',
  );
}

main();
