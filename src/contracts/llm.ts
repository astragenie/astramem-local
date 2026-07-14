export interface ChatMsg {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOpts {
  temperature?: number;
  json?: boolean;
  /**
   * Optional JSON Schema constraining the shape of the structured output
   * (issue #261). `json: true` alone only guarantees the response is SOME
   * valid JSON — Ollama's `format: "json"` explicitly does not guarantee a
   * particular top-level shape, so a prompt asking for "a JSON array" can
   * (and, measured live against qwen3:8b and qwen2.5-coder:7b, reliably
   * does) come back as a JSON *object* instead. Ignored by `json: false`/
   * unset. Providers that support schema-constrained structured output
   * (currently: ollama, via its `format` field accepting a schema in place
   * of the bare string `"json"`) honor this; providers that don't
   * (azure-openai, openai-compatible, codex-subscription — all speak
   * `response_format: {type:"json_object"}`/equivalent, not a schema) fall
   * back to their existing `json: true` behavior and ignore this field.
   */
  jsonSchema?: Record<string, unknown>;
  maxTokens?: number;
  /**
   * Caller-supplied cancellation (issue #261). When the caller's own timeout
   * budget expires (e.g. decompose's 800ms, rerank's 300ms — both far
   * shorter than any provider's own multi-second-to-60s internal timeout),
   * this is how the caller actually CANCELS the in-flight request instead of
   * merely abandoning its promise while the real generation keeps running
   * and holding the provider's execution slot. Every LLMProvider
   * implementation must combine this with its own internal timeout signal
   * (`AbortSignal.any([...])`) rather than replacing it — the provider's own
   * ceiling still applies when no caller signal is passed.
   */
  signal?: AbortSignal;
}

export interface ChatUsage {
  in: number;
  out: number;
  usd: number;
}

export interface ChatResult {
  text: string;
  usage: ChatUsage;
}

export interface LLMHealth {
  ok: boolean;
  model: string;
  latency_ms: number;
  error?: string;
}

export interface LLMProvider {
  readonly name: 'ollama' | 'azure-openai' | 'openai-compatible' | 'codex-subscription';
  readonly model: string;
  chat(messages: ChatMsg[], opts?: ChatOpts): Promise<ChatResult>;
  health(): Promise<LLMHealth>;
}
