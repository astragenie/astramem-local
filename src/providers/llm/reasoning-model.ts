/**
 * Reasoning-model detection, shared by every provider that speaks the
 * classic OpenAI `/v1/chat/completions` wire shape (azure-openai.ts,
 * openai-compatible.ts).
 *
 * The "reasoning" model family — the o-series (o1, o1-mini, o1-preview,
 * o1-pro, o3, o3-mini, o3-pro, o4-mini, ...) plus gpt-5* — rejects the
 * classic Chat Completions `temperature` and `max_tokens` parameters
 * outright with HTTP 400 (e.g. gpt-5-mini: "Unsupported parameter:
 * 'max_tokens' is not supported with this model. Use 'max_completion_tokens'
 * instead."). These models don't take a sampling-temperature knob at all, so
 * `temperature` is simply omitted rather than mapped to anything.
 * Non-reasoning models (gpt-4*, gpt-3.5*, ...) are unaffected and keep the
 * classic parameters unchanged.
 *
 * Matched by model-name prefix (case-insensitive). Extracted out of
 * azure-openai.ts (2026-07-13) once openai-compatible.ts needed the exact
 * same predicate: both providers hit the same real OpenAI-family backends
 * and would otherwise drift the way `?? true` (json opt-in) drifted across
 * all three HTTP providers independently. Ollama and codex-subscription do
 * NOT import this — they speak structurally different wire shapes
 * (Ollama's `options.num_predict`, codex's Responses API `max_output_tokens`
 * with its own separate rejection rules) where this predicate doesn't apply.
 */
const REASONING_MODEL_PREFIXES = [/^o1(?:-|$)/i, /^o3(?:-|$)/i, /^o4(?:-|$)/i, /^gpt-5/i];

/** Is `model` one of the OpenAI-family reasoning models (o-series / gpt-5*)? */
export function isReasoningModel(model: string): boolean {
  return REASONING_MODEL_PREFIXES.some((re) => re.test(model));
}
