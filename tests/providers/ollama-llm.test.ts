import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OllamaLLMProvider } from '../../src/providers/llm/ollama.js';
import { TransientError } from '../../src/pipeline/errors.js';
import { runLLMContractSuite } from './_contract-suite.js';
import { LIVE_MODEL_TESTS_DISABLED } from '../helpers/live-model-gate.js';

// ---------------------------------------------------------------------------
// Fetch mock helpers
// ---------------------------------------------------------------------------
function mockFetch(responses: Array<{ status: number; body: unknown }>) {
  let callIdx = 0;
  return vi.fn(async (_url: unknown, _init?: unknown): Promise<Response> => {
    const resp = responses[callIdx] ?? responses.at(-1)!;
    callIdx++;
    const bodyStr = JSON.stringify(resp.body);
    return new Response(bodyStr, {
      status: resp.status,
      headers: { 'content-type': 'application/json' },
    });
  });
}

function chatResponse(content: string, promptTokens = 10, evalTokens = 5) {
  return {
    status: 200,
    body: {
      message: { role: 'assistant', content },
      prompt_eval_count: promptTokens,
      eval_count: evalTokens,
    },
  };
}

/** Same as chatResponse, but with a non-empty message.thinking field — the
 * shape a hybrid-reasoning model sends when it burns its output budget on
 * reasoning and leaves message.content empty (the qwen3 incident shape). */
function thinkingChatResponse(thinking: string, content = '', promptTokens = 10, evalTokens = 5) {
  return {
    status: 200,
    body: {
      message: { role: 'assistant', content, thinking },
      prompt_eval_count: promptTokens,
      eval_count: evalTokens,
    },
  };
}

function tagsResponse(models: string[]) {
  return {
    status: 200,
    body: { models: models.map((name) => ({ name })) },
  };
}

