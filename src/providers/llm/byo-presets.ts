/**
 * BYO cloud LLM presets — Wave 1.
 *
 * Every preset here resolves THROUGH the existing `openai-compatible`
 * adapter (`src/providers/llm/openai-compatible.ts`, `providerName:
 * 'openai-compatible'` in `LLM_PROVIDER_NAMES`) — a preset is nothing but a
 * named `{baseUrl, defaultModel}` pair the wizard can offer as a one-click
 * choice instead of asking the operator to hand-type a base URL. There is no
 * new provider NAME or new wire-format code for any of these; `anthropic` is
 * the only genuinely new provider in this wave (see anthropic.ts) because it
 * speaks a structurally different API (Messages API, not
 * `/v1/chat/completions`).
 *
 * Each entry was spiked against the vendor's own docs before being added
 * here (2026-07-17) — see `capabilities` below for what was actually
 * confirmed vs. left as a known residual risk. None of these were live-
 * fire tested against a real API key (no operator credential available in
 * this environment); the doctor `llmChatProbe` (json:true, real call) is
 * what actually proves a preset works end-to-end for a given operator.
 */

export interface OpenAICompatPreset {
  /** Human-readable label for the wizard's provider-choice prompt. */
  label: string;
  /** `config.openaiCompatible.baseUrl` value — always the OpenAI-compatible
   *  shim endpoint, never the vendor's native (non-OpenAI-shaped) API. */
  baseUrl: string;
  /** Sensible default model tag for this vendor, used when the operator
   *  doesn't override it. */
  defaultModel: string;
  /** Env var name the wizard writes the API key under (secrets.env), and
   *  `config.openaiCompatible.apiKeyEnv` is set to. Distinct per preset so
   *  switching presets doesn't silently reuse a stale key under a
   *  differently-named var. */
  apiKeyEnv: string;
  capabilities: {
    /**
     * Does this endpoint honor `response_format:{type:'json_object'}` (the
     * literal request shape `openai-compatible.ts` sends when `json:true`)
     * on a normal (non-batch) chat completion?
     *  - 'confirmed': vendor docs explicitly document support for exactly
     *    this request shape on the sync chat-completions endpoint.
     *  - 'partial': vendor supports SOME structured-output mode, but not
     *    provably this exact shape on this exact (sync, non-batch) endpoint
     *    — see the per-preset comment below before relying on it for a real
     *    extraction pipeline.
     */
    jsonObjectMode: 'confirmed' | 'partial';
    /**
     * Which token-limit field the vendor's OpenAI-compat endpoint expects.
     * `openai-compatible.ts` always sends `max_tokens` for a non-reasoning-
     * prefixed model name (see `isReasoningModel` — none of these vendors'
     * model names match the o1/o3/o4/gpt-5 prefixes it checks), regardless
     * of this field. Vendors that have moved to `max_completion_tokens`
     * still document `max_tokens` as "deprecated", not "removed" — expected
     * to keep working, but is the one piece of drift this registry could
     * not verify against a live call (no credentials in this environment).
     * If a future doctor probe or bug report shows `max_tokens` silently
     * ignored/rejected by one of these, that provider needs the same
     * `isReasoningModel`-style per-model dispatch openai-compatible.ts
     * already has for the o-series/gpt-5* case — a provider-level fix, not
     * a preset-level one.
     */
    maxTokensParam: 'max_tokens' | 'max_completion_tokens';
    /** Auth scheme confirmed against vendor docs — all four take a standard
     *  `Authorization: Bearer <key>` header, same as openai-compatible.ts
     *  already sends; none need the query-param (`?key=...`) scheme
     *  Gemini's own NATIVE (non-OpenAI-compat) API uses. */
    auth: 'bearer';
  };
  /** Freeform spike notes — read before assuming a preset "just works". */
  notes: string;
}

