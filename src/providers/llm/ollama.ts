import type { ChatMsg, ChatOpts, ChatResult, LLMHealth, LLMProvider } from '../../contracts/llm.js';
import { TransientError, DeterministicError } from '../../pipeline/errors.js';
import { childLogger } from '../../log/logger.js';
import { parseRetryAfterMs } from './retry-after.js';

/**
 * Per-chat timeout.
 *
 * WAS 60_000 — hardcoded, and TOO SHORT FOR A LOCAL MODEL ON A REAL CHUNK.
 *
 * Measured 2026-07-13: qwen3.5:4b extracting from a real 2029-char LoCoMo chunk
 * generates ~1200 tokens and takes well over a minute on an 8 GB laptop GPU. Every
 * such call aborted at 60s. The observable was `last_error: "The operation was
 * aborted due to timeout"` and — far worse — ZERO ATOMS with the job still marked
 * completed. A timeout produced a zero indistinguishable from "the model found
 * nothing" (ADR-015, again).
 *
 * It had been hidden by stage-4 compaction, which shrank the input enough that the
 * call squeaked in under 60s. Skipping compaction (which recovers facts — see
 * 04-compact.ts) made the input bigger and exposed a limit that was always wrong
 * for local inference.
 *
 * 60s is a CLOUD timeout applied to LOCAL hardware. A 4B model on a laptop GPU is
 * not a network call; it is compute, and it is allowed to take minutes. Cloud
 * providers have their own timeouts and are unaffected by this constant.
 *
 * Override with `ASTRA_OLLAMA_CHAT_TIMEOUT_MS` — a slower box (or a bigger model,
 * or a CPU-only host) legitimately needs more, and no operator should have to
 * recompile to get it.
 */
const CHAT_TIMEOUT_MS = Number(process.env.ASTRA_OLLAMA_CHAT_TIMEOUT_MS ?? 300_000);
const HEALTH_TIMEOUT_MS = 10_000;

// FEAT-479 (SLICE-433 review fix, HIGH): mirrors src/distill/stages/03-chunk.ts:12's
// CHARS_PER_TOKEN heuristic (not imported — that module belongs to the distill layer,
// this one is a generic provider, and the constant is a one-line rough estimate, not a
// shared contract). Used only to size num_ctx below.
export const CHARS_PER_TOKEN = 4;
/** Ollama's own observed per-model default on this box; never shrink num_ctx below it. */
export const NUM_CTX_FLOOR = 4096;
/** VRAM guard for a background local daemon — native context on these models goes up to
 * 32K, but an unbounded num_ctx risks claiming more memory than a background process
 * should. 16384 covers the v3 engineering prompt (~3.8k tokens) plus a large chunk plus a
 * generous output budget with room to spare. */
export const NUM_CTX_CAP = 16384;
/** Assumed output budget when the caller passes no `maxTokens` (e.g. health-style tiny
 * calls) — not a real limit, just an estimate input for the num_ctx sizing formula. */
const DEFAULT_OUTPUT_BUDGET_TOKENS = 512;
/** Slack so num_ctx isn't sized to the exact byte, given the char/4 estimate is rough
 * and Ollama's own chat-template wrapping adds a little overhead per message. */
const NUM_CTX_SLACK_TOKENS = 512;

export interface OllamaLLMConfig {
  baseUrl?: string;
  model?: string;
  /** Ollama `think` flag. This provider serves direct-answer extraction and
   *  compaction calls, so every model defaults to `false`. A hand-maintained
   *  model-name list was incomplete by construction; non-thinking models can
   *  safely receive false, while new thinking models must not silently inherit
   *  Ollama's thinking-on default. Explicit true remains available to callers
   *  that genuinely want a reasoning trace. */
  think?: boolean;
  /** Optional per-instance ceiling on the dynamically-sized `num_ctx`,
   *  clamped to [NUM_CTX_FLOOR, NUM_CTX_CAP]. Clerk-seat instances (passB
   *  sweeper, atom-triage, dup-judge) pass 8192: their calls are batched
   *  JSON verdicts over one chunk, never 16k of context, and the smaller KV
   *  cache keeps an ~5.4GB-weights model (ministral-3:8b) fully
   *  GPU-resident on an 8GB card instead of spilling ~11% to CPU (measured
   *  2026-07-18, LoCoMo dual-pass leg). Unset = NUM_CTX_CAP, byte-identical
   *  to prior behavior for every author-seat call path. */
  numCtxCap?: number;
}

