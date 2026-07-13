import type { ChatMsg, ChatOpts, ChatResult, LLMHealth, LLMProvider } from '../../contracts/llm.js';
import { computeCostUsd } from './pricing.js';
import { TransientError, DeterministicError } from '../../pipeline/errors.js';
import { childLogger } from '../../log/logger.js';
import { parseRetryAfterMs } from './retry-after.js';

const CHAT_TIMEOUT_MS = 60_000;
const HEALTH_TIMEOUT_MS = 15_000;

/**
 * Generic OpenAI-`/v1/chat/completions`-compatible provider. Works against
 * the real OpenAI API, Groq, vLLM, LM Studio, or any other server that
 * speaks the same wire shape — only `baseUrl` + `model` differ per target.
 *
 * `apiKey` is optional: some self-hosted endpoints (local vLLM, LM Studio)
 * require no auth at all. When present, it is sent as a standard
 * `Authorization: Bearer` header; when absent, the header is simply omitted
 * rather than treating a missing key as a hard config error (unlike Azure,
 * where every deployment requires one).
 */
export interface OpenAICompatibleLLMConfig {
  baseUrl: string;
  model: string;
  apiKey?: string;
}

interface OpenAIChatResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
  error?: { message?: string };
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  let lastError: unknown;
  for (let i = 0; i < 2; i++) {
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      // No retry on 4xx
      if (res.status >= 400 && res.status < 500) return res;
      // Retry on 5xx (first attempt only)
      if (res.status >= 500 && i === 0) {
        lastError = new Error(`HTTP ${res.status} from ${url}`);
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

export class OpenAICompatibleLLMProvider implements LLMProvider {
  readonly name = 'openai-compatible' as const;
  readonly model: string;
  /** Public (unlike the private fields on the ollama/azure providers) so
   * doctor probes can reachability-check the configured endpoint without
   * threading the raw config through a second path — see
   * doctor/probes/openai-compatible-probe.ts. */
  readonly baseUrl: string;
  private readonly apiKey?: string;

  constructor(config: OpenAICompatibleLLMConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.model = config.model;
    this.apiKey = config.apiKey;
  }

  private get chatUrl(): string {
    return `${this.baseUrl}/chat/completions`;
  }

  private authHeaders(): Record<string, string> {
    return this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {};
  }

  async chat(messages: ChatMsg[], opts?: ChatOpts): Promise<ChatResult> {
    const log = childLogger({ provider: this.name, model: this.model });
    const t0 = Date.now();
    // JSON must be OPT-IN (fixed 2026-07-13) — same bug as azure-openai.ts had:
    // `?? true` forces response_format onto prose calls like compaction, which never asks
    // for JSON and returns its text verbatim. OpenAI-compatible backends reject that with
    // "'messages' must contain the word 'json'". Every real JSON caller passes json: true
    // explicitly, so opt-in is safe.
    const useJson = opts?.json === true;
    const body = {
      model: this.model,
      messages,
      ...(useJson ? { response_format: { type: 'json_object' } } : {}),
      ...(opts?.temperature !== undefined ? { temperature: opts.temperature } : {}),
      ...(opts?.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
    };

    const res = await fetchWithRetry(
      this.chatUrl,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...this.authHeaders(),
        },
        body: JSON.stringify(body),
      },
      CHAT_TIMEOUT_MS,
    );

    if (!res.ok) {
      const raw = await res.text().catch(() => '');
      let detail = raw;
      try {
        const parsed = JSON.parse(raw) as OpenAIChatResponse;
        detail = parsed.error?.message ?? raw;
      } catch {
        // leave as raw text
      }
      const snippet = detail.slice(0, 200);
      const latency_ms = Date.now() - t0;
      log.warn({ latency_ms, status: res.status, error_kind: res.status >= 500 || res.status === 429 ? 'TransientError' : 'DeterministicError' }, 'openai-compatible chat failed');
      if (res.status >= 500) {
        throw new TransientError(`openai-compatible chat failed: HTTP ${res.status} — ${snippet}`, undefined, parseRetryAfterMs(res.headers.get('retry-after')));
      }
      if (res.status === 429) {
        // The real OpenAI API (and Groq, which mirrors its headers) document
        // Retry-After on 429 — self-hosted backends (vLLM, LM Studio) this
        // provider can also point at typically do NOT send it, which is
        // fine: parseRetryAfterMs returns undefined and the caller falls
        // back to its own backoff.
        throw new TransientError(`openai-compatible chat rate-limited (429): ${snippet}`, undefined, parseRetryAfterMs(res.headers.get('retry-after')));
      }
      throw new DeterministicError(`openai-compatible chat failed: HTTP ${res.status} — ${snippet}`);
    }

    const data = (await res.json()) as OpenAIChatResponse;
    const text = data.choices?.[0]?.message?.content ?? '';
    const promptTokens = data.usage?.prompt_tokens ?? 0;
    const completionTokens = data.usage?.completion_tokens ?? 0;
    // Pricing table only covers a handful of known model ids (pricing.ts) —
    // unknown ids (Groq/vLLM model names, etc.) correctly cost $0 rather
    // than guessing.
    const usd = computeCostUsd(this.model, promptTokens, completionTokens);
    const latency_ms = Date.now() - t0;

    log.info({ latency_ms, tokens_in: promptTokens, tokens_out: completionTokens, usd }, 'openai-compatible chat ok');

    return {
      text,
      usage: { in: promptTokens, out: completionTokens, usd },
    };
  }

  async health(): Promise<LLMHealth> {
    const t0 = Date.now();
    const body = {
      model: this.model,
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 1,
    };
    try {
      const res = await fetch(this.chatUrl, {
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
}
