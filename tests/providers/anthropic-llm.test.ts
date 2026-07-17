import { describe, it, expect, vi, afterEach } from 'vitest';
import { AnthropicLLMProvider } from '../../src/providers/llm/anthropic.js';
import { TransientError, DeterministicError } from '../../src/pipeline/errors.js';
import { runLLMContractSuite } from './_contract-suite.js';

const FAKE_CREDS = {
  apiKey: 'sk-ant-super-secret-do-not-leak-12345',
  model: 'claude-sonnet-4-5-20250929',
};

function textResponse(text: string, inTokens = 10, outTokens = 5) {
  return {
    status: 200,
    body: {
      content: [{ type: 'text', text }],
      usage: { input_tokens: inTokens, output_tokens: outTokens },
    },
  };
}

function toolUseResponse(input: unknown, inTokens = 10, outTokens = 5) {
  return {
    status: 200,
    body: {
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'emit_json', input }],
      usage: { input_tokens: inTokens, output_tokens: outTokens },
    },
  };
}

function mockFetchSequence(responses: Array<{ status: number; body: unknown }>): typeof fetch {
  let idx = 0;
  return vi.fn(async (): Promise<Response> => {
    const resp = responses[idx] ?? responses.at(-1)!;
    idx++;
    return new Response(JSON.stringify(resp.body), {
      status: resp.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

describe('anthropic-llm', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ---------------------------------------------------------------------
  // Contract suite — shared assertions every LLMProvider must satisfy.
  // ---------------------------------------------------------------------
  runLLMContractSuite('anthropic', () => {
    globalThis.fetch = mockFetchSequence(
      Array.from({ length: 10 }, () => textResponse('a plain-text reply')),
    );
    return new AnthropicLLMProvider({ ...FAKE_CREDS });
  });

  describe('chat() — auth + wire shape', () => {
    it('sends x-api-key + anthropic-version headers, never Authorization: Bearer', async () => {
      let captured: RequestInit | undefined;
      globalThis.fetch = vi.fn(async (_url: unknown, init?: unknown) => {
        captured = init as RequestInit;
        return new Response(JSON.stringify(textResponse('hi').body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as unknown as typeof fetch;

      const p = new AnthropicLLMProvider({ ...FAKE_CREDS });
      await p.chat([{ role: 'user', content: 'x' }]);
      const headers = captured?.headers as Record<string, string>;
      expect(headers['x-api-key']).toBe(FAKE_CREDS.apiKey);
      expect(headers['anthropic-version']).toBeTruthy();
      expect(headers['authorization']).toBeUndefined();
    });

    it('posts to /v1/messages with max_tokens always present (defaulted when opts.maxTokens is unset)', async () => {
      let captured: Record<string, unknown> | undefined;
      let capturedUrl: string | undefined;
      globalThis.fetch = vi.fn(async (url: unknown, init?: unknown) => {
        capturedUrl = String(url);
        captured = JSON.parse((init as RequestInit).body as string);
        return new Response(JSON.stringify(textResponse('hi').body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as unknown as typeof fetch;

      const p = new AnthropicLLMProvider({ ...FAKE_CREDS });
      await p.chat([{ role: 'user', content: 'x' }]);
      expect(capturedUrl).toBe('https://api.anthropic.com/v1/messages');
      expect(typeof captured?.max_tokens).toBe('number');
      expect(captured?.max_tokens as number).toBeGreaterThan(0);
    });

    it('extracts role:system messages into the top-level `system` field, not `messages`', async () => {
      let captured: Record<string, unknown> | undefined;
      globalThis.fetch = vi.fn(async (_url: unknown, init?: unknown) => {
        captured = JSON.parse((init as RequestInit).body as string);
        return new Response(JSON.stringify(textResponse('hi').body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as unknown as typeof fetch;

      const p = new AnthropicLLMProvider({ ...FAKE_CREDS });
      await p.chat([
        { role: 'system', content: 'You are terse.' },
        { role: 'user', content: 'hello' },
      ]);
      expect(captured?.system).toBe('You are terse.');
      const messages = captured?.messages as Array<{ role: string; content: string }>;
      expect(messages).toHaveLength(1);
      expect(messages[0]!.role).toBe('user');
      expect(messages.some((m) => m.role === 'system')).toBe(false);
    });

    it('does NOT send tools/tool_choice when json is not requested (prose call)', async () => {
      let captured: Record<string, unknown> | undefined;
      globalThis.fetch = vi.fn(async (_url: unknown, init?: unknown) => {
        captured = JSON.parse((init as RequestInit).body as string);
        return new Response(JSON.stringify(textResponse('plain prose').body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as unknown as typeof fetch;

      const p = new AnthropicLLMProvider({ ...FAKE_CREDS });
      const res = await p.chat([{ role: 'user', content: 'summarize' }]);
      expect(captured?.tools).toBeUndefined();
      expect(captured?.tool_choice).toBeUndefined();
      expect(res.text).toBe('plain prose');
      expect(() => JSON.parse(res.text)).toThrow();
    });
  });

  // ---------------------------------------------------------------------
  // CRITICAL: tool_use.input is already a parsed object, not a JSON string.
  // ---------------------------------------------------------------------
  describe('chat() — forced tool-use JSON extraction', () => {
    it('sends a forced tool_choice + a generic object schema when json:true with no jsonSchema', async () => {
      let captured: Record<string, unknown> | undefined;
      globalThis.fetch = vi.fn(async (_url: unknown, init?: unknown) => {
        captured = JSON.parse((init as RequestInit).body as string);
        return new Response(JSON.stringify(toolUseResponse({ ok: true }).body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as unknown as typeof fetch;

      const p = new AnthropicLLMProvider({ ...FAKE_CREDS });
      await p.chat([{ role: 'user', content: 'extract' }], { json: true });

      const tools = captured?.tools as Array<{ name: string; input_schema: Record<string, unknown> }>;
      expect(tools).toHaveLength(1);
      expect(tools[0]!.input_schema).toEqual({ type: 'object' });
      expect(captured?.tool_choice).toEqual({ type: 'tool', name: tools[0]!.name });
    });

    it('re-serializes tool_use.input (an object) back into ChatResult.text as a JSON string', async () => {
      globalThis.fetch = mockFetchSequence([toolUseResponse({ atoms: [{ text: 'a fact' }] })]);
      const p = new AnthropicLLMProvider({ ...FAKE_CREDS });
      const result = await p.chat([{ role: 'user', content: 'extract' }], { json: true });

      expect(typeof result.text).toBe('string');
      const parsed = JSON.parse(result.text);
      expect(parsed).toEqual({ atoms: [{ text: 'a fact' }] });
    });

    it('honors ChatOpts.jsonSchema as the tool input_schema for an object schema', async () => {
      let captured: Record<string, unknown> | undefined;
      const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] };
      globalThis.fetch = vi.fn(async (_url: unknown, init?: unknown) => {
        captured = JSON.parse((init as RequestInit).body as string);
        return new Response(JSON.stringify(toolUseResponse({ ok: true }).body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as unknown as typeof fetch;

      const p = new AnthropicLLMProvider({ ...FAKE_CREDS });
      const result = await p.chat([{ role: 'user', content: 'x' }], { json: true, jsonSchema: schema });

      const tools = captured?.tools as Array<{ input_schema: Record<string, unknown> }>;
      expect(tools[0]!.input_schema).toEqual(schema);
      expect(JSON.parse(result.text)).toEqual({ ok: true });
    });

    it('wraps a top-level ARRAY jsonSchema in an object tool schema, then unwraps it back to a bare array string (mirrors search/decompose.ts)', async () => {
      let captured: Record<string, unknown> | undefined;
      const arraySchema = { type: 'array', items: { type: 'string' } };
      globalThis.fetch = vi.fn(async (_url: unknown, init?: unknown) => {
        captured = JSON.parse((init as RequestInit).body as string);
        return new Response(JSON.stringify(toolUseResponse({ items: ['sub query 1', 'sub query 2'] }).body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as unknown as typeof fetch;

      const p = new AnthropicLLMProvider({ ...FAKE_CREDS });
      const result = await p.chat([{ role: 'user', content: 'decompose' }], {
        json: true,
        jsonSchema: arraySchema,
      });

      const tools = captured?.tools as Array<{ input_schema: Record<string, unknown> }>;
      expect(tools[0]!.input_schema).toEqual({
        type: 'object',
        properties: { items: arraySchema },
        required: ['items'],
      });
      // The caller asked for an array and must get a bare array string back,
      // not the {items:[...]} wrapper shape the wire actually used.
      const parsed = JSON.parse(result.text);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed).toEqual(['sub query 1', 'sub query 2']);
    });
  });

  describe('chat() — error taxonomy', () => {
    it('throws TransientError on HTTP 500', async () => {
      globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'oops' } }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;
      const p = new AnthropicLLMProvider({ ...FAKE_CREDS });
      await expect(p.chat([{ role: 'user', content: 'x' }])).rejects.toBeInstanceOf(TransientError);
    });

    it('throws TransientError on HTTP 429 and threads Retry-After', async () => {
      globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'rate limited' } }), {
        status: 429,
        headers: { 'content-type': 'application/json', 'retry-after': '7' },
      })) as unknown as typeof fetch;
      const p = new AnthropicLLMProvider({ ...FAKE_CREDS });
      let caught: unknown;
      try {
        await p.chat([{ role: 'user', content: 'x' }]);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(TransientError);
      expect((caught as TransientError).retryAfterMs).toBe(7000);
    });

    it('throws DeterministicError on HTTP 400 without retry', async () => {
      let callCount = 0;
      globalThis.fetch = vi.fn(async () => {
        callCount++;
        return new Response(JSON.stringify({ error: { message: 'invalid_request_error: bad model' } }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        });
      }) as unknown as typeof fetch;
      const p = new AnthropicLLMProvider({ ...FAKE_CREDS });
      await expect(p.chat([{ role: 'user', content: 'x' }])).rejects.toBeInstanceOf(DeterministicError);
      expect(callCount).toBe(1);
    });

    it('retries once on 5xx then throws', async () => {
      let callCount = 0;
      globalThis.fetch = vi.fn(async () => {
        callCount++;
        return new Response('internal error', { status: 500 });
      }) as unknown as typeof fetch;
      const p = new AnthropicLLMProvider({ ...FAKE_CREDS });
      await expect(p.chat([{ role: 'user', content: 'x' }])).rejects.toThrow();
      expect(callCount).toBe(2);
    });
  });

  describe('health()', () => {
    it('pings with max_tokens:1 and returns ok:true on 200', async () => {
      let captured: Record<string, unknown> | undefined;
      globalThis.fetch = vi.fn(async (_url: unknown, init?: unknown) => {
        captured = JSON.parse((init as RequestInit).body as string);
        return new Response(JSON.stringify(textResponse('pong', 1, 1).body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as unknown as typeof fetch;

      const p = new AnthropicLLMProvider({ ...FAKE_CREDS });
      const h = await p.health();
      expect(h.ok).toBe(true);
      expect(captured?.max_tokens).toBe(1);
    });

    it('returns ok:false with an error message on non-2xx', async () => {
      globalThis.fetch = vi.fn(async () => new Response('unauthorized', { status: 401 })) as unknown as typeof fetch;
      const p = new AnthropicLLMProvider({ ...FAKE_CREDS });
      const h = await p.health();
      expect(h.ok).toBe(false);
      expect(h.error).toContain('401');
    });
  });

  // ---------------------------------------------------------------------
  // SECURITY: key-leak audit (Wave 1 dispatch requirement). The API key
  // must never appear in a thrown error message, in ChatResult, or in
  // LLMHealth — the only place it may ever appear is the x-api-key request
  // header (already asserted above).
  // ---------------------------------------------------------------------
  describe('security — API key never leaks', () => {
    it('a failed chat() error message does not contain the API key', async () => {
      globalThis.fetch = vi.fn(async () =>
        new Response(JSON.stringify({ error: { message: `denied for key ${FAKE_CREDS.apiKey}` } }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        }),
      ) as unknown as typeof fetch;

      const p = new AnthropicLLMProvider({ ...FAKE_CREDS });
      let caught: unknown;
      try {
        await p.chat([{ role: 'user', content: 'x' }]);
      } catch (e) {
        caught = e;
      }
      // The upstream response above deliberately REFLECTS the key in its error
      // body — a hostile/buggy endpoint. This asserts the provider redacts it
      // from the thrown error message (which flows into doctor's structured
      // logs), not merely that it throws the right error TYPE. (PR #414 review:
      // the prior version only checked the type and would have passed while
      // leaking the reflected key.)
      expect(caught).toBeInstanceOf(DeterministicError);
      expect((caught as Error).message).not.toContain(FAKE_CREDS.apiKey);
    });

    it('a failed health() error message does not contain the API key', async () => {
      globalThis.fetch = vi.fn(async () => new Response('unauthorized', { status: 401 })) as unknown as typeof fetch;
      const p = new AnthropicLLMProvider({ ...FAKE_CREDS });
      const h = await p.health();
      expect(h.error ?? '').not.toContain(FAKE_CREDS.apiKey);
    });

    it('a network-level throw (no HTTP response) does not contain the API key', async () => {
      globalThis.fetch = vi.fn(async () => {
        throw new Error('ECONNREFUSED 127.0.0.1:443');
      }) as unknown as typeof fetch;
      const p = new AnthropicLLMProvider({ ...FAKE_CREDS });
      const h = await p.health();
      expect(h.error ?? '').not.toContain(FAKE_CREDS.apiKey);
    });

    it('the provider never puts the API key in the request body (only the x-api-key header)', async () => {
      let capturedBody: string | undefined;
      globalThis.fetch = vi.fn(async (_url: unknown, init?: unknown) => {
        capturedBody = (init as RequestInit).body as string;
        return new Response(JSON.stringify(textResponse('hi').body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as unknown as typeof fetch;

      const p = new AnthropicLLMProvider({ ...FAKE_CREDS });
      await p.chat([{ role: 'user', content: 'x' }]);
      expect(capturedBody ?? '').not.toContain(FAKE_CREDS.apiKey);
    });
  });

  describe('usd cost', () => {
    it('is 0 for an unpriced model (not in the pricing table)', async () => {
      globalThis.fetch = mockFetchSequence([textResponse('hi', 10000, 5000)]);
      const p = new AnthropicLLMProvider({ ...FAKE_CREDS });
      const res = await p.chat([{ role: 'user', content: 'x' }]);
      expect(res.usage.usd).toBe(0);
    });
  });
});
