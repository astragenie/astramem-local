import type { ChatMsg, ChatOpts, ChatResult, LLMHealth, LLMProvider } from '../../contracts/llm.js';
import { computeCostUsd } from './pricing.js';
import { TransientError, DeterministicError } from '../../pipeline/errors.js';

const CHAT_TIMEOUT_MS = 60_000;
const HEALTH_TIMEOUT_MS = 15_000;

export interface AzureOpenAILLMConfig {
  endpoint: string;
  deployment: string;
  apiKey: string;
  apiVersion?: string;
  model?: string;
}

interface AzureChatResponse {
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
        lastError = new Error(`HTTP ${res.status} from Azure`);
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

export class AzureOpenAILLMProvider implements LLMProvider {
  readonly name = 'azure-openai' as const;
  readonly model: string;
  private readonly endpoint: string;
  private readonly deployment: string;
  private readonly apiKey: string;
  private readonly apiVersion: string;

  constructor(config: AzureOpenAILLMConfig) {
    this.endpoint = config.endpoint.replace(/\/$/, '');
    this.deployment = config.deployment;
    this.apiKey = config.apiKey;
    this.apiVersion = config.apiVersion ?? '2024-10-21';
    // model name used for pricing lookup; defaults to deployment name
    this.model = config.model ?? config.deployment;
  }

  private get chatUrl(): string {
    return `${this.endpoint}/openai/deployments/${this.deployment}/chat/completions?api-version=${this.apiVersion}`;
  }

  async chat(messages: ChatMsg[], opts?: ChatOpts): Promise<ChatResult> {
    const useJson = opts?.json ?? true;
    const body = {
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
          'api-key': this.apiKey,
        },
        body: JSON.stringify(body),
      },
      CHAT_TIMEOUT_MS,
    );

    if (!res.ok) {
      const raw = await res.text().catch(() => '');
      let detail = raw;
      try {
        const parsed = JSON.parse(raw) as AzureChatResponse;
        detail = parsed.error?.message ?? raw;
      } catch {
        // leave as raw text
      }
      const snippet = detail.slice(0, 200);
      if (res.status >= 500) {
        throw new TransientError(`Azure OpenAI chat failed: HTTP ${res.status} — ${snippet}`);
      }
      if (res.status === 429) {
        throw new TransientError(`Azure OpenAI chat rate-limited (429): ${snippet}`);
      }
      throw new DeterministicError(`Azure OpenAI chat failed: HTTP ${res.status} — ${snippet}`);
    }

    const data = (await res.json()) as AzureChatResponse;
    const text = data.choices?.[0]?.message?.content ?? '';
    const promptTokens = data.usage?.prompt_tokens ?? 0;
    const completionTokens = data.usage?.completion_tokens ?? 0;
    const usd = computeCostUsd(this.model, promptTokens, completionTokens);

    return {
      text,
      usage: { in: promptTokens, out: completionTokens, usd },
    };
  }

  async health(): Promise<LLMHealth> {
    const t0 = Date.now();
    // Ping with a minimal 1-token completion
    const body = {
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 1,
    };
    try {
      const res = await fetch(this.chatUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'api-key': this.apiKey,
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
