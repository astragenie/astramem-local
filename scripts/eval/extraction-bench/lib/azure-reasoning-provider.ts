/**
 * LLMProvider adapter for Azure OpenAI reasoning models (gpt-5-mini).
 *
 * WHY THIS EXISTS (do not delete without re-reading): the daemon's own
 * src/providers/llm/azure-openai.ts unconditionally sends `temperature` and
 * `max_tokens` on every chat() call (see extract.ts/compact.ts call sites,
 * which always pass `temperature` + `maxTokens`). Verified LIVE against the
 * real deployment (2026-07-08):
 *
 *   curl .../chat/completions -d '{"messages":[...],"temperature":0.1,"max_tokens":50}'
 *   -> HTTP 400 {"error":{"message":"Unsupported parameter: 'max_tokens' is
 *      not supported with this model. Use 'max_completion_tokens' instead.",
 *      "code":"unsupported_parameter"}}
 *
 * gpt-5-mini is a reasoning model: it requires `max_completion_tokens`
 * (not `max_tokens`) and rejects a `temperature` override entirely. This is a
 * genuine pre-existing gap in the daemon's azure-openai provider, not
 * something specific to this benchmark — and it's out of scope to fix here
 * ("no src/ changes"). Practical effect: pointing config.llm.extraction at
 * {provider: azure-openai, model: gpt-5-mini} and driving it through the real
 * HTTP daemon (like the Ollama candidates in daemon-runner.ts) fails on every
 * extract call. This adapter reuses the SAME real prompt/schema/stage code
 * (src/distill/stages/05-extract.ts, src/distill/prompts/extract.ts) via
 * pipeline-direct.ts, just swapping the transport for one that speaks
 * gpt-5-mini's actual API shape — everything else (redaction, cleanup,
 * normalize, chunk, extract prompt, reduce, memory-normalize) is the
 * identical production code path.
 *
 * Reuses lib/azure-client.ts's azureChatComplete (already correct: no
 * temperature, max_completion_tokens, reasoning_effort) from the longmemeval
 * harness rather than re-deriving it.
 */
import type { ChatMsg, ChatOpts, ChatResult, LLMHealth, LLMProvider } from '../../../../src/contracts/llm.js';
import { azureChatComplete } from '../../shared/azure-client.js';
import type { AzureConfig } from '../../shared/config.js';

// Public Azure pricing for gpt-5-mini (medium), verified 2026-07-08 via
// Helicone / Artificial Analysis pricing pages: $0.25 / 1M input tokens,
// $2.00 / 1M output tokens. Not in src/providers/llm/pricing.ts (that table
// only has gpt-4.1/gpt-4o family placeholders) — kept local to this bench
// rather than touching src/.
const GPT_5_MINI_IN_PER_1M_USD = 0.25;
const GPT_5_MINI_OUT_PER_1M_USD = 2.0;

/** Rough token estimate for cases the API doesn't return usage (shouldn't
 *  happen on a successful call, but keeps cost reporting non-fatal). */
function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

export class AzureReasoningLLMProvider implements LLMProvider {
  readonly name = 'azure-openai' as const;
  readonly model: string;
  private readonly cfg: AzureConfig;
  private readonly reasoningEffort: 'minimal' | 'low' | 'medium' | 'high';
  private readonly maxCompletionTokens: number;

  constructor(opts: { cfg: AzureConfig; model?: string; reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high'; maxCompletionTokens?: number }) {
    this.cfg = opts.cfg;
    this.model = opts.model ?? opts.cfg.answererDeployment;
    this.reasoningEffort = opts.reasoningEffort ?? 'minimal';
    this.maxCompletionTokens = opts.maxCompletionTokens ?? 2000;
  }

  async chat(messages: ChatMsg[], opts?: ChatOpts): Promise<ChatResult> {
    // Deliberately DROP opts.temperature (gpt-5-mini rejects it) and map
    // opts.maxTokens -> max_completion_tokens with a floor, rather than
    // silently ignoring a caller's smaller budget request.
    const maxCompletionTokens = opts?.maxTokens
      ? Math.max(opts.maxTokens, this.maxCompletionTokens)
      : this.maxCompletionTokens;

    const t0 = Date.now();
    const text = await azureChatComplete(this.cfg, {
      messages,
      maxCompletionTokens,
      reasoningEffort: this.reasoningEffort,
      deployment: this.model,
    });
    const latencyMs = Date.now() - t0;

    // azureChatComplete (lib/azure-client.ts) returns plain text, not the raw
    // usage block — estimate tokens from char counts for cost reporting.
    // Good enough for a benchmark cost estimate, not billing-grade.
    const promptChars = messages.reduce((n, m) => n + m.content.length, 0);
    const inTokens = estimateTokens(promptChars);
    const outTokens = estimateTokens(text.length);
    const usd = (inTokens / 1_000_000) * GPT_5_MINI_IN_PER_1M_USD + (outTokens / 1_000_000) * GPT_5_MINI_OUT_PER_1M_USD;

    void latencyMs; // caller (pipeline-direct.ts) times the whole stage itself
    return { text, usage: { in: inTokens, out: outTokens, usd } };
  }

  async health(): Promise<LLMHealth> {
    const t0 = Date.now();
    try {
      await azureChatComplete(this.cfg, {
        messages: [{ role: 'user', content: 'ping' }],
        maxCompletionTokens: 16,
        reasoningEffort: 'minimal',
        deployment: this.model,
      });
      return { ok: true, model: this.model, latency_ms: Date.now() - t0 };
    } catch (err) {
      return { ok: false, model: this.model, latency_ms: Date.now() - t0, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
