/**
 * Per-provider adapters for the shared LLM contract-conformance suite
 * (llm-contract-conformance.test.ts).
 *
 * Why this file exists: on 2026-07-13 all three HTTP-based providers
 * (ollama, azure-openai, openai-compatible) independently wrote
 * `opts?.json ?? true`, forcing structured-output mode onto every call —
 * including prose calls like compaction (04-compact.ts) that pass no `json`
 * flag. Each provider had its OWN test file, and each only asserted the
 * POSITIVE case ("sends json format when json:true"). None asserted the
 * NEGATIVE case (no json flag -> no structured-output field sent), which is
 * the exact assertion that would have caught `?? true`. A per-provider
 * suite cannot catch a divergence BETWEEN providers, or a shared mistake
 * that all of them made identically.
 *
 * Each provider speaks a structurally different wire format (field names,
 * message shape, URL), so a single set of assertions can't run directly
 * against raw request bodies. This adapter layer normalizes just enough
 * (requestedJson / outgoingContents) for the shared suite to assert
 * uniformly, while every adapter still wires a REAL provider instance
 * against REAL fetch — the assertions run on the actual bytes the provider
 * sends, not on a shape the test author assumes.
 */
import { vi } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { AzureOpenAILLMProvider } from '../../src/providers/llm/azure-openai.js';
import { OllamaLLMProvider } from '../../src/providers/llm/ollama.js';
import { OpenAICompatibleLLMProvider } from '../../src/providers/llm/openai-compatible.js';
import { CodexSubscriptionLLMProvider } from '../../src/providers/llm/codex-subscription.js';
import type { LLMProvider } from '../../src/contracts/llm.js';

export interface CapturedRequest {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
}

