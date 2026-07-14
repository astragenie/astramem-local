import type { ChatMsg, ChatOpts, ChatResult, LLMHealth, LLMProvider } from '../../contracts/llm.js';
import { computeCostUsd } from './pricing.js';
import { TransientError, DeterministicError } from '../../pipeline/errors.js';
import { childLogger } from '../../log/logger.js';
import { isReasoningModel } from './reasoning-model.js';
import { parseRetryAfterMs } from './retry-after.js';

const CHAT_TIMEOUT_MS = 60_000;
const HEALTH_TIMEOUT_MS = 15_000;

export interface AzureOpenAILLMConfig {
  endpoint: string;
  deployment: string;
  apiKey: string;
  apiVersion?: string;
  model?: string;
}

// Re-exported for existing callers/tests importing from this module. Canonical
// definition + detection rationale live in reasoning-model.ts, shared with
// openai-compatible.ts (both speak the classic Chat Completions wire shape).
// The check runs against `this.model`, which defaults to the Azure deployment
// name when no explicit `model` override is passed to the constructor — so a
// deployment whose name doesn't start with one of the matched prefixes (e.g. a
// custom deployment name for an o-series model) must pass `model` explicitly
// for detection to work.
export { isReasoningModel } from './reasoning-model.js';

interface AzureChatResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
  error?: { message?: string };
}

/**
 * Combines a caller-supplied cancellation signal with a fixed-duration
 * internal ceiling (issue #261): whichever fires first wins, and the
 * caller's signal is never dropped in favor of the internal one. When no
 * caller signal is passed, behaves exactly like the pre-fix
 * `AbortSignal.timeout(timeoutMs)`.
 */
function combineSignals(timeoutMs: number, externalSignal?: AbortSignal): AbortSignal {
  const ownSignal = AbortSignal.timeout(timeoutMs);
  return externalSignal ? AbortSignal.any([externalSignal, ownSignal]) : ownSignal;
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  externalSignal?: AbortSignal,
): Promise<Response> {
  let lastError: unknown;
  for (let i = 0; i < 2; i++) {
    try {
      const res = await fetch(url, { ...init, signal: combineSignals(timeoutMs, externalSignal) });
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
    const log = childLogger({ provider: this.name, model: this.model });
    const t0 = Date.now();
    // JSON must be OPT-IN, not the default (fixed 2026-07-13).
    //
    // `?? true` forced `response_format: json_object` onto EVERY call — including
    // compaction (04-compact.ts:77), which is a prose summariser: it passes no `json`
    // flag and returns `result.text.trim()` verbatim. Azure then rejects it:
    //
    //   HTTP 400 — 'messages' must contain the word 'json' in some form,
    //              to use 'response_format' of type 'json_object'.
    //
    // Result: EVERY distill job poisoned. The azure-openai provider has never worked for
    // the distill pipeline. It went unnoticed because Ollama does not enforce that rule,
    // and everyone runs Ollama locally — the bug is invisible on the default path and
    // fatal on the cloud one. Found 2026-07-13 by actually running a LoCoMo arm on Azure:
    // 19/19 distill jobs poisoned, 0 memories stored.
    //
    // Every genuine JSON caller passes `json: true` explicitly (05-extract,
    // contradiction-judge, extract-entities, tier2-infer), so opt-in is safe.
    const useJson = opts?.json === true;

    // Belt-and-braces, mirroring the codex-subscription provider's existing guard
    // (codex-subscription.ts:490): if JSON is requested but no message actually contains
    // the word, Azure 400s. Append a minimal hint rather than fail.
    const outgoing: ChatMsg[] =
      useJson && !messages.some((m) => /json/i.test(String(m.content)))
        ? messages.map((m, i) =>
            i === messages.length - 1
              ? { role: m.role, content: `${m.content}\n\nRespond with valid JSON only.` }
              : m,
          )
        : messages;
    const reasoning = isReasoningModel(this.model);
    const body = {
      messages: outgoing,
      ...(useJson ? { response_format: { type: 'json_object' } } : {}),
      // Reasoning models (gpt-5*/o-series) reject `temperature` outright —
      // they have no sampling-temperature knob — so it's omitted entirely
      // rather than sent with any value.
      ...(!reasoning && opts?.temperature !== undefined ? { temperature: opts.temperature } : {}),
      // Reasoning models take `max_completion_tokens` instead of
      // `max_tokens` — sending the classic name gets a hard HTTP 400.
      ...(opts?.maxTokens !== undefined
        ? reasoning
          ? { max_completion_tokens: opts.maxTokens }
          : { max_tokens: opts.maxTokens }
        : {}),
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
      opts?.signal,
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
      const latency_ms = Date.now() - t0;
      log.warn({ latency_ms, status: res.status, error_kind: res.status >= 500 || res.status === 429 ? 'TransientError' : 'DeterministicError' }, 'azure-openai chat failed');
      if (res.status >= 500) {
        throw new TransientError(`Azure OpenAI chat failed: HTTP ${res.status} — ${snippet}`, undefined, parseRetryAfterMs(res.headers.get('retry-after')));
      }
      if (res.status === 429) {
        // Azure OpenAI documents Retry-After on 429 rate-limit responses.
        throw new TransientError(`Azure OpenAI chat rate-limited (429): ${snippet}`, undefined, parseRetryAfterMs(res.headers.get('retry-after')));
      }
      throw new DeterministicError(`Azure OpenAI chat failed: HTTP ${res.status} — ${snippet}`);
    }

    const data = (await res.json()) as AzureChatResponse;
    const text = data.choices?.[0]?.message?.content ?? '';
    const promptTokens = data.usage?.prompt_tokens ?? 0;
    const completionTokens = data.usage?.completion_tokens ?? 0;
    const usd = computeCostUsd(this.model, promptTokens, completionTokens);
    const latency_ms = Date.now() - t0;

    log.info({ latency_ms, tokens_in: promptTokens, tokens_out: completionTokens, usd }, 'azure-openai chat ok');

    return {
      text,
      usage: { in: promptTokens, out: completionTokens, usd },
    };
  }

  async health(): Promise<LLMHealth> {
    const t0 = Date.now();
    // Ping with a minimal 1-token completion. Reasoning models reject
    // `max_tokens` (HTTP 400) just like in chat() — same detection, same
    // `max_completion_tokens` substitution.
    const body = {
      messages: [{ role: 'user', content: 'ping' }],
      ...(isReasoningModel(this.model) ? { max_completion_tokens: 1 } : { max_tokens: 1 }),
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
