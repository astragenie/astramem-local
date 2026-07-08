import type { CheckResult } from '../types.js';

/**
 * openai-compatible reachability probe: a lightweight GET against
 * `<baseUrl>/models` (the one endpoint essentially every OpenAI-compatible
 * server implements — OpenAI, Groq, vLLM, LM Studio) with a short timeout.
 *
 * Deliberately NOT the same as the LLM chat probe (doctor/probes/llm-chat-
 * probe.ts, which already runs generically against every LLMProvider,
 * including this one) — this check answers "is the endpoint even up" with a
 * clearer, config-focused message, independent of whether a model/API key is
 * also correctly configured for a real chat call.
 */
export async function openAICompatibleReachabilityProbe(
  baseUrl: string,
  timeoutMs = 5000,
): Promise<CheckResult> {
  const url = `${baseUrl.replace(/\/$/, '')}/models`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    // Any HTTP response (even 401/404) means the endpoint is up and
    // routable — auth/model correctness is the chat probe's job, not this one.
    return { ok: true, message: `openai-compatible: ${baseUrl} reachable (HTTP ${res.status})` };
  } catch (err) {
    return {
      ok: false,
      message: `openai-compatible: ${baseUrl} unreachable: ${err instanceof Error ? err.message : String(err)}`,
      fix: 'Check config.openaiCompatible.baseUrl and that the endpoint is running / network-reachable.',
    };
  }
}
