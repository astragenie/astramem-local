import { describe, it, expect, vi } from 'vitest';
import type { LLMProvider } from '../../../src/contracts/llm.js';
import { llmChatProbe } from '../../../src/doctor/probes/llm-chat-probe.js';

function makeLLMProvider(
  overrides: Partial<LLMProvider> & { name?: 'ollama' | 'azure-openai'; model?: string },
): LLMProvider {
  return {
    name: overrides.name ?? 'ollama',
    model: overrides.model ?? 'qwen2.5-coder:7b',
    chat: overrides.chat ?? vi.fn().mockResolvedValue({ text: '1', usage: { in: 1, out: 1, usd: 0 } }),
    health: overrides.health ?? vi.fn().mockResolvedValue({ ok: true, model: 'qwen2.5-coder:7b', latency_ms: 10 }),
  };
}

describe('llmChatProbe', () => {
  it('returns ok:true when provider returns non-empty response', async () => {
    const provider = makeLLMProvider({
      chat: vi.fn().mockResolvedValue({ text: '1', usage: { in: 1, out: 1, usd: 0 } }),
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

  it('passes {maxTokens:1, temperature:0} to provider.chat', async () => {
    const chatFn = vi.fn().mockResolvedValue({ text: 'ok', usage: { in: 1, out: 1, usd: 0 } });
    const provider = makeLLMProvider({ chat: chatFn });
    await llmChatProbe(provider, 5000);
    expect(chatFn).toHaveBeenCalledWith(
      [{ role: 'user', content: '1' }],
      { maxTokens: 1, temperature: 0 },
    );
  });
});
