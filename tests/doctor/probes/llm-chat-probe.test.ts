import { describe, it, expect, vi } from 'vitest';
import type { LLMProvider } from '../../../src/contracts/llm.js';
import { llmChatProbe } from '../../../src/doctor/probes/llm-chat-probe.js';

function makeLLMProvider(
  overrides: Partial<LLMProvider> & { name?: 'ollama' | 'azure-openai'; model?: string },
): LLMProvider {
  return {
    name: overrides.name ?? 'ollama',
    model: overrides.model ?? 'qwen2.5-coder:7b',
    chat: overrides.chat ?? vi.fn().mockResolvedValue({ text: '{"ok":true}', usage: { in: 1, out: 1, usd: 0 } }),
    health: overrides.health ?? vi.fn().mockResolvedValue({ ok: true, model: 'qwen2.5-coder:7b', latency_ms: 10 }),
  };
}

describe('llmChatProbe', () => {
  it('returns ok:true when provider returns non-empty, valid-JSON response', async () => {
    const provider = makeLLMProvider({
      chat: vi.fn().mockResolvedValue({ text: '{"ok":true}', usage: { in: 1, out: 1, usd: 0 } }),
    });
    const result = await llmChatProbe(provider, 5000);
    expect(result.ok).toBe(true);
    expect(result.message).toContain('ollama/qwen2.5-coder:7b');
    expect(result.message).toMatch(/responded in \d+ms/);
  });

  it('returns ok:false when provider returns empty text', async () => {
    const provider = makeLLMProvider({
      chat: vi.fn().mockResolvedValue({ text: '', usage: { in: 1, out: 0, usd: 0 } }),
    });
    const result = await llmChatProbe(provider, 5000);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('empty response');
    expect(result.fix).toContain('model is loaded');
  });

  it('returns ok:false when provider returns whitespace-only text', async () => {
    const provider = makeLLMProvider({
      chat: vi.fn().mockResolvedValue({ text: '   \n', usage: { in: 1, out: 1, usd: 0 } }),
    });
    const result = await llmChatProbe(provider, 5000);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('empty response');
  });

  // This is the regression the fix targets: qwen3 under Ollama's format:json
  // + thinking mode returned empty output on a real chat call while a plain
  // (non-JSON) probe read as healthy. Non-empty-but-not-JSON is the sibling
  // failure mode — a model that ignores format:json and echoes prose back.
  it('returns ok:false when provider returns non-empty text that is not valid JSON', async () => {
    const provider = makeLLMProvider({
      chat: vi.fn().mockResolvedValue({ text: 'Sure, here you go: ok', usage: { in: 1, out: 1, usd: 0 } }),
    });
    const result = await llmChatProbe(provider, 5000);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('not valid JSON');
    expect(result.fix).toContain('format:json');
  });

  it('returns ok:false when provider throws', async () => {
    const provider = makeLLMProvider({
      chat: vi.fn().mockRejectedValue(new Error('connection refused')),
    });
    const result = await llmChatProbe(provider, 5000);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('connection refused');
    expect(result.fix).toContain('provider config');
  });

  it('returns ok:false on timeout', async () => {
    const provider = makeLLMProvider({
      // never resolves
      chat: vi.fn().mockReturnValue(new Promise(() => {})),
    });
    const result = await llmChatProbe(provider, 50); // very short timeout
    expect(result.ok).toBe(false);
    expect(result.message).toContain('timeout');
  });

  it('includes provider name and model in error messages', async () => {
    const provider = makeLLMProvider({
      name: 'azure-openai',
      model: 'gpt-4o',
      chat: vi.fn().mockRejectedValue(new Error('auth failed')),
    });
    const result = await llmChatProbe(provider, 5000);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('azure-openai/gpt-4o');
  });

  it('passes {json:true, temperature:0} to provider.chat — the format:json shape real extraction uses', async () => {
    const chatFn = vi.fn().mockResolvedValue({ text: '{"ok":true}', usage: { in: 1, out: 1, usd: 0 } });
    const provider = makeLLMProvider({ chat: chatFn });
    await llmChatProbe(provider, 5000);
    // Issue #261: a `signal` is now also passed (see the AbortSignal
    // cancellation test below) — objectContaining rather than an exact
    // match so this test doesn't churn every time a new ChatOpts field is
    // threaded through. `json: true` is the load-bearing assertion here —
    // this is what was missing before the fix, and is the exact opt that
    // triggers Ollama's `format: json` request shape.
    expect(chatFn).toHaveBeenCalledWith(
      [expect.objectContaining({ role: 'user' })],
      expect.objectContaining({ json: true, temperature: 0 }),
    );
  });

  // Issue #261: proves the probe actually CANCELS a slow/hung provider call
  // on timeout rather than merely abandoning its promise — the underlying
  // "request" (here, a background timer standing in for a real Ollama
  // generation) must never run to completion once the probe has timed out.
  it('issue #261: on timeout, cancels the in-flight chat() call (fires its signal) instead of abandoning it', async () => {
    let sawAbort = false;
    let completed = false;
    const provider = makeLLMProvider({
      chat: vi.fn((_messages, opts) => new Promise<Awaited<ReturnType<LLMProvider['chat']>>>((resolve) => {
        const t = setTimeout(() => {
          completed = true;
          resolve({ text: 'too late', usage: { in: 1, out: 1, usd: 0 } });
        }, 200);
        opts?.signal?.addEventListener('abort', () => {
          sawAbort = true;
          clearTimeout(t);
        });
      })),
    });

    const result = await llmChatProbe(provider, 20);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('timeout');
    expect(sawAbort).toBe(true);

    await new Promise((r) => setTimeout(r, 250));
    expect(completed).toBe(false);
  });
});