interface OllamaChatResponse {
  message?: { content?: string; thinking?: string };
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

interface OllamaTagsResponse {
  models?: Array<{ name: string }>;
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
  const attempt = async (): Promise<Response> => {
    return fetch(url, { ...init, signal: combineSignals(timeoutMs, externalSignal) });
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
  private readonly numCtxCap: number;

  constructor(config: OllamaLLMConfig = {}) {
    this.baseUrl = (config.baseUrl ?? 'http://127.0.0.1:11434').replace(/\/$/, '');
    // Defensive fallback only — every real call path (src/providers/index.ts)
    // passes config.llm.{compaction,extraction}.model explicitly, which
    // defaultConfig() (src/config/config.ts) always supplies, so this only
    // fires for direct/ad-hoc instantiation with no model. Keep in sync with
    // that default by hand (no shared import between this provider and
    // config/config.ts) — was 'qwen3.5:4b' until 2026-07-14, retired for
    // under-extracting atoms (see src/cli/init.ts's DEFAULT_OLLAMA_LLM_MODEL
    // comment); before that 'qwen3:8b' until 2026-07-13, which doesn't fit
    // this hardware class's VRAM ceiling; see CLAUDE.md's "Ollama 8GB VRAM
    // ceiling" note.
    this.model = config.model ?? 'qwen2.5:7b';
    // Direct-answer provider: reasoning requires explicit opt-in.
    this.think = config.think ?? false;
    // Clamp so a misconfigured cap can neither exceed the VRAM guard nor
    // shrink below Ollama's own per-model default (see NUM_CTX_FLOOR).
    this.numCtxCap = Math.min(NUM_CTX_CAP, Math.max(NUM_CTX_FLOOR, config.numCtxCap ?? NUM_CTX_CAP));
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
      this.numCtxCap,
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

    // FEAT-261: a schema, when supplied, constrains the actual JSON shape —
    // `format: 'json'` alone only guarantees valid JSON, not a particular
    // top-level type (see ChatOpts.jsonSchema doc comment).
    const body = {
      model: this.model,
      messages,
      stream: false,
      ...(useJson ? { format: opts?.jsonSchema ?? 'json' } : {}),
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
      opts?.signal,
    );

    if (!res.ok) {
      const rawBody = await res.text().catch(() => '');
      const snippet = rawBody.slice(0, 200);
      const latency_ms = Date.now() - t0;
      log.warn({ latency_ms, status: res.status, error_kind: res.status >= 500 ? 'TransientError' : 'DeterministicError' }, 'ollama chat failed');
      if (res.status >= 500) {
        throw new TransientError(`Ollama chat failed: HTTP ${res.status} — ${snippet}`, undefined, parseRetryAfterMs(res.headers.get('retry-after')));
      }
      if (res.status === 429) {
        // Ollama is a local, unauthenticated single-model server — it has no
        // documented rate-limit behavior and is not observed to send this
        // header in practice. Parsed defensively for consistency with the
        // other 3 providers; almost always resolves to undefined here.
        throw new TransientError(`Ollama chat rate-limited (429): ${snippet}`, undefined, parseRetryAfterMs(res.headers.get('retry-after')));
      }
      throw new DeterministicError(`Ollama chat failed: HTTP ${res.status} — ${snippet}`);
    }

    const data = (await res.json()) as OllamaChatResponse;
    const text = data.message?.content ?? '';
    const inTokens = data.prompt_eval_count ?? 0;
    const outTokens = data.eval_count ?? 0;
    const latency_ms = Date.now() - t0;

    // Schema-constrained decoding cannot close a JSON object after Ollama
    // stops at num_predict. Do not hand a known-partial document to salvage
    // or parsing; the worker must retry with a smaller chunk/larger budget.
    if (data.done_reason === 'length') {
      log.warn({ latency_ms, tokens_out: outTokens }, 'ollama chat stopped at token limit');
      throw new TransientError(
        `Ollama stopped generation at the token limit for model "${this.model}"; response may be incomplete`,
      );
    }

    // Loud-failure guard (see OllamaLLMConfig.think doc comment above): under
    // format:json, an empty message.content is NEVER a legitimate answer —
    // the shortest possible valid JSON is 2 characters ("{}"), so a
    // zero-length content string can only mean the model produced nothing
    // parseable. The most common cause is a hybrid-reasoning model that
    // consumed its whole output budget on message.thinking and left none for
    // message.content. This check fires for ANY model, so an endpoint that
    // ignores think:false fails loud on its very first call instead of
    // falling through to 05-extract.ts's generic "Zod/JSON parse failed —
    // raw: " (empty, since raw IS empty) — a message with zero diagnostic
    // content that is indistinguishable from a stochastic one-off glitch.
    if (useJson && text.trim().length === 0) {
      const thinkingChars = data.message?.thinking?.length ?? 0;
      const detail = thinkingChars > 0
        ? `message.thinking held ${thinkingChars} chars while message.content was empty — the classic hybrid-reasoning/format:json conflict`
        : 'message.thinking was also empty, so this is not that known signature — but an empty format:json response is never legitimate either way';
      log.warn(
        { latency_ms, model: this.model, thinking_chars: thinkingChars, think_option: this.think },
        'ollama chat: empty content under format:json',
      );
      throw new TransientError(
        `Ollama returned empty message.content under format:json for model "${this.model}" (${detail}). ` +
        `The provider sends think:false by default; verify that this model/runtime honors it.`,
      );
    }

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
