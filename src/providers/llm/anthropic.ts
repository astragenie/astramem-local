import type { ChatMsg, ChatOpts, ChatResult, LLMHealth, LLMProvider } from '../../contracts/llm.js';
import { computeCostUsd } from './pricing.js';
import { TransientError, DeterministicError } from '../../pipeline/errors.js';
import { childLogger } from '../../log/logger.js';
import { parseRetryAfterMs } from './retry-after.js';

const CHAT_TIMEOUT_MS = 60_000;
const HEALTH_TIMEOUT_MS = 15_000;
const ANTHROPIC_VERSION = '2023-06-01';
const ANTHROPIC_BASE_URL = 'https://api.anthropic.com';

/** Anthropic requires `max_tokens` on every request (unlike the OpenAI-family
 *  wire shape, where it's optional) — no real call site in this codebase
 *  omits it (compaction: 2000, extraction: 2500+, entity extraction: 400,
 *  ...) except the contract-suite's bare `chat([...])` calls and doctor's
 *  probe (16). 1024 is a safe, generous default for those. */
const DEFAULT_MAX_TOKENS = 1024;

/** Forced tool name used to coerce structured JSON output — see the module
 *  doc comment below for why tool-use, not a text-based JSON mode. */
const JSON_TOOL_NAME = 'emit_json';

export interface AnthropicLLMConfig {
  apiKey: string;
  model: string;
  /** Override the API base URL — test seam only; every real call targets
   *  ANTHROPIC_BASE_URL. */
  baseUrl?: string;
}

interface AnthropicContentBlock {
  type: string;
  text?: string;
  // tool_use blocks
  id?: string;
  name?: string;
  input?: unknown;
}

interface AnthropicMessageResponse {
  content?: AnthropicContentBlock[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
  error?: { type?: string; message?: string };
}

/**
 * Anthropic Messages API provider (`POST /v1/messages`).
 *
 * ── JSON structured output: forced tool-use, not a text JSON mode ─────────
 *
 * Anthropic's Messages API has no `response_format: {type:"json_object"}`
 * equivalent — the documented way to get reliable structured JSON back is
 * "forced tool use": define a single tool whose `input_schema` is the shape
 * you want, then set `tool_choice: {type:"tool", name:...}` so the model MUST
 * call it. The API then returns a `tool_use` content block whose `input`
 * field is **already a parsed JSON object**, not a string the way every
 * other provider in this codebase returns JSON (they all return a `content`
 * STRING that happens to parse as JSON). `ChatResult.text` is a string every
 * caller `JSON.parse()`s (see 05-extract.ts, contradiction-judge.ts,
 * extract-entities.ts, ...), so this provider re-serializes `input` back to
 * a string with `JSON.stringify` — the round-trip is lossless (parse(json)
 * then stringify gives back semantically identical JSON, just possibly
 * different whitespace/key order) and keeps this a drop-in `LLMProvider` for
 * every existing `JSON.parse(result.text)` call site.
 *
 * `ChatOpts.jsonSchema` (issue #261) maps directly onto the tool's
 * `input_schema` when supplied — Anthropic is a real schema-constrained
 * provider, unlike Ollama's schema-shaped `format` hint. One wrinkle: a
 * forced tool's `input` is ALWAYS a JSON *object* (Anthropic's tool-use
 * contract), but some callers ask for a top-level JSON *array*
 * (`search/decompose.ts`: `jsonSchema: {type:'array', items:{type:'string'}}`).
 * For an array schema, the tool is given a wrapper object schema
 * `{type:'object', properties:{items: <the array schema>}, required:['items']}`
 * and the response unwraps `input.items` before stringifying — the caller
 * still sees a bare JSON array string, exactly what it asked for. Without a
 * schema at all (`json: true` alone), the tool's `input_schema` is the
 * permissive `{type:'object'}` — any object shape, matching the "SOME valid
 * JSON, no shape guarantee" contract every provider gives when `json:true`
 * is set with no schema (see `ChatOpts.jsonSchema`'s doc comment,
 * contracts/llm.ts).
 *
 * Prose calls (no `json` opt — compaction, etc.) send NO tools at all, so
 * the model replies with ordinary `text` content blocks, concatenated for
 * `ChatResult.text`.
 *
 * ── System prompt ──────────────────────────────────────────────────────────
 * Anthropic's wire shape splits system instructions into a top-level
 * `system` string field — `messages` may only contain `user`/`assistant`
 * roles. `role: 'system'` entries in the caller's `ChatMsg[]` are extracted
 * and joined (every real call site in this codebase sends at most one).
 */
export class AnthropicLLMProvider implements LLMProvider {
  readonly name = 'anthropic' as const;
  readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(config: AnthropicLLMConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.baseUrl = (config.baseUrl ?? ANTHROPIC_BASE_URL).replace(/\/$/, '');
  }

  private get messagesUrl(): string {
    return `${this.baseUrl}/v1/messages`;
  }

  /** Never includes the API key by value in anything logged — only sent as
   *  a request header. See the module's key-leak audit note in the parity
   *  test suite (tests/providers/anthropic-llm.test.ts). */
  private authHeaders(): Record<string, string> {
    return {
      'x-api-key': this.apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    };
  }

  private buildToolSchema(jsonSchema?: Record<string, unknown>): {
    schema: Record<string, unknown>;
    wrapsArray: boolean;
  } {
    if (!jsonSchema) return { schema: { type: 'object' }, wrapsArray: false };
    if (jsonSchema.type === 'array') {
      return {
        schema: { type: 'object', properties: { items: jsonSchema }, required: ['items'] },
        wrapsArray: true,
      };
    }
    return { schema: jsonSchema, wrapsArray: false };
  }

