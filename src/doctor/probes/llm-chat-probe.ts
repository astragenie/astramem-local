import type { LLMProvider } from '../../contracts/llm.js';
import type { CheckResult } from '../types.js';

/**
 * LLM chat probe: sends a real 1-token chat request to the configured provider.
 *
 * This replaces surface-only `/api/tags` checks — the model may be listed but
 * unloaded, or the name may mismatch (qwen2.5-coder vs qwen2.5-coder:7b).
 * A real chat call exercises the full path: model loaded, prompt handled,
 * response non-empty.
 */
export async function llmChatProbe(
  provider: LLMProvider,
  timeoutMs = 5000,
): Promise<CheckResult> {
  try {
    const start = Date.now();
    const result = await Promise.race([
      provider.chat([{ role: 'user', content: '1' }], {
        maxTokens: 1,
        temperature: 0,
      }),
      new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error('timeout')), timeoutMs),
      ),
    ]);
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
