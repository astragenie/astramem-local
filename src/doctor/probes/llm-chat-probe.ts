import type { LLMProvider } from '../../contracts/llm.js';
import type { CheckResult } from '../types.js';
import { withAbortableTimeout } from '../../util/abortable-timeout.js';

class LlmChatProbeTimeoutError extends Error {}

/**
 * LLM chat probe: sends a real 1-token chat request to the configured provider.
 *
 * This replaces surface-only `/api/tags` checks — the model may be listed but
 * unloaded, or the name may mismatch (qwen2.5-coder vs qwen2.5-coder:7b).
 * A real chat call exercises the full path: model loaded, prompt handled,
 * response non-empty.
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
      (signal) => provider.chat([{ role: 'user', content: '1' }], {
        maxTokens: 1,
        temperature: 0,
        signal,
      }),
      timeoutMs,
      () => new LlmChatProbeTimeoutError('timeout'),
    );
    const latency = Date.now() - start;

    if (!result.text || result.text.trim().length === 0) {
      return {
        ok: false,
        message: `${provider.name}/${provider.model}: empty response`,
        fix: 'Check model is loaded (ollama run <model>) and responding',
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