export interface LLMProviderAdapter {
  name: string;
  /** Build a real provider instance wired to a fetch mock. `responder` is
   * invoked with the parsed outgoing chat request and must return the HTTP
   * Response for it. Non-chat traffic the provider needs (Ollama's
   * /api/tags for health(), Codex's token endpoint) is handled internally
   * by the adapter, not by the caller. */
  createProvider(responder: (req: CapturedRequest) => Response | Promise<Response>): LLMProvider;
  /** Build the raw success HTTP response for a chat call. */
  successResponse(text: string, inTokens?: number, outTokens?: number): Response;
  /** Build the raw error HTTP response for a chat call. */
  errorResponse(status: number, message?: string): Response;
  /** Does this outgoing request body ask for structured/JSON output? */
  requestedJson(body: Record<string, unknown>): boolean;
  /** Normalized outgoing message contents (system + user), for the
   * json-word-hint check below. */
  outgoingContents(body: Record<string, unknown>): string[];
  /** True if this provider auto-appends a "json" word hint to the outgoing
   * messages when json:true is requested but no message already contains
   * the word. Azure and codex-subscription's real backends 400 without the
   * literal word present; this guard is how each provider avoids that. */
  appendsJsonHintWhenMissing: boolean;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

// ─── ollama ──────────────────────────────────────────────────────────────

const ollamaAdapter: LLMProviderAdapter = {
  name: 'ollama',
  createProvider(responder) {
    const fetchMock = vi.fn(async (url: unknown, init?: unknown): Promise<Response> => {
      const u = String(url);
      if (u.includes('/api/tags')) {
        return jsonResponse(200, { models: [{ name: 'test-model' }] });
      }
      const body = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;
      return responder({ url: u, init: init as RequestInit, body });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    return new OllamaLLMProvider({ model: 'test-model' });
  },
  successResponse(text, inTokens = 10, outTokens = 5) {
    return jsonResponse(200, {
      message: { role: 'assistant', content: text },
      prompt_eval_count: inTokens,
      eval_count: outTokens,
    });
  },
  errorResponse(status, message = 'error') {
    return new Response(message, { status });
  },
  requestedJson(body) {
    return body.format === 'json';
  },
  outgoingContents(body) {
    const messages = (body.messages ?? []) as Array<{ content: string }>;
    return messages.map((m) => m.content);
  },
  appendsJsonHintWhenMissing: false,
};

// ─── azure-openai ────────────────────────────────────────────────────────

const azureAdapter: LLMProviderAdapter = {
  name: 'azure-openai',
  createProvider(responder) {
    const fetchMock = vi.fn(async (url: unknown, init?: unknown): Promise<Response> => {
      const body = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;
      return responder({ url: String(url), init: init as RequestInit, body });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    return new AzureOpenAILLMProvider({
      endpoint: 'https://my-resource.openai.azure.com',
      deployment: 'gpt-4.1',
      apiKey: 'test-key',
      model: 'gpt-4.1',
    });
  },
  successResponse(text, inTokens = 10, outTokens = 5) {
    return jsonResponse(200, {
      choices: [{ message: { role: 'assistant', content: text } }],
      usage: { prompt_tokens: inTokens, completion_tokens: outTokens },
    });
  },
  errorResponse(status, message = 'error') {
    return jsonResponse(status, { error: { message } });
  },
  requestedJson(body) {
    return (body.response_format as { type?: string } | undefined)?.type === 'json_object';
  },
  outgoingContents(body) {
    const messages = (body.messages ?? []) as Array<{ content: string }>;
    return messages.map((m) => m.content);
  },
  appendsJsonHintWhenMissing: true,
};

// ─── openai-compatible ───────────────────────────────────────────────────

const openaiCompatibleAdapter: LLMProviderAdapter = {
  name: 'openai-compatible',
  createProvider(responder) {
    const fetchMock = vi.fn(async (url: unknown, init?: unknown): Promise<Response> => {
      const body = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;
      return responder({ url: String(url), init: init as RequestInit, body });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    return new OpenAICompatibleLLMProvider({
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
      apiKey: 'sk-test',
    });
  },
  successResponse(text, inTokens = 10, outTokens = 5) {
    return jsonResponse(200, {
      choices: [{ message: { role: 'assistant', content: text } }],
      usage: { prompt_tokens: inTokens, completion_tokens: outTokens },
    });
  },
  errorResponse(status, message = 'error') {
    return jsonResponse(status, { error: { message } });
  },
  requestedJson(body) {
    return (body.response_format as { type?: string } | undefined)?.type === 'json_object';
  },
  outgoingContents(body) {
    const messages = (body.messages ?? []) as Array<{ content: string }>;
    return messages.map((m) => m.content);
  },
  appendsJsonHintWhenMissing: true,
};

// ─── codex-subscription ─────────────────────────────────────────────────

const CODEX_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses';

function b64url(s: string): string {
  return Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fakeJwt(payload: Record<string, unknown>): string {
  return `${b64url(JSON.stringify({ alg: 'none' }))}.${b64url(JSON.stringify(payload))}.sig`;
}
function tmpAuthPath(): string {
  const dir = join(tmpdir(), `astra-codex-auth-conformance-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return join(dir, 'auth.json');
}
function writeAuthFile(path: string): void {
  const body = {
    auth_mode: 'chatgpt',
    tokens: {
      access_token: fakeJwt({ sub: 'user1' }),
      refresh_token: 'refresh-abc',
      account_id: 'acc_123',
    },
    last_refresh: new Date().toISOString(),
  };
  writeFileSync(path, JSON.stringify(body), 'utf8');
}
function codexSseResponse(text: string, inTokens = 10, outTokens = 5): Response {
  const events = [
    { type: 'response.created', response: { status: 'in_progress' } },
    {
      type: 'response.output_item.done',
      item: { id: 'msg_1', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text }] },
    },
    {
      type: 'response.completed',
      response: { status: 'completed', output: [], usage: { input_tokens: inTokens, output_tokens: outTokens } },
    },
  ];
  const raw = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
  return new Response(raw, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const codexAdapter: LLMProviderAdapter = {
  name: 'codex-subscription',
  createProvider(responder) {
    const authPath = tmpAuthPath();
    writeAuthFile(authPath);
    const fetchMock = vi.fn(async (url: unknown, init?: unknown): Promise<Response> => {
      const u = String(url);
      if (u !== CODEX_RESPONSES_URL) {
        // token refresh endpoint — not exercised by these tests since the
        // fixture auth.json's access token is never rejected with a 401.
        return jsonResponse(200, { access_token: fakeJwt({}), refresh_token: 'r2' });
      }
      const body = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;
      return responder({ url: u, init: init as RequestInit, body });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    return new CodexSubscriptionLLMProvider({ model: 'gpt-5.4-mini', authPath });
  },
  successResponse(text, inTokens = 10, outTokens = 5) {
    return codexSseResponse(text, inTokens, outTokens);
  },
  errorResponse(status, message = 'error') {
    return new Response(message, { status });
  },
  requestedJson(body) {
    const text = body.text as { format?: { type?: string } } | undefined;
    return text?.format?.type === 'json_object';
  },
  outgoingContents(body) {
    const instructions = typeof body.instructions === 'string' ? [body.instructions] : [];
    const input = (body.input ?? []) as Array<{ content: string }>;
    return [...instructions, ...input.map((m) => m.content)];
  },
  appendsJsonHintWhenMissing: true,
};

export const ALL_LLM_ADAPTERS: LLMProviderAdapter[] = [
  ollamaAdapter,
  azureAdapter,
  openaiCompatibleAdapter,
  codexAdapter,
];
