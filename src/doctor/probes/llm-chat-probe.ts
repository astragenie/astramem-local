import type { LLMProvider } from '../../contracts/llm.js';
import type { CheckResult } from '../types.js';
import { withAbortableTimeout } from '../../util/abortable-timeout.js';

class LlmChatProbeTimeoutError extends Error {}

/**
 * LLM chat probe: sends a real `format:json` chat request to the configured
 * provider — the same request shape every real extraction/compaction/entity
 * call uses (`ChatOpts.json: true`, see `src/providers/llm/ollama.ts`).
 *
 * This replaces surface-only `/api/tags` checks — the model may be listed but
 * unloaded, or the name may mismatch (qwen2.5-coder vs qwen2.5-coder:7b).
 * A real chat call exercises the full path: model loaded, prompt handled,
 * response non-empty.
 *
 * Prior to this fix the probe issued a plain (non-JSON) 1-token chat, which
 * meant it never exercised `format:json` — the exact request shape that
 * broke qwen3 (empty response under thinking mode, see CLAUDE.md). A model
 * that answers a plain chat but returns empty/invalid output under
 * `format:json` used to read as a green doctor row while real extraction was
 * silently broken. The probe now asks for a small JSON object and requires
 * both a non-empty AND JSON-parseable response, so that failure mode goes red.
 *
 * Issue #261: a bare Promise.race abandoned the losing promise rather than
 * cancelling it — a slow/hung provider call kept running to completion in
 * the background after this probe already "timed out", invisibly holding
 * the provider's execution slot. `withAbortableTimeout` both cancels the
 * in-flight request via ChatOpts.signal (combined with, not replacing, the
 * provider's own internal timeout) AND still races a timer so a provider
 * that ignores the signal degrades to the old bounded-wait behavior rather
 * than hanging this probe forever.
 */
export async function llmChatProbe(
  provider: LLMProvider,
  timeoutMs = 5000,
): Promise<CheckResult> {
  try {
    const start = Date.now();
    const result = await withAbortableTimeout(
      (signal) => provider.chat(
        [{ role: 'user', content: 'Respond with exactly this JSON object and nothing else: {"ok":true}' }],
        {
          maxTokens: 16,
          temperature: 0,
          json: true,
          signal,
        },
      ),
      timeoutMs,
      () => new LlmChatProbeTimeoutError('timeout'),
    );
    const latency = Date.now() - start;

    if (!result.text || result.text.trim().length === 0) {
      return {
        ok: false,
        message: `${provider.name}/${provider.model}: empty response under format:json`,
        fix: 'Check model is loaded (ollama run <model>) and supports format:json — some models (e.g. qwen3, deepseek-r1) return empty output under thinking mode',
      };
    }

    try {
      JSON.parse(result.text);
    } catch {
      return {
        ok: false,
        message: `${provider.name}/${provider.model}: response under format:json was not valid JSON`,
        fix: 'Model does not reliably honor format:json — check provider/model choice (thinking-mode models are a common cause)',
      };
    }

    return {
      ok: true,
      message: `${provider.name}/${provider.model} responded in ${latency}ms`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      message: `${provider.name}/${provider.model}: ${msg}`,
      fix: 'Check provider config and model availability',
    };
  }
}