export const OPENAI_COMPAT_PRESETS = {
  groq: {
    label: 'Groq (fast open-weight inference)',
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-3.3-70b-versatile',
    apiKeyEnv: 'GROQ_API_KEY',
    capabilities: { jsonObjectMode: 'confirmed', maxTokensParam: 'max_completion_tokens', auth: 'bearer' },
    notes:
      'Spiked 2026-07-17 against console.groq.com/docs/api-reference: Bearer auth confirmed, ' +
      '`response_format:{type:"json_object"}` confirmed on the sync endpoint. Groq has deprecated ' +
      '`max_tokens` in favor of `max_completion_tokens` — openai-compatible.ts always sends the ' +
      'former for a non-reasoning model name; Groq docs say the old field is deprecated, not removed.',
  },
  gemini: {
    label: 'Gemini (Google, via OpenAI-compatibility endpoint)',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    defaultModel: 'gemini-2.0-flash',
    apiKeyEnv: 'GEMINI_API_KEY',
    capabilities: { jsonObjectMode: 'partial', maxTokensParam: 'max_tokens', auth: 'bearer' },
    notes:
      'Spiked 2026-07-17 against ai.google.dev/gemini-api/docs/openai + Google\'s own developer forum: ' +
      'Bearer auth confirmed (`Authorization: Bearer $GEMINI_API_KEY`) — this is the one vendor here ' +
      'whose NATIVE API uses a `?key=` query param instead, so this matters: the OpenAI-compat shim ' +
      'specifically takes Bearer, same as the other three. `response_format:{type:"json_object"}` is ' +
      'DOCUMENTED FOR BATCH mode; real-time (sync) mode is documented as preferring ' +
      '`response_format:{type:"json_schema",...}` instead — marked \'partial\' rather than \'confirmed\' ' +
      'because openai-compatible.ts only ever sends bare json_object, never json_schema. In practice ' +
      'this likely still returns valid JSON (Gemini structured-output models generally honor the ' +
      'looser json_object hint too) but is the one preset here that was NOT confirmed working on the ' +
      'exact wire shape this codebase sends — verify with `doctor` (llmChatProbe) before relying on it ' +
      'for extraction.',
  },
  kimi: {
    label: 'Kimi / Moonshot',
    baseUrl: 'https://api.moonshot.cn/v1',
    defaultModel: 'moonshot-v1-8k',
    apiKeyEnv: 'MOONSHOT_API_KEY',
    capabilities: { jsonObjectMode: 'confirmed', maxTokensParam: 'max_completion_tokens', auth: 'bearer' },
    notes:
      'Spiked 2026-07-17 against platform.kimi.ai/docs/api/chat (platform.moonshot.ai redirects there): ' +
      'Bearer auth confirmed, `response_format:{type:"json_object"}` confirmed. Like Groq, `max_tokens` ' +
      'is documented as deprecated in favor of `max_completion_tokens`. api.moonshot.cn/v1 is the ' +
      "China-region endpoint (used here per this wave's spec); api.moonshot.ai/v1 is the international " +
      'endpoint for operators outside China — same wire shape, different base URL, not offered as a ' +
      'separate preset in this wave.',
  },
  deepseek: {
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    defaultModel: 'deepseek-chat',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    capabilities: { jsonObjectMode: 'confirmed', maxTokensParam: 'max_tokens', auth: 'bearer' },
    notes:
      'Spiked 2026-07-17 against api-docs.deepseek.com/guides/json_mode: Bearer auth confirmed, ' +
      '`response_format:{type:"json_object"}` confirmed, still uses `max_tokens` (no ' +
      'max_completion_tokens migration) — the cleanest match to openai-compatible.ts\'s existing wire ' +
      'shape of the four. DeepSeek\'s own docs note the response can occasionally come back empty under ' +
      'JSON mode and recommend a generous max_tokens to avoid mid-string truncation; also requires the ' +
      'literal word "json" somewhere in the prompt — openai-compatible.ts already appends a ' +
      '"Respond with valid JSON only." hint whenever a json:true call\'s messages don\'t already ' +
      'contain it (`appendsJsonHintWhenMissing`), so this is already covered.',
  },
} as const satisfies Record<string, OpenAICompatPreset>;

export type OpenAICompatPresetName = keyof typeof OPENAI_COMPAT_PRESETS;

export const OPENAI_COMPAT_PRESET_NAMES = Object.keys(OPENAI_COMPAT_PRESETS) as OpenAICompatPresetName[];

export function getOpenAICompatPreset(name: OpenAICompatPresetName): OpenAICompatPreset {
  return OPENAI_COMPAT_PRESETS[name];
}