// ---------------------------------------------------------------------------
// Contract suite — uses mocked successful round-trip
// ---------------------------------------------------------------------------
describe('ollama-llm', () => {
  let restoreGlobal: () => void;

  beforeEach(() => {
    const original = globalThis.fetch;
    restoreGlobal = () => { globalThis.fetch = original; };
  });

  afterEach(() => {
    restoreGlobal();
    vi.restoreAllMocks();
  });

  // 2026-07-13 operator standardization — the constructor's `model` fallback
  // had no test asserting it (every other test here passes an explicit
  // model), so a shipped-default swap at src/providers/llm/ollama.ts would
  // silently drift from the shipped default with nothing red. History:
  // qwen3:8b -> qwen3.5:4b (2026-07-13, doesn't fit the 8GB VRAM ceiling) ->
  // qwen2.5:7b (2026-07-14, qwen3.5:4b under-extracted atoms — see
  // CLAUDE.md and src/cli/init.ts's DEFAULT_OLLAMA_LLM_MODEL comment).
  describe('constructor defaults', () => {
    it('falls back to qwen2.5:7b when no model is configured', () => {
      const p = new OllamaLLMProvider({});
      expect(p.model).toBe('qwen2.5:7b');
    });
  });

  runLLMContractSuite('ollama', () => {
    // contract suite calls chat() + health() — wire both up
    const mock = vi.fn(async (url: string): Promise<Response> => {
      if (String(url).includes('/api/tags')) {
        return new Response(JSON.stringify(tagsResponse(['qwen2.5-coder:7b']).body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify(chatResponse('{"result":"ok"}').body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    globalThis.fetch = mock as unknown as typeof fetch;
    return new OllamaLLMProvider({ model: 'qwen2.5-coder:7b' });
  });

  // ---------------------------------------------------------------------------
  // Detailed behaviour tests
  // ---------------------------------------------------------------------------
  describe('chat()', () => {
    it('round-trip returns {text, usage: {in, out, usd:0}}', async () => {
      globalThis.fetch = mockFetch([chatResponse('hello', 20, 8)]) as unknown as typeof fetch;
      const p = new OllamaLLMProvider({ model: 'qwen2.5-coder:7b' });
      const res = await p.chat([{ role: 'user', content: 'hi' }]);
      expect(res.text).toBe('hello');
      expect(res.usage.in).toBe(20);
      expect(res.usage.out).toBe(8);
      expect(res.usage.usd).toBe(0);
    });

    it('sends format:json when json option is true', async () => {
      let captured: unknown;
      globalThis.fetch = vi.fn(async (_url: unknown, init?: unknown) => {
        captured = JSON.parse((init as RequestInit).body as string);
        return new Response(JSON.stringify(chatResponse('{}').body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as unknown as typeof fetch;

      const p = new OllamaLLMProvider({ model: 'test-model' });
      await p.chat([{ role: 'user', content: 'x' }], { json: true });
      expect((captured as Record<string, unknown>).format).toBe('json');
    });

    it('throws on 4xx without retry', async () => {
      let callCount = 0;
      globalThis.fetch = vi.fn(async () => {
        callCount++;
        return new Response(JSON.stringify({ error: 'bad' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        });
      }) as unknown as typeof fetch;

      const p = new OllamaLLMProvider({ model: 'test-model' });
      await expect(p.chat([{ role: 'user', content: 'x' }])).rejects.toThrow(/HTTP 400/);
      expect(callCount).toBe(1); // no retry
    });

    it('retries once on 5xx then throws', async () => {
      let callCount = 0;
      globalThis.fetch = vi.fn(async () => {
        callCount++;
        return new Response('internal error', { status: 500 });
      }) as unknown as typeof fetch;

      const p = new OllamaLLMProvider({ model: 'test-model' });
      await expect(p.chat([{ role: 'user', content: 'x' }])).rejects.toThrow();
      expect(callCount).toBe(2); // retried once
    });

    it('retries once on network error then throws', async () => {
      let callCount = 0;
      globalThis.fetch = vi.fn(async () => {
        callCount++;
        throw new Error('ECONNREFUSED');
      }) as unknown as typeof fetch;

      const p = new OllamaLLMProvider({ model: 'test-model' });
      await expect(p.chat([{ role: 'user', content: 'x' }])).rejects.toThrow('ECONNREFUSED');
      expect(callCount).toBe(2);
    });

    it('succeeds on retry when first call is 5xx', async () => {
      let callCount = 0;
      globalThis.fetch = vi.fn(async () => {
        callCount++;
        if (callCount === 1) return new Response('error', { status: 500 });
        return new Response(JSON.stringify(chatResponse('ok').body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as unknown as typeof fetch;

      const p = new OllamaLLMProvider({ model: 'test-model' });
      const res = await p.chat([{ role: 'user', content: 'x' }]);
      expect(res.text).toBe('ok');
      expect(callCount).toBe(2);
    });

    // 2026-07-13 — the three OTHER providers (azure-llm, openai-compatible-llm,
    // codex-subscription-llm) each have a test pinning Retry-After -> TransientError
    // .retryAfterMs. Ollama has the identical wiring (parseRetryAfterMs is called on
    // both the 5xx and 429 branches) but had no test proving it — a silent break here
    // would only surface as astramem retrying too fast (or not honoring a server-
    // requested backoff) against a real Ollama instance, never as a red test.
    it('threads a Retry-After header (seconds) from a 429 onto TransientError.retryAfterMs', async () => {
      globalThis.fetch = vi.fn(async () => {
        return new Response(JSON.stringify({ error: 'rate limited' }), {
          status: 429,
          headers: { 'content-type': 'application/json', 'retry-after': '45' },
        });
      }) as unknown as typeof fetch;

      const p = new OllamaLLMProvider({ model: 'test-model' });
      let caught: unknown;
      try {
        await p.chat([{ role: 'user', content: 'x' }]);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(TransientError);
      expect((caught as TransientError).retryAfterMs).toBe(45_000);
    });

    it('leaves retryAfterMs undefined when the 429 response carries no Retry-After header', async () => {
      globalThis.fetch = vi.fn(async () => {
        return new Response(JSON.stringify({ error: 'rate limited' }), {
          status: 429,
          headers: { 'content-type': 'application/json' },
        });
      }) as unknown as typeof fetch;

      const p = new OllamaLLMProvider({ model: 'test-model' });
      let caught: unknown;
      try {
        await p.chat([{ role: 'user', content: 'x' }]);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(TransientError);
      expect((caught as TransientError).retryAfterMs).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // FEAT-479 (SLICE-433 review fix, HIGH): num_ctx was never sent, so every
  // call ran at Ollama's per-model default (observed 4096) — the v3
  // extraction prompt alone (~3.8k tokens) could overflow that with no error
  // surfaced (Ollama silently truncates/shifts context on overflow). These
  // tests pin the dynamic sizing formula: floor at 4096, cap at 16384,
  // scaled to estimated input + requested output + slack in between. Also
  // covers the options-object merge fix (temperature was previously
  // silently dropped whenever maxTokens was also set — see ollama.ts).
  describe('num_ctx sizing', () => {
    async function captureOptions(messages: { role: 'system' | 'user' | 'assistant'; content: string }[], opts?: { temperature?: number; json?: boolean; maxTokens?: number }) {
      let captured: Record<string, unknown> | undefined;
      globalThis.fetch = vi.fn(async (_url: unknown, init?: unknown) => {
        captured = JSON.parse((init as RequestInit).body as string);
        return new Response(JSON.stringify(chatResponse('{}').body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as unknown as typeof fetch;
      const p = new OllamaLLMProvider({ model: 'test-model' });
      await p.chat(messages, opts);
      return captured!.options as Record<string, number>;
    }

    it('floors num_ctx at 4096 for a tiny prompt with no maxTokens', async () => {
      const options = await captureOptions([{ role: 'user', content: 'hi' }]);
      expect(options.num_ctx).toBe(4096);
    });

    it('sizes num_ctx to cover estimated input + maxTokens + slack for a real extraction-shaped call', async () => {
      // ~15,300 chars (roughly the real v3 system prompt's size) + an 800-token chunk's
      // worth of chars, with maxTokens: 2500 — mirrors the real 05-extract.ts call shape.
      const systemContent = 'x'.repeat(15_300);
      const userContent = 'y'.repeat(800 * 4);
      const options = await captureOptions(
        [
          { role: 'system', content: systemContent },
          { role: 'user', content: userContent },
        ],
        { temperature: 0.1, json: true, maxTokens: 2500 },
      );
      const estimatedInputTokens = (systemContent.length + userContent.length) / 4;
      expect(options.num_ctx).toBeGreaterThanOrEqual(estimatedInputTokens + 2500);
      expect(options.num_ctx).toBeLessThanOrEqual(16384);
    });

    it('caps num_ctx at 16384 for a huge synthetic input', async () => {
      const hugeContent = 'z'.repeat(200_000); // ~50k tokens estimated
      const options = await captureOptions([{ role: 'user', content: hugeContent }], { maxTokens: 4000 });
      expect(options.num_ctx).toBe(16384);
    });

    it('always sends num_ctx even when neither temperature nor maxTokens is set', async () => {
      const options = await captureOptions([{ role: 'user', content: 'hi' }]);
      expect(options.num_ctx).toBeDefined();
    });

    it('merge fix: sends BOTH temperature and num_predict together (previously num_predict silently clobbered temperature)', async () => {
      const options = await captureOptions([{ role: 'user', content: 'hi' }], { temperature: 0.1, maxTokens: 2500 });
      expect(options.temperature).toBe(0.1);
      expect(options.num_predict).toBe(2500);
      expect(options.num_ctx).toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Capability detection: explicit name-prefix list, not a regex (see
  // KNOWN_THINKING_MODEL_PREFIXES in ollama.ts — no reliable capability
  // signal exists from Ollama's API today; ollama/ollama#10966 is open and
  // unresolved). deepseek-r1 previously reproduced the qwen3 incident
  // exactly because the guard was `/^qwen3/i` only.
  // ---------------------------------------------------------------------------
  describe('known thinking models — think:false default', () => {
    async function capturedThinkField(model: string) {
      let captured: Record<string, unknown> | undefined;
      globalThis.fetch = vi.fn(async (_url: unknown, init?: unknown) => {
        captured = JSON.parse((init as RequestInit).body as string);
        return new Response(JSON.stringify(chatResponse('{}').body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as unknown as typeof fetch;
      const p = new OllamaLLMProvider({ model });
      await p.chat([{ role: 'user', content: 'x' }]);
      return captured!.think;
    }

    it('sends think:false for qwen3 (with a tag suffix)', async () => {
      expect(await capturedThinkField('qwen3:8b')).toBe(false);
    });

    it('sends think:false for deepseek-r1 — the model the old /^qwen3/i regex left unhandled', async () => {
      expect(await capturedThinkField('deepseek-r1:32b')).toBe(false);
    });

    it('sends think:false for deepseek-v3.1', async () => {
      expect(await capturedThinkField('deepseek-v3.1:latest')).toBe(false);
    });

    it('sends think:false for gpt-oss', async () => {
      expect(await capturedThinkField('gpt-oss:20b')).toBe(false);
    });

    it('is case-insensitive', async () => {
      expect(await capturedThinkField('DeepSeek-R1:32b')).toBe(false);
    });

    it('omits think entirely for a model not in the known list (per-model Ollama default applies)', async () => {
      expect(await capturedThinkField('qwen2.5-coder:7b')).toBeUndefined();
    });

    it('explicit config.think overrides the known-list default', async () => {
      let captured: Record<string, unknown> | undefined;
      globalThis.fetch = vi.fn(async (_url: unknown, init?: unknown) => {
        captured = JSON.parse((init as RequestInit).body as string);
        return new Response(JSON.stringify(chatResponse('{}').body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as unknown as typeof fetch;
      const p = new OllamaLLMProvider({ model: 'qwen3:8b', think: true });
      await p.chat([{ role: 'user', content: 'x' }]);
      expect(captured!.think).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Loud-failure guard: an empty message.content under format:json is never a
  // legitimate response (minimum valid JSON is 2 chars), so it must not be
  // returned as a silent {text: '', usage} success indistinguishable from a
  // well-formed {"atoms":[]} extraction. This is what protects against a
  // hybrid-reasoning model we haven't added to the name list yet.
  // ---------------------------------------------------------------------------
  describe('empty content under format:json — loud-failure guard', () => {
    it('throws TransientError (not a silent empty success) when content is empty and json:true', async () => {
      globalThis.fetch = mockFetch([chatResponse('')]) as unknown as typeof fetch;
      const p = new OllamaLLMProvider({ model: 'some-unknown-thinking-model' });
      await expect(p.chat([{ role: 'user', content: 'x' }], { json: true })).rejects.toThrow(TransientError);
    });

    it('error message names the model and flags the thinking/content conflict when message.thinking is non-empty', async () => {
      globalThis.fetch = mockFetch([thinkingChatResponse('reasoning about the answer...', '')]) as unknown as typeof fetch;
      const p = new OllamaLLMProvider({ model: 'some-unknown-thinking-model' });
      let caught: unknown;
      try {
        await p.chat([{ role: 'user', content: 'x' }], { json: true });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(TransientError);
      expect((caught as TransientError).message).toMatch(/some-unknown-thinking-model/);
      expect((caught as TransientError).message).toMatch(/hybrid-reasoning/);
    });

    it('does NOT throw for empty content when json is not requested (prose/compaction path is unaffected)', async () => {
      globalThis.fetch = mockFetch([chatResponse('')]) as unknown as typeof fetch;
      const p = new OllamaLLMProvider({ model: 'test-model' });
      const res = await p.chat([{ role: 'user', content: 'x' }]); // no json:true
      expect(res.text).toBe('');
    });

    it('does NOT throw when json:true and content is non-empty, even if thin', async () => {
      globalThis.fetch = mockFetch([chatResponse('{}')]) as unknown as typeof fetch;
      const p = new OllamaLLMProvider({ model: 'test-model' });
      const res = await p.chat([{ role: 'user', content: 'x' }], { json: true });
      expect(res.text).toBe('{}');
    });

    // Break-it-and-watch-it-fail proof (see git history / PR description for
    // the before/after): removing the `useJson && text.trim().length === 0`
    // guard block in ollama.ts's chat() makes this test fail with "resolved
    // instead of rejected" — the empty content is returned as a normal
    // {text: '', usage} success, which is exactly the silent failure mode
    // this slice exists to close.
    it('a model unknown to KNOWN_THINKING_MODEL_PREFIXES still fails loud, not silent', async () => {
      globalThis.fetch = mockFetch([thinkingChatResponse('some hidden reasoning trace', '')]) as unknown as typeof fetch;
      const p = new OllamaLLMProvider({ model: 'brand-new-model-nobody-has-heard-of:4b' });
      await expect(p.chat([{ role: 'user', content: 'x' }], { json: true })).rejects.toThrow(TransientError);
    });
  });

  describe('health()', () => {
    it('returns ok:true when model present in tags', async () => {
      globalThis.fetch = mockFetch([tagsResponse(['qwen2.5-coder:7b', 'llama3'])]) as unknown as typeof fetch;
      const p = new OllamaLLMProvider({ model: 'qwen2.5-coder:7b' });
      const h = await p.health();
      expect(h.ok).toBe(true);
      expect(h.model).toBe('qwen2.5-coder:7b');
      expect(h.latency_ms).toBeGreaterThanOrEqual(0);
      expect(h.error).toBeUndefined();
    });

    it('returns ok:false when model not in tags', async () => {
      globalThis.fetch = mockFetch([tagsResponse(['llama3'])]) as unknown as typeof fetch;
      const p = new OllamaLLMProvider({ model: 'qwen2.5-coder:7b' });
      const h = await p.health();
      expect(h.ok).toBe(false);
      expect(h.error).toMatch(/not found/);
    });

    it('returns ok:false on connection error', async () => {
      globalThis.fetch = vi.fn(async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
      const p = new OllamaLLMProvider({ model: 'qwen2.5-coder:7b' });
      const h = await p.health();
      expect(h.ok).toBe(false);
      expect(h.error).toMatch(/ECONNREFUSED/);
    });
  });

  // ---------------------------------------------------------------------------
  // Live integration (opt-in: INTEGRATION_LIVE=1; ASTRA_MEMORY_MOCK_PROVIDERS=1
  // always wins and forces a skip even if INTEGRATION_LIVE is also set — #251)
  // ---------------------------------------------------------------------------
  describe.skipIf(LIVE_MODEL_TESTS_DISABLED)('live integration', () => {
    // NOT the production default (config.ts) — deliberately, since 2026-07-14
    // (Option A / CPU-runner fix, see nightly-live.yml's "Model policy"
    // comment). `.health()` only hits GET /api/tags and never runs
    // inference, so this only needs SOME model present in the tags list, not
    // the real production LLM default (which is heavier and would gain
    // nothing here since no generation happens). Pinned to a tiny
    // CPU-friendly model instead — must match nightly-live.yml's
    // OLLAMA_MODELS exactly, or this test fails with "model not found in
    // ollama list" against a live daemon. (Every other occurrence in this
    // file is a mocked fixture whose tag is arbitrary and pulls nothing.)
    it('actually calls ollama serve', async () => {
      const p = new OllamaLLMProvider({ model: 'qwen2.5:0.5b' });
      const h = await p.health();
      expect(h.ok).toBe(true);
    }, 10_000);
  });
});
