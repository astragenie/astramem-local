import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { CodexSubscriptionLLMProvider } from '../../src/providers/llm/codex-subscription.js';
import { runLLMContractSuite } from './_contract-suite.js';

const CODEX_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses';
const CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function b64url(s: string): string {
  return Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fakeJwt(payload: Record<string, unknown>): string {
  return `${b64url(JSON.stringify({ alg: 'none' }))}.${b64url(JSON.stringify(payload))}.sig`;
}

function tmpAuthPath(): string {
  const dir = join(tmpdir(), `astra-codex-auth-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return join(dir, 'auth.json');
}

// Live-verified (2026-07-08, real ~/.codex/auth.json, Codex CLI 0.142.2):
// `chatgpt_account_id` is nested under the `https://api.openai.com/auth`
// claim, NOT top-level — this fixture matches the real shape.
function idTokenWithNestedAccountId(accountId: string): string {
  return fakeJwt({ sub: 'user1', 'https://api.openai.com/auth': { chatgpt_account_id: accountId } });
}

// accountId/idToken: `undefined` = use the default fixture value, `null` =
// deliberately omit the field (to test resolveAccountId's fallback chain).
function writeAuthFile(
  path: string,
  opts: { accessToken?: string; refreshToken?: string; idToken?: string | null; accountId?: string | null } = {},
) {
  const accessToken = opts.accessToken ?? fakeJwt({ sub: 'user1' });
  const accountId = opts.accountId === undefined ? 'acc_123' : opts.accountId;
  const idToken = opts.idToken === undefined ? idTokenWithNestedAccountId('acc_123_idtoken') : opts.idToken;
  const body: Record<string, unknown> = {
    auth_mode: 'chatgpt',
    tokens: {
      access_token: accessToken,
      refresh_token: opts.refreshToken ?? 'refresh-abc',
      ...(idToken ? { id_token: idToken } : {}),
      // Live-verified: real auth.json carries account_id directly on
      // tokens — this is the preferred source (resolveAccountId), so most
      // fixtures set it to a DIFFERENT value than the id_token's nested
      // claim to prove which one actually wins.
      ...(accountId ? { account_id: accountId } : {}),
    },
    last_refresh: new Date().toISOString(),
  };
  writeFileSync(path, JSON.stringify(body), 'utf8');
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

// Live-verified (2026-07-08, real ChatGPT Codex backend, model gpt-5.4-mini):
// the endpoint REQUIRES `stream: true` and returns Server-Sent Events, not a
// single JSON object — `event: <type>\ndata: <json>\n\n` blocks. This
// fixture reproduces the exact event sequence observed live: a `reasoning`
// output_item (must be skipped — encrypted chain-of-thought, not the
// answer), then a `message` output_item carrying the actual text, then
// `response.completed` carrying usage (its own `response.output` is
// observed EMPTY live — text is only ever on the intermediate event).
function codexSseResponse(text: string, inTokens = 10, outTokens = 5): Response {
  const events = [
    { type: 'response.created', response: { status: 'in_progress' } },
    {
      type: 'response.output_item.done',
      item: { id: 'rs_1', type: 'reasoning', content: [], encrypted_content: 'opaque' },
    },
    {
      type: 'response.output_item.done',
      item: { id: 'msg_1', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text }] },
    },
    {
      type: 'response.completed',
      response: { status: 'completed', output: [], usage: { input_tokens: inTokens, output_tokens: outTokens } },
    },
  ];
  const body = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

// ---------------------------------------------------------------------------
// Contract suite
// ---------------------------------------------------------------------------
describe('codex-subscription-llm', () => {
  let restoreGlobal: () => void;

  beforeEach(() => {
    const original = globalThis.fetch;
    restoreGlobal = () => { globalThis.fetch = original; };
  });

  afterEach(() => {
    restoreGlobal();
    vi.restoreAllMocks();
  });

  runLLMContractSuite('codex-subscription', () => {
    const authPath = tmpAuthPath();
    writeAuthFile(authPath);
    globalThis.fetch = vi.fn(async (url: unknown) => {
      if (String(url) === CODEX_RESPONSES_URL) {
        return codexSseResponse('{"result":"ok"}');
      }
      return jsonResponse(200, { access_token: fakeJwt({}), refresh_token: 'r2' });
    }) as unknown as typeof fetch;
    return new CodexSubscriptionLLMProvider({ model: 'gpt-5.4-mini', authPath });
  });

  // ---------------------------------------------------------------------------
  // Auth file loading
  // ---------------------------------------------------------------------------
  describe('auth.json loading', () => {
    it('throws an actionable error when auth.json is missing', async () => {
      const authPath = join(tmpdir(), `astra-codex-missing-${randomUUID()}`, 'auth.json');
      const p = new CodexSubscriptionLLMProvider({ authPath });
      await expect(p.chat([{ role: 'user', content: 'hi' }])).rejects.toThrow(/codex login/i);
    });

    it('throws an actionable error when auth.json is invalid JSON', async () => {
      const authPath = tmpAuthPath();
      writeFileSync(authPath, 'not json', 'utf8');
      const p = new CodexSubscriptionLLMProvider({ authPath });
      await expect(p.chat([{ role: 'user', content: 'hi' }])).rejects.toThrow(/codex login/i);
    });

    it('throws an actionable error when tokens are missing', async () => {
      const authPath = tmpAuthPath();
      writeFileSync(authPath, JSON.stringify({ auth_mode: 'chatgpt' }), 'utf8');
      const p = new CodexSubscriptionLLMProvider({ authPath });
      await expect(p.chat([{ role: 'user', content: 'hi' }])).rejects.toThrow(/tokens/i);
    });
  });

  // ---------------------------------------------------------------------------
  // chat()
  // ---------------------------------------------------------------------------
  describe('chat()', () => {
    it('round-trip returns {text, usage: {in, out, usd: 0}}', async () => {
      const authPath = tmpAuthPath();
      writeAuthFile(authPath);
      globalThis.fetch = vi.fn(async () => codexSseResponse('hello', 42, 7)) as unknown as typeof fetch;

      const p = new CodexSubscriptionLLMProvider({ authPath });
      const res = await p.chat([{ role: 'user', content: 'hi' }]);
      expect(res.text).toBe('hello');
      expect(res.usage.in).toBe(42);
      expect(res.usage.out).toBe(7);
      expect(res.usage.usd).toBe(0);
    });

    it('sends Authorization, chatgpt-account-id, originator, OpenAI-Beta headers', async () => {
      const authPath = tmpAuthPath();
      writeAuthFile(authPath);
      let captured: Record<string, string> | undefined;
      globalThis.fetch = vi.fn(async (_url: unknown, init?: unknown) => {
        captured = (init as RequestInit).headers as Record<string, string>;
        return codexSseResponse('hi');
      }) as unknown as typeof fetch;

      const p = new CodexSubscriptionLLMProvider({ authPath });
      await p.chat([{ role: 'user', content: 'x' }]);
      expect(captured?.authorization).toMatch(/^Bearer /);
      expect(captured?.['chatgpt-account-id']).toBe('acc_123');
      expect(captured?.originator).toBe('astramemory-local');
      expect(captured?.['openai-beta']).toBe('responses=experimental');
    });

    it('prefers tokens.account_id over the id_token JWT claim when both are present', async () => {
      const authPath = tmpAuthPath();
      writeAuthFile(authPath, { accountId: 'direct-field-wins' });
      let captured: Record<string, string> | undefined;
      globalThis.fetch = vi.fn(async (_url: unknown, init?: unknown) => {
        captured = (init as RequestInit).headers as Record<string, string>;
        return codexSseResponse('hi');
      }) as unknown as typeof fetch;

      const p = new CodexSubscriptionLLMProvider({ authPath });
      await p.chat([{ role: 'user', content: 'x' }]);
      expect(captured?.['chatgpt-account-id']).toBe('direct-field-wins');
    });

    it('falls back to decoding the nested id_token claim when tokens.account_id is absent', async () => {
      const authPath = tmpAuthPath();
      writeAuthFile(authPath, { accountId: null, idToken: idTokenWithNestedAccountId('from-id-token-claim') });
      let captured: Record<string, string> | undefined;
      globalThis.fetch = vi.fn(async (_url: unknown, init?: unknown) => {
        captured = (init as RequestInit).headers as Record<string, string>;
        return codexSseResponse('hi');
      }) as unknown as typeof fetch;

      const p = new CodexSubscriptionLLMProvider({ authPath });
      await p.chat([{ role: 'user', content: 'x' }]);
      expect(captured?.['chatgpt-account-id']).toBe('from-id-token-claim');
    });

    it('omits chatgpt-account-id when neither tokens.account_id nor a decodable claim is present', async () => {
      const authPath = tmpAuthPath();
      writeAuthFile(authPath, { accountId: null, idToken: null });
      let captured: Record<string, string> | undefined;
      globalThis.fetch = vi.fn(async (_url: unknown, init?: unknown) => {
        captured = (init as RequestInit).headers as Record<string, string>;
        return codexSseResponse('hi');
      }) as unknown as typeof fetch;

      const p = new CodexSubscriptionLLMProvider({ authPath });
      await p.chat([{ role: 'user', content: 'x' }]);
      expect(captured?.['chatgpt-account-id']).toBeUndefined();
    });

    it('maps system message to instructions and user message to input array, with store:false, stream:true, reasoning low', async () => {
      const authPath = tmpAuthPath();
      writeAuthFile(authPath);
      let captured: Record<string, unknown> | undefined;
      globalThis.fetch = vi.fn(async (_url: unknown, init?: unknown) => {
        captured = JSON.parse((init as RequestInit).body as string);
        return codexSseResponse('hi');
      }) as unknown as typeof fetch;

      const p = new CodexSubscriptionLLMProvider({ authPath, model: 'gpt-5.4-mini' });
      await p.chat([
        { role: 'system', content: 'You are extracting atoms.' },
        { role: 'user', content: 'Extract from this text.' },
      ]);
      expect(captured?.instructions).toBe('You are extracting atoms.');
      // Live-verified (2026-07-08): `input` must be an array of {role,
      // content} items — a joined string gets HTTP 400 "Input must be a list".
      expect(captured?.input).toEqual([{ role: 'user', content: 'Extract from this text.' }]);
      expect(captured?.store).toBe(false);
      expect(captured?.model).toBe('gpt-5.4-mini');
      // Live-verified (2026-07-08): both are mandatory — the endpoint
      // rejects a non-streaming request, and rejects reasoning.effort
      // 'minimal' (only none/low/medium/high/xhigh are accepted).
      expect(captured?.stream).toBe(true);
      expect(captured?.reasoning).toEqual({ effort: 'low' });
      // Live-verified (2026-07-08): both params are rejected outright by
      // this endpoint, so neither is ever forwarded.
      expect(captured?.max_output_tokens).toBeUndefined();
      expect(captured?.max_tokens).toBeUndefined();
      expect(captured?.temperature).toBeUndefined();
    });

    it('sends text.format json_object when json:true (live-verified: honored by the real backend)', async () => {
      const authPath = tmpAuthPath();
      writeAuthFile(authPath);
      let captured: Record<string, unknown> | undefined;
      globalThis.fetch = vi.fn(async (_url: unknown, init?: unknown) => {
        captured = JSON.parse((init as RequestInit).body as string);
        return codexSseResponse('{"result":"ok"}');
      }) as unknown as typeof fetch;

      const p = new CodexSubscriptionLLMProvider({ authPath });
      await p.chat([{ role: 'user', content: 'x' }], { json: true });
      expect(captured?.text).toEqual({ format: { type: 'json_object' } });
    });

    it('does not send opts.maxTokens/opts.temperature even when the caller passes them', async () => {
      const authPath = tmpAuthPath();
      writeAuthFile(authPath);
      let captured: Record<string, unknown> | undefined;
      globalThis.fetch = vi.fn(async (_url: unknown, init?: unknown) => {
        captured = JSON.parse((init as RequestInit).body as string);
        return codexSseResponse('hi');
      }) as unknown as typeof fetch;

      const p = new CodexSubscriptionLLMProvider({ authPath });
      await p.chat([{ role: 'user', content: 'x' }], { maxTokens: 500, temperature: 0.2 });
      expect(captured?.max_output_tokens).toBeUndefined();
      expect(captured?.max_tokens).toBeUndefined();
      expect(captured?.temperature).toBeUndefined();
    });

    it('skips reasoning-type output items and only extracts message-type text', async () => {
      const authPath = tmpAuthPath();
      writeAuthFile(authPath);
      globalThis.fetch = vi.fn(async () => codexSseResponse('the real answer')) as unknown as typeof fetch;

      const p = new CodexSubscriptionLLMProvider({ authPath });
      const res = await p.chat([{ role: 'user', content: 'x' }]);
      expect(res.text).toBe('the real answer');
    });

    it('refreshes token on 401 then retries and succeeds', async () => {
      const authPath = tmpAuthPath();
      writeAuthFile(authPath, { accessToken: fakeJwt({ sub: 'stale' }) });
      let responsesCalls = 0;
      let refreshCalls = 0;
      const newAccessToken = fakeJwt({ sub: 'fresh' });

      globalThis.fetch = vi.fn(async (url: unknown) => {
        if (String(url) === CODEX_TOKEN_URL) {
          refreshCalls++;
          return jsonResponse(200, { access_token: newAccessToken, refresh_token: 'refresh-def' });
        }
        responsesCalls++;
        if (responsesCalls === 1) return jsonResponse(401, { error: 'unauthorized' });
        return codexSseResponse('recovered');
      }) as unknown as typeof fetch;

      const p = new CodexSubscriptionLLMProvider({ authPath });
      const res = await p.chat([{ role: 'user', content: 'x' }]);
      expect(res.text).toBe('recovered');
      expect(refreshCalls).toBe(1);
      expect(responsesCalls).toBe(2);

      // Rotated tokens persisted back to auth.json.
      const persisted = JSON.parse(readFileSync(authPath, 'utf8'));
      expect(persisted.tokens.access_token).toBe(newAccessToken);
      expect(persisted.tokens.refresh_token).toBe('refresh-def');
    });

    it('throws a re-login error when refresh itself fails', async () => {
      const authPath = tmpAuthPath();
      writeAuthFile(authPath);
      globalThis.fetch = vi.fn(async (url: unknown) => {
        if (String(url) === CODEX_TOKEN_URL) return jsonResponse(400, { error: 'invalid_grant' });
        return jsonResponse(401, { error: 'unauthorized' });
      }) as unknown as typeof fetch;

      const p = new CodexSubscriptionLLMProvider({ authPath });
      await expect(p.chat([{ role: 'user', content: 'x' }])).rejects.toThrow(/re-login/i);
    });

    it('throws a re-login error when still unauthorized after a successful refresh', async () => {
      const authPath = tmpAuthPath();
      writeAuthFile(authPath);
      globalThis.fetch = vi.fn(async (url: unknown) => {
        if (String(url) === CODEX_TOKEN_URL) {
          return jsonResponse(200, { access_token: fakeJwt({}), refresh_token: 'r2' });
        }
        return jsonResponse(401, { error: 'still unauthorized' });
      }) as unknown as typeof fetch;

      const p = new CodexSubscriptionLLMProvider({ authPath });
      await expect(p.chat([{ role: 'user', content: 'x' }])).rejects.toThrow(/re-login/i);
    });

    it('throws on non-401 4xx without attempting refresh', async () => {
      const authPath = tmpAuthPath();
      writeAuthFile(authPath);
      let refreshCalls = 0;
      globalThis.fetch = vi.fn(async (url: unknown) => {
        if (String(url) === CODEX_TOKEN_URL) { refreshCalls++; return jsonResponse(200, {}); }
        return jsonResponse(400, { error: 'bad request' });
      }) as unknown as typeof fetch;

      const p = new CodexSubscriptionLLMProvider({ authPath });
      await expect(p.chat([{ role: 'user', content: 'x' }])).rejects.toThrow(/HTTP 400/);
      expect(refreshCalls).toBe(0);
    });

    it('classifies 500 as a TransientError-shaped failure', async () => {
      const authPath = tmpAuthPath();
      writeAuthFile(authPath);
      globalThis.fetch = vi.fn(async () => jsonResponse(500, { error: 'boom' })) as unknown as typeof fetch;

      const p = new CodexSubscriptionLLMProvider({ authPath });
      await expect(p.chat([{ role: 'user', content: 'x' }])).rejects.toThrow(/HTTP 500/);
    });

    // Empty-SSE poison gate (architect-review finding, 20260713T100000Z):
    // an empty `text` with a 200/res.ok response is the same failure shape
    // as the qwen3:8b empty-extract bug that previously poisoned distill —
    // a "successful" ChatResult with vacuous content stored as if it were
    // real. These prove that shape now throws instead of returning silently.
    it('throws TransientError on empty SSE text for a json-mode request', async () => {
      const authPath = tmpAuthPath();
      writeAuthFile(authPath);
      globalThis.fetch = vi.fn(async () => codexSseResponse('')) as unknown as typeof fetch;

      const p = new CodexSubscriptionLLMProvider({ authPath });
      await expect(p.chat([{ role: 'user', content: 'x' }], { json: true })).rejects.toThrow(
        /codex-subscription returned empty text for a json-mode request/,
      );
    });

    it('throws TransientError on whitespace-only SSE text', async () => {
      const authPath = tmpAuthPath();
      writeAuthFile(authPath);
      globalThis.fetch = vi.fn(async () => codexSseResponse('   \n\t  ')) as unknown as typeof fetch;

      const p = new CodexSubscriptionLLMProvider({ authPath });
      await expect(p.chat([{ role: 'user', content: 'x' }], { json: true })).rejects.toThrow(
        /codex-subscription returned empty text/,
      );
    });

    it('throws TransientError on empty text for a plain-chat (non-json) request', async () => {
      const authPath = tmpAuthPath();
      writeAuthFile(authPath);
      globalThis.fetch = vi.fn(async () => codexSseResponse('')) as unknown as typeof fetch;

      const p = new CodexSubscriptionLLMProvider({ authPath });
      await expect(p.chat([{ role: 'user', content: 'x' }])).rejects.toThrow(
        /codex-subscription returned empty text for a plain-chat request/,
      );
    });

    it('passes valid non-empty text through unchanged', async () => {
      const authPath = tmpAuthPath();
      writeAuthFile(authPath);
      globalThis.fetch = vi.fn(async () => codexSseResponse('{"result":"ok"}', 12, 3)) as unknown as typeof fetch;

      const p = new CodexSubscriptionLLMProvider({ authPath });
      const res = await p.chat([{ role: 'user', content: 'x' }], { json: true });
      expect(res.text).toBe('{"result":"ok"}');
      expect(res.usage).toEqual({ in: 12, out: 3, usd: 0 });
    });
  });

  // ---------------------------------------------------------------------------
  // health()
  // ---------------------------------------------------------------------------
  describe('health()', () => {
    it('ok:true on a successful chat round-trip', async () => {
      const authPath = tmpAuthPath();
      writeAuthFile(authPath);
      globalThis.fetch = vi.fn(async () => codexSseResponse('pong')) as unknown as typeof fetch;

      const p = new CodexSubscriptionLLMProvider({ authPath });
      const h = await p.health();
      expect(h.ok).toBe(true);
    });

    it('ok:false with an actionable error when auth.json is missing', async () => {
      const authPath = join(tmpdir(), `astra-codex-missing-${randomUUID()}`, 'auth.json');
      const p = new CodexSubscriptionLLMProvider({ authPath });
      const h = await p.health();
      expect(h.ok).toBe(false);
      expect(h.error).toMatch(/codex login/i);
    });
  });

  describe.skipIf(!process.env.INTEGRATION_LIVE)('live integration', () => {
    it('calls the real ChatGPT Codex backend using ~/.codex/auth.json', async () => {
      const p = new CodexSubscriptionLLMProvider({});
      const h = await p.health();
      expect(h.ok).toBe(true);
    }, 20_000);
  });
});
