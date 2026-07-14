/**
 * FEAT-488 — shared provider-contract conformance suite.
 *
 * Runs the SAME assertions across every LLMProvider (src/contracts/llm.ts),
 * table-driven over tests/providers/_llm-provider-adapters.ts. Exists
 * because on 2026-07-13 all three HTTP providers independently wrote
 * `opts?.json ?? true`, forcing structured output onto every call —
 * including compaction (04-compact.ts), a prose summariser that passes no
 * `json` flag. Azure surfaced it as a hard HTTP 400 (19/19 distill jobs
 * poisoned, 0 memories stored); Ollama silently swallowed it, emitting
 * `{}` / `{"tool":"sqlite3"}` where a full rationale belonged — the actual
 * source of the product's trivia-instead-of-explanation memories.
 *
 * The bug survived 2743 green tests because every provider was tested in
 * isolation, and each isolated suite only asserted the POSITIVE case
 * ("sends json format when json:true"). Nothing asserted the NEGATIVE case
 * (no json flag -> no structured-output field), and nothing ran the same
 * assertion across all providers to catch a shared mistake or a divergence
 * between them. This file closes both gaps.
 *
 * All assertions run against the REAL outgoing request bytes each provider
 * emits (via a real fetch mock), never against a wire shape the test author
 * assumes — see the parent CLAUDE.md's "fixture self-delusion" lesson.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ALL_LLM_ADAPTERS } from './_llm-provider-adapters.js';
import { TransientError, DeterministicError } from '../../src/pipeline/errors.js';

// Mirrors 04-compact.ts's COMPACT_SYSTEM call shape: a system + user message
// pair, no `json` opt, expecting plain-text prose back. Deliberately
// contains no substring "json" anywhere, so it also serves as the
// json-opt-in negative-space prompt.
const PROSE_SYSTEM = 'You are a transcript compressor for AI coding agent sessions. Output plain text only.';
const PROSE_USER = 'user: Postgres or SQLite? / assistant: SQLite - the daemon is single-user and local-first.';
const PROSE_MESSAGES = [
  { role: 'system' as const, content: PROSE_SYSTEM },
  { role: 'user' as const, content: PROSE_USER },
];

describe.each(ALL_LLM_ADAPTERS)('LLM provider contract conformance — $name', (adapter) => {
  let restoreFetch: () => void;

  beforeEach(() => {
    const original = globalThis.fetch;
    restoreFetch = () => {
      globalThis.fetch = original;
    };
  });

  afterEach(() => {
    restoreFetch();
  });

  // ── 1. json is OPT-IN ────────────────────────────────────────────────
  it('does NOT request structured output when no json flag is passed (the bug: `?? true`)', async () => {
    let captured: Record<string, unknown> | undefined;
    const provider = adapter.createProvider((req) => {
      captured = req.body;
      return adapter.successResponse('plain prose reply');
    });

    await provider.chat(PROSE_MESSAGES);

    expect(captured).toBeDefined();
    expect(adapter.requestedJson(captured!)).toBe(false);
  });

  // ── 2. json:true is honored ──────────────────────────────────────────
  it('requests structured output when json:true is passed', async () => {
    let captured: Record<string, unknown> | undefined;
    const provider = adapter.createProvider((req) => {
      captured = req.body;
      return adapter.successResponse('{"ok":true}');
    });

    await provider.chat([{ role: 'user', content: 'extract the fact' }], { json: true });

    expect(captured).toBeDefined();
    expect(adapter.requestedJson(captured!)).toBe(true);
  });

  it(
    adapter.appendsJsonHintWhenMissing
      ? 'appends a "json" word hint when json:true and no message already says it'
      : 'does NOT append a "json" word hint (this provider has no such guard)',
    async () => {
      let captured: Record<string, unknown> | undefined;
      const provider = adapter.createProvider((req) => {
        captured = req.body;
        return adapter.successResponse('{"ok":true}');
      });

      await provider.chat([{ role: 'user', content: 'extract the fact' }], { json: true });

      const contents = adapter.outgoingContents(captured!);
      const anyMentionsJson = contents.some((c) => /json/i.test(c));
      expect(anyMentionsJson).toBe(adapter.appendsJsonHintWhenMissing);
    },
  );

  // ── 3. prose round-trip ──────────────────────────────────────────────
  it('a prose prompt with no json flag returns non-empty prose text verbatim, not a JSON object', async () => {
    const proseReply =
      'SQLite - the daemon is single-user and local-first, so a server process would be pure overhead.';
    const provider = adapter.createProvider(() => adapter.successResponse(proseReply));

    const result = await provider.chat(PROSE_MESSAGES);

    expect(result.text.length).toBeGreaterThan(0);
    expect(result.text).toBe(proseReply);
    // This is the exact failure shape the 2026-07-13 bug produced: a
    // forced-JSON call collapses prose into `{}` or a tiny tool-call object.
    // A conformant provider must never do that for a call with no json opt.
    expect(() => JSON.parse(result.text)).toThrow();
  });

  // ── 4. usage/cost mapping ────────────────────────────────────────────
  it('surfaces prompt/completion token counts on ChatResult.usage', async () => {
    const provider = adapter.createProvider(() => adapter.successResponse('hello', 123, 45));

    const result = await provider.chat([{ role: 'user', content: 'hi' }]);

    expect(result.usage.in).toBe(123);
    expect(result.usage.out).toBe(45);
    expect(typeof result.usage.usd).toBe('number');
    expect(result.usage.usd).toBeGreaterThanOrEqual(0);
  });

  // ── 5. error taxonomy ────────────────────────────────────────────────
  it('throws TransientError on HTTP 500', async () => {
    const provider = adapter.createProvider(() => adapter.errorResponse(500, 'internal error'));
    await expect(provider.chat([{ role: 'user', content: 'x' }])).rejects.toBeInstanceOf(TransientError);
  });

  it('throws TransientError on HTTP 429', async () => {
    const provider = adapter.createProvider(() => adapter.errorResponse(429, 'rate limited'));
    await expect(provider.chat([{ role: 'user', content: 'x' }])).rejects.toBeInstanceOf(TransientError);
  });

  it('throws DeterministicError on HTTP 400', async () => {
    const provider = adapter.createProvider(() => adapter.errorResponse(400, 'bad request'));
    await expect(provider.chat([{ role: 'user', content: 'x' }])).rejects.toBeInstanceOf(DeterministicError);
  });

  // ── 6. issue #261: caller-signal cancellation ────────────────────────
  //
  // Before the fix, `ChatOpts.signal` didn't exist — a caller's own timeout
  // budget (e.g. decompose's 800ms, rerank's 300ms) could only ABANDON its
  // promise, never cancel the real HTTP request, which kept running to
  // completion in the background holding the provider's execution slot.
  // This proves each provider actually wires a caller-supplied signal into
  // its outgoing request, combined with (not replacing) its own internal
  // timeout: `capturedSignal` is the signal the mocked `fetch` actually
  // received, and it must become aborted the instant the CALLER's
  // controller aborts — nothing else in this test ever touches it.
  it('issue #261: a caller-supplied AbortSignal cancels the underlying HTTP request', async () => {
    let capturedSignal: AbortSignal | undefined;
    let handlerRanToCompletion = false;
    const provider = adapter.createProvider((req) => {
      capturedSignal = (req.init.signal ?? undefined) as AbortSignal | undefined;
      return new Promise<Response>((resolve, reject) => {
        const abortErr = () => new DOMException('The operation was aborted', 'AbortError');
        // Some providers' fetchWithRetry retries once on any rejected
        // attempt (including an abort), which re-invokes this responder with
        // an ALREADY-aborted combined signal — mirror real fetch() here
        // (which rejects synchronously for an already-aborted signal) rather
        // than adding a listener for an 'abort' event that already fired.
        if (capturedSignal?.aborted) {
          reject(abortErr());
          return;
        }
        const t = setTimeout(() => {
          handlerRanToCompletion = true;
          resolve(adapter.successResponse('too late'));
        }, 5_000);
        capturedSignal?.addEventListener('abort', () => {
          clearTimeout(t);
          reject(abortErr());
        });
      });
    });

    const controller = new AbortController();
    const chatPromise = provider.chat([{ role: 'user', content: 'hi' }], { signal: controller.signal });
    controller.abort();

    await expect(chatPromise).rejects.toThrow();
    expect(capturedSignal?.aborted).toBe(true);
    expect(handlerRanToCompletion).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Reasoning-model (o-series/gpt-5*) parameter handling.
//
// Only providers speaking the classic OpenAI Chat Completions wire shape
// (azure-openai, openai-compatible — see `reasoningParams` on the adapter)
// are subject to this: reasoning models hard-400 on `temperature` and on
// `max_tokens` (they require `max_completion_tokens` instead). This is the
// third instance of the same drift pattern the json-opt-in bug above
// documents: azure-openai got a fix for this, openai-compatible didn't,
// until this suite closed the gap. Ollama and codex-subscription are
// excluded (no `reasoningParams`) because their wire shapes don't have this
// rejection rule at all.
// ─────────────────────────────────────────────────────────────────────────
const REASONING_PARAM_ADAPTERS = ALL_LLM_ADAPTERS.filter((a) => a.reasoningParams);

describe.each(REASONING_PARAM_ADAPTERS)(
  'LLM provider contract conformance — reasoning-model params — $name',
  (adapter) => {
    const rp = adapter.reasoningParams!;

    it('omits temperature and sends max_completion_tokens (not max_tokens) for a reasoning model (gpt-5-mini)', async () => {
      let captured: Record<string, unknown> | undefined;
      const provider = rp.createProviderWithModel('gpt-5-mini', (req) => {
        captured = req.body;
        return adapter.successResponse('ok');
      });

      await provider.chat([{ role: 'user', content: 'x' }], { temperature: 0.7, maxTokens: 256 });

      expect(captured).toBeDefined();
      expect(rp.maxCompletionTokens(captured!)).toBe(256);
      expect(rp.maxTokens(captured!)).toBeUndefined();
      expect(rp.temperature(captured!)).toBeUndefined();
    });

    it('keeps temperature and max_tokens unchanged for a non-reasoning model (gpt-4.1)', async () => {
      let captured: Record<string, unknown> | undefined;
      const provider = rp.createProviderWithModel('gpt-4.1', (req) => {
        captured = req.body;
        return adapter.successResponse('ok');
      });

      await provider.chat([{ role: 'user', content: 'x' }], { temperature: 0.7, maxTokens: 256 });

      expect(captured).toBeDefined();
      expect(rp.maxTokens(captured!)).toBe(256);
      expect(rp.temperature(captured!)).toBe(0.7);
      expect(rp.maxCompletionTokens(captured!)).toBeUndefined();
    });

    it('health() pings a reasoning model with max_completion_tokens instead of max_tokens', async () => {
      let captured: Record<string, unknown> | undefined;
      const provider = rp.createProviderWithModel('gpt-5-mini', (req) => {
        captured = req.body;
        return adapter.successResponse('pong', 1, 1);
      });

      const h = await provider.health();

      expect(h.ok).toBe(true);
      expect(captured).toBeDefined();
      expect(rp.maxCompletionTokens(captured!)).toBe(1);
      expect(rp.maxTokens(captured!)).toBeUndefined();
    });
  },
);

// ─────────────────────────────────────────────────────────────────────────
// Live tier — a couple of tiny prompts against a REAL Ollama host only.
// Skips (not fails) when unreachable, per contradiction-e2e.test.ts's
// pattern: a skipped honest test beats a passing dishonest one. Ollama was
// reported saturated by a concurrent LoCoMo eval at suite-authoring time, so
// this stays deliberately tiny — two single-word-ish prompts, no load test.
// Azure/OpenAI are hermetic-only: hitting them costs real money and uses
// the operator's keys, which is out of scope for a test suite.
// ─────────────────────────────────────────────────────────────────────────
import { OllamaLLMProvider } from '../../src/providers/llm/ollama.js';

const OLLAMA_HOST = process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434';

let ollamaUp = false;
let ollamaModel = 'qwen2.5:7b';

describe('LLM provider contract conformance — live (ollama only)', () => {
  beforeEach(async () => {
    try {
      const r = await fetch(`${OLLAMA_HOST}/api/tags`, { signal: AbortSignal.timeout(3000) });
      ollamaUp = r.ok;
      if (ollamaUp) {
        const data = (await r.json()) as { models?: Array<{ name: string }> };
        const first = data.models?.[0]?.name;
        if (first) ollamaModel = first;
      }
    } catch {
      ollamaUp = false;
    }
  });

  it('a real prose call with no json flag returns prose, not JSON (live, the exact bug shape)', async () => {
    if (!ollamaUp) {
      console.warn('SKIPPED — Ollama unreachable at ' + OLLAMA_HOST + '. This test is worthless without a real model.');
      return;
    }
    const provider = new OllamaLLMProvider({ model: ollamaModel });
    const result = await provider.chat([
      { role: 'system', content: 'Reply with one short plain-text sentence. No JSON, no markdown.' },
      { role: 'user', content: 'Say hello in one sentence.' },
    ]);
    expect(result.text.trim().length).toBeGreaterThan(0);
    expect(() => JSON.parse(result.text.trim())).toThrow();
  }, 65_000);

  // Test-level timeout (65s) intentionally exceeds the provider's own
  // internal CHAT_TIMEOUT_MS (60s, ollama.ts) so a genuinely slow-but-alive
  // host under the reported concurrent LoCoMo eval load fails via the
  // provider's own TransientError (soft-skipped below), not via vitest's
  // timeout racing it — a saturated host is not the same signal as a broken
  // provider and must not fail this suite.
  it('a real json:true call returns parseable JSON (live)', async () => {
    if (!ollamaUp) {
      console.warn('SKIPPED — Ollama unreachable at ' + OLLAMA_HOST + '.');
      return;
    }
    const provider = new OllamaLLMProvider({ model: ollamaModel });
    let result: { text: string };
    try {
      result = await provider.chat(
        [{ role: 'user', content: 'Respond with JSON: {"ok": true}' }],
        { json: true },
      );
    } catch (err) {
      if (TransientError.is(err)) {
        console.warn('SKIPPED — Ollama call timed out under saturation: ' + (err as Error).message);
        return;
      }
      throw err;
    }
    expect(() => JSON.parse(result.text)).not.toThrow();
  }, 65_000);
});
