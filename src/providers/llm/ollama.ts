import type { ChatMsg, ChatOpts, ChatResult, LLMHealth, LLMProvider } from '../../contracts/llm.js';
import { TransientError, DeterministicError } from '../../pipeline/errors.js';
import { childLogger } from '../../log/logger.js';

const CHAT_TIMEOUT_MS = 60_000;
const HEALTH_TIMEOUT_MS = 10_000;

// FEAT-479 (SLICE-433 review fix, HIGH): mirrors src/distill/stages/03-chunk.ts:12's
// CHARS_PER_TOKEN heuristic (not imported — that module belongs to the distill layer,
// this one is a generic provider, and the constant is a one-line rough estimate, not a
// shared contract). Used only to size num_ctx below.
const CHARS_PER_TOKEN = 4;
/** Ollama's own observed per-model default on this box; never shrink num_ctx below it. */
const NUM_CTX_FLOOR = 4096;
/** VRAM guard for a background local daemon — native context on these models goes up to
 * 32K, but an unbounded num_ctx risks claiming more memory than a background process
 * should. 16384 covers the v3 engineering prompt (~3.8k tokens) plus a large chunk plus a
 * generous output budget with room to spare. */
const NUM_CTX_CAP = 16384;
/** Assumed output budget when the caller passes no `maxTokens` (e.g. health-style tiny
 * calls) — not a real limit, just an estimate input for the num_ctx sizing formula. */
const DEFAULT_OUTPUT_BUDGET_TOKENS = 512;
/** Slack so num_ctx isn't sized to the exact byte, given the char/4 estimate is rough
 * and Ollama's own chat-template wrapping adds a little overhead per message. */
const NUM_CTX_SLACK_TOKENS = 512;

export interface OllamaLLMConfig {
  baseUrl?: string;
  model?: string;
  /** Ollama `think` flag for hybrid reasoning models (qwen3, deepseek-r1, …).
   *  Left undefined -> ollama's per-model default (thinking ON for qwen3),
   *  which conflicts with `format:json` extraction (reasoning consumes the
   *  turn and `message.content` comes back empty -> parse fail/poison). We
   *  therefore default it to `false` for qwen3* below. Set explicitly to
   *  override. */
  think?: boolean;
}

interface OllamaChatResponse {
  message?: { content?: string; thinking?: string };
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
  private readonly think?: boolean;

  constructor(config: OllamaLLMConfig = {}) {
    this.baseUrl = (config.baseUrl ?? 'http://127.0.0.1:11434').replace(/\/$/, '');
    this.model = config.model ?? 'qwen3:8b';
    // Disable thinking for qwen3* by default (see OllamaLLMConfig.think) so
    // structured `format:json` extraction gets JSON in message.content instead
    // of an empty body. Explicit config.think wins.
    this.think = config.think ?? (/^qwen3/i.test(this.model) ? false : undefined);
  }

  async chat(messages: ChatMsg[], opts?: ChatOpts): Promise<ChatResult> {
    const log = childLogger({ provider: this.name, model: this.model });
    const t0 = Date.now();
    // JSON must be OPT-IN, not the default (fixed 2026-07-13).
    //
    // `?? true` forced Ollama's `format: json` onto EVERY call — including COMPACTION
    // (04-compact.ts), a PROSE transcript-compressor that passes no `json` flag and
    // returns `result.text.trim()` verbatim into the extraction stage.
    //
    // Measured, with the real COMPACT_SYSTEM prompt and this transcript:
    //   "user: Postgres or SQLite? / assistant: SQLite — the daemon is single-user and
    //    local-first, so a server process would be pure overhead. Tradeoff: no
    //    concurrent writers."
    //
    // What compaction actually emitted, and what extraction actually received:
    //   {"tool": "sqlite3"}                              <- 11 tokens. ALL REASONING GONE.
    //
    // Extraction then dutifully produced "Use SQLite instead of Postgres." — the exact
    // context-free trivia the operator has been complaining about. The rationale was
    // destroyed one stage BEFORE extraction ever saw the transcript.
    //
    // This is also the likely source of INVERTED memories in the live store (e.g. a
    // safety rule "NEVER kill processes by image name" stored as "...use taskkill /F /IM
    // node.exe"): a compactor forced to emit JSON, or a code model asked to compress
    // prose, does not compress — it confabulates.
    //
    // Every genuine JSON caller passes `json: true` explicitly (05-extract,
    // contradiction-judge, extract-entities, tier2-infer), so opt-in is safe.
    const useJson = opts?.json === true;

    // FEAT-479 (SLICE-433 review fix, HIGH): num_ctx was never set anywhere in this
    // provider, so every call ran at Ollama's per-model default (observed 4096 for
    // qwen2.5:7b on this box). The v3 engineering extraction prompt alone is ~3.8k
    // tokens — with a chunk and maxTokens on top, that overflowed the default window,
    // and Ollama's overflow behavior is to silently truncate/shift context rather than
    // error, which is indistinguishable from the model just producing a thinner result
    // (this is what the builder's own v1-vs-v3 smoke test actually hit: 3 atoms
    // collapsed to 1). Size num_ctx dynamically per call — estimated input tokens
    // (chars/4, see CHARS_PER_TOKEN above) + the requested output budget + slack —
    // rather than hardcoding a number that only happens to cover today's prompt.
    const estimatedInputTokens = messages.reduce((sum, m) => sum + m.content.length, 0) / CHARS_PER_TOKEN;
    const outputBudgetTokens = opts?.maxTokens ?? DEFAULT_OUTPUT_BUDGET_TOKENS;
    const numCtx = Math.min(
      NUM_CTX_CAP,
      Math.max(NUM_CTX_FLOOR, Math.ceil(estimatedInputTokens + outputBudgetTokens + NUM_CTX_SLACK_TOKENS)),
    );

    // Single options object, built once — a prior version of this code spread
    // `{ options: {...} }` twice (once for temperature, once for num_predict), and a
    // second top-level spread of the SAME key fully replaces the first rather than
    // merging, so `temperature` was silently dropped on every call that also passed
    // `maxTokens` (i.e. every real extraction/compaction/entity call in production —
    // all three always pass both). Fixed by merging into one object.
    const options: Record<string, number> = { num_ctx: numCtx };
    if (opts?.temperature !== undefined) options.temperature = opts.temperature;
    if (opts?.maxTokens !== undefined) options.num_predict = opts.maxTokens;

    const body = {
      model: this.model,
      messages,
      stream: false,
      ...(useJson ? { format: 'json' } : {}),
      ...(this.think !== undefined ? { think: this.think } : {}),
      options,
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
