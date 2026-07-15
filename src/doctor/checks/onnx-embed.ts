import type { Check, CheckResult } from '../types.js';
import type { EmbedProvider } from '../../contracts/embed.js';

/**
 * ADR-018 SLICE-2 — ONNX-specific supplementary embed health check.
 *
 * `checkEmbed` (embed.ts) already generically probes ANY `EmbedProvider`
 * (Ollama, Azure OpenAI, or ONNX) via a real `embed()` call through
 * `embedProbe` — S1's ADR explicitly confirmed "No change needed for ONNX
 * to be probed" there, and that generic probe already satisfies "verifies
 * the provider loads + emits a correct-dim vector" for the onnx path with
 * zero new code. This check is ADDITIVE, not a replacement (mirrors
 * `checkCodexAuth`/`checkOpenAICompatibleReachable` in
 * `provider-supplementary.ts`: a generic probe PLUS a provider-typed
 * supplementary one) — it calls `OnnxEmbedProvider.health()` specifically,
 * which `onnx.ts` documents as an in-process check with no HTTP call
 * (constraint #7), unlike `embedProbe`'s `withAbortableTimeout`-wrapped
 * HTTP-style contract built for the two network-backed providers. Its
 * value-add over the generic probe is onnx-specific fix guidance (model
 * artifact / config knobs an operator can act on) distinct from the
 * generic dim-mismatch message.
 *
 * Only added when the configured embed provider IS onnx — gated by
 * `instanceof OnnxEmbedProvider` in `coreChecks()` (index.ts), the same
 * pattern `checkCodexAuth`/`checkOpenAICompatibleReachable` use for their
 * LLM-provider equivalents (and the pattern this file's own doc comment
 * points to `model-fit.ts` for — that check scopes by a config STRING
 * comparison since it never receives a provider instance; this one scopes
 * by `instanceof` since it does).
 *
 * Tier: 'full' — by construction, not merely a cost-tuning choice. This
 * check is only ever pushed inside `coreChecks()`'s `if (opts.embedProvider)`
 * block, and `runFrequentDoctorChecks` (schedule.ts) unconditionally strips
 * `embedProvider` before building the frequent-tier check list — so a
 * 'cheap'-tagged check gated on `opts.embedProvider` would silently never
 * run on the 15-minute schedule regardless of its declared tier. 'full'
 * also avoids the real cost concern: `health()`'s own doc comment notes a
 * cold cache can still trigger the same one-time ~130-440MB weight download
 * `embed()`'s first call would — repeating that risk every 15 minutes would
 * be exactly the kind of unattended-schedule cost mistake ADR-015 / #226
 * already burned this repo on once (checkMemoryHealth/checkEntityNameQuality
 * riding the frequent tier). Piggybacks the same >=24h cadence as
 * `checkModelFitCanary`/`checkCodexAuth`'s heavier siblings instead.
 */
export function checkOnnxEmbedHealth(provider: EmbedProvider): Check {
  return {
    name: `ONNX embed health (${provider.model})`,
    tier: 'full',
    async run(): Promise<CheckResult> {
      const health = await provider.health();
      if (!health.ok) {
        return {
          ok: false,
          message: `onnx embed: ${health.error ?? 'unknown failure'}`,
          fix:
            'Check onnxEmbed.modelPath/cacheDir in config.yaml, confirm @huggingface/transformers ' +
            '(onnxruntime-node) installed correctly for this platform, and verify network access for ' +
            'the first-run weight download if the cache is cold.',
        };
      }
      return {
        ok: true,
        message: `onnx/${health.model} loaded, smoke inference returned ${health.dim}-dim vector`,
      };
    },
  };
}