  async chat(messages: ChatMsg[], opts?: ChatOpts): Promise<ChatResult> {
    const log = childLogger({ provider: this.name, model: this.model });
    const t0 = Date.now();
    const useJson = opts?.json === true;

    const systemText = messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n');
    const outgoing = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role, content: m.content }));

    let wrapsArray = false;
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: opts?.maxTokens ?? DEFAULT_MAX_TOKENS,
      messages: outgoing,
      ...(systemText ? { system: systemText } : {}),
      ...(opts?.temperature !== undefined ? { temperature: opts.temperature } : {}),
    };
    if (useJson) {
      const { schema, wrapsArray: wraps } = this.buildToolSchema(opts?.jsonSchema);
      wrapsArray = wraps;
      body.tools = [
        {
          name: JSON_TOOL_NAME,
          description: 'Emit the requested output as structured JSON via this tool call.',
          input_schema: schema,
        },
      ];
      body.tool_choice = { type: 'tool', name: JSON_TOOL_NAME };
    }

    const res = await this.fetchWithRetry(
      this.messagesUrl,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...this.authHeaders(),
        },
        body: JSON.stringify(body),
      },
      CHAT_TIMEOUT_MS,
      opts?.signal,
    );

    if (!res.ok) {
      const raw = await res.text().catch(() => '');
      let detail = raw;
      try {
        const parsed = JSON.parse(raw) as AnthropicMessageResponse;
        detail = parsed.error?.message ?? raw;
      } catch {
        // leave as raw text
      }
      const snippet = detail.slice(0, 200);
      const latency_ms = Date.now() - t0;
      log.warn(
        { latency_ms, status: res.status, error_kind: res.status >= 500 || res.status === 429 ? 'TransientError' : 'DeterministicError' },
        'anthropic chat failed',
      );
      if (res.status >= 500) {
        throw new TransientError(`Anthropic chat failed: HTTP ${res.status} — ${snippet}`, undefined, parseRetryAfterMs(res.headers.get('retry-after')));
      }
      if (res.status === 429) {
        throw new TransientError(`Anthropic chat rate-limited (429): ${snippet}`, undefined, parseRetryAfterMs(res.headers.get('retry-after')));
      }
      throw new DeterministicError(`Anthropic chat failed: HTTP ${res.status} — ${snippet}`);
    }

    const data = (await res.json()) as AnthropicMessageResponse;
    const blocks = data.content ?? [];

    let text: string;
    if (useJson) {
      const toolUse = blocks.find((b) => b.type === 'tool_use' && b.name === JSON_TOOL_NAME);
      // CRITICAL: tool_use.input is already a parsed object, never a JSON
      // string — re-serialize so ChatResult.text stays a JSON.parse()-able
      // string, the contract every caller relies on. wrapsArray unwraps the
      // `{items:[...]}` shape back to the bare array the caller asked for.
      const input = toolUse?.input as Record<string, unknown> | undefined;
      const payload = wrapsArray && input ? input.items : input;
      text = payload !== undefined ? JSON.stringify(payload) : '';
    } else {
      text = blocks
        .filter((b) => b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('');
    }

    const promptTokens = data.usage?.input_tokens ?? 0;
    const completionTokens = data.usage?.output_tokens ?? 0;
    const usd = computeCostUsd(this.model, promptTokens, completionTokens);
    const latency_ms = Date.now() - t0;

    log.info({ latency_ms, tokens_in: promptTokens, tokens_out: completionTokens, usd }, 'anthropic chat ok');

    return {
      text,
      usage: { in: promptTokens, out: completionTokens, usd },
    };
  }

  async health(): Promise<LLMHealth> {
    const t0 = Date.now();
    const body = {
      model: this.model,
      max_tokens: 1,
      messages: [{ role: 'user', content: 'ping' }],
    };
    try {
      const res = await fetch(this.messagesUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...this.authHeaders(),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      });
      const latency_ms = Date.now() - t0;
      return {
        ok: res.ok,
        model: this.model,
        latency_ms,
        ...(res.ok ? {} : { error: `HTTP ${res.status}` }),
      };
    } catch (err) {
      return {
        ok: false,
        model: this.model,
        latency_ms: Date.now() - t0,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Combines a caller-supplied cancellation signal with a fixed-duration
   * internal ceiling (issue #261 pattern, mirrored from azure-openai.ts /
   * openai-compatible.ts) and retries once on a 5xx/network failure.
   */
  private async fetchWithRetry(
    url: string,
    init: RequestInit,
    timeoutMs: number,
    externalSignal?: AbortSignal,
  ): Promise<Response> {
    let lastError: unknown;
    for (let i = 0; i < 2; i++) {
      try {
        const ownSignal = AbortSignal.timeout(timeoutMs);
        const signal = externalSignal ? AbortSignal.any([externalSignal, ownSignal]) : ownSignal;
        const res = await fetch(url, { ...init, signal });
        if (res.status >= 400 && res.status < 500) return res;
        if (res.status >= 500 && i === 0) {
          lastError = new Error(`HTTP ${res.status} from Anthropic`);
          continue;
        }
        return res;
      } catch (err) {
        if (i === 0) {
          lastError = err;
          continue;
        }
        throw err;
      }
    }
    throw lastError;
  }
}
