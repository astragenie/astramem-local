import type { ChatMsg, ChatOpts, ChatResult, LLMHealth, LLMProvider } from '../../contracts/llm.js';
import { TransientError, DeterministicError } from '../../pipeline/errors.js';
import { childLogger } from '../../log/logger.js';

const CHAT_TIMEOUT_MS = 60_000;
const HEALTH_TIMEOUT_MS = 10_000;

export interface OllamaLLMConfig {
  baseUrl?: string;
  model?: string;
}

interface OllamaChatResponse {
  message?: { content?: string };
  prompt_eval_count?: number;
  eval_count?: number;
}

interface OllamaTagsResponse {
  models?: Array<{ name: string }>;
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const attempt = async (): Promise<Response> => {
    return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  };

  let lastError: unknown;
  for (let i = 0; i < 2; i++) {
    try {
      const res = await attempt();
      // No retry on 4xx
      if (res.status >= 400 && res.status < 500) return res;
      // Retry on 5xx (only if first attempt)
      if (res.status >= 500 && i === 0) {
        lastError = new Error(`HTTP ${res.status} from ${url}`);
        continue;
      }
      return res;
    } catch (err) {
      // Network error or timeout — retry once
      if (i === 0) {
        lastError = err;
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

export class OllamaLLMProvider implements LLMProvider {
  readonly name = 'ollama' as const;
  readonly model: string;
  private readonly baseUrl: string;

  constructor(config: OllamaLLMConfig = {}) {
    this.baseUrl = (config.baseUrl ?? 'http://127.0.0.1:11434').replace(/\/$/, '');
    this.model = config.model ?? 'qwen2.5-coder:7b';
  }

  async chat(messages: ChatMsg[], opts?: ChatOpts): Promise<ChatResult> {
    const log = childLogger({ provider: this.name, model: this.model });
    const t0 = Date.now();
    const useJson = opts?.json ?? true;
    const body = {
      model: this.model,
      messages,
      stream: false,
      ...(useJson ? { format: 'json' } : {}),
      ...(opts?.temperature !== undefined ? { options: { temperature: opts.temperature } } : {}),
      ...(opts?.maxTokens !== undefined ? { options: { num_predict: opts.maxTokens } } : {}),
    };

    const res = await fetchWithRetry(
      `${this.baseUrl}/api/chat`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
      CHAT_TIMEOUT_MS,
    );

    if (!res.ok) {
      const rawBody = await res.text().catch(() => '');
      const snippet = rawBody.slice(0, 200);
      const latency_ms = Date.now() - t0;
      log.warn({ latency_ms, status: res.status, error_kind: res.status >= 500 ? 'TransientError' : 'DeterministicError' }, 'ollama chat failed');
      if (res.status >= 500) {
        throw new TransientError(`Ollama chat failed: HTTP ${res.status} — ${snippet}`);
      }
      if (res.status === 429) {
        throw new TransientError(`Ollama chat rate-limited (429): ${snippet}`);
      }
      throw new DeterministicError(`Ollama chat failed: HTTP ${res.status} — ${snippet}`);
    }

    const data = (await res.json()) as OllamaChatResponse;
    const text = data.message?.content ?? '';
    const inTokens = data.prompt_eval_count ?? 0;
    const outTokens = data.eval_count ?? 0;
    const latency_ms = Date.now() - t0;

    log.info({ latency_ms, tokens_in: inTokens, tokens_out: outTokens, usd: 0 }, 'ollama chat ok');

    return {
      text,
      usage: { in: inTokens, out: outTokens, usd: 0 },
    };
  }

  async health(): Promise<LLMHealth> {
    const t0 = Date.now();
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      });
      const latency_ms = Date.now() - t0;
      if (!res.ok) {
        return { ok: false, model: this.model, latency_ms, error: `HTTP ${res.status}` };
      }
      const data = (await res.json()) as OllamaTagsResponse;
      const models = data.models ?? [];
      const found = models.some(
        (m) => m.name === this.model || m.name.startsWith(`${this.model}:`),
      );
      return {
        ok: found,
        model: this.model,
        latency_ms,
        ...(found ? {} : { error: `model ${this.model} not found in ollama list` }),
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
