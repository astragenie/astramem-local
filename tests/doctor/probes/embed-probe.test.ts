import { describe, it, expect, vi } from 'vitest';
import type { EmbedProvider } from '../../../src/contracts/embed.js';
import { embedProbe } from '../../../src/doctor/probes/embed-probe.js';

function makeEmbedProvider(
  overrides: {
    name?: 'ollama' | 'azure-openai';
    model?: string;
    embed?: EmbedProvider['embed'];
    health?: EmbedProvider['health'];
  } = {},
): EmbedProvider {
  return {
    name: overrides.name ?? 'ollama',
    model: overrides.model ?? 'nomic-embed-text-v2-moe',
    dim: 1024,
    embed:
      overrides.embed ??
      vi.fn().mockResolvedValue([new Float32Array(1024).fill(0.1)]),
    health:
      overrides.health ??
      vi.fn().mockResolvedValue({ ok: true, model: 'nomic-embed-text-v2-moe', dim: 1024 }),
  };
}

describe('embedProbe', () => {
  it('returns ok:true when provider returns 1024-dim vector', async () => {
    const provider = makeEmbedProvider();
    const result = await embedProbe(provider, 5000);
    expect(result.ok).toBe(true);
    expect(result.message).toContain('1024-dim');
    expect(result.message).toContain('ollama/nomic-embed-text-v2-moe');
  });

  it('returns ok:false when dim is 768 (mismatch)', async () => {
    const provider = makeEmbedProvider({
      embed: vi.fn().mockResolvedValue([new Float32Array(768).fill(0.1)]),
    });
    const result = await embedProbe(provider, 5000);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('dim 768');
    expect(result.message).toContain('expected 1024');
    expect(result.fix).toContain('Misconfigured embed provider');
  });

  it('returns ok:false when dim is 0 (empty vector)', async () => {
    const provider = makeEmbedProvider({
      embed: vi.fn().mockResolvedValue([new Float32Array(0)]),
    });
    const result = await embedProbe(provider, 5000);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('dim 0');
  });

  it('returns ok:false when result array is empty (no vectors returned)', async () => {
    const provider = makeEmbedProvider({
      embed: vi.fn().mockResolvedValue([]),
    });
    const result = await embedProbe(provider, 5000);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('dim 0');
  });

  it('returns ok:false when provider throws', async () => {
    const provider = makeEmbedProvider({
      embed: vi.fn().mockRejectedValue(new Error('model not found')),
    });
    const result = await embedProbe(provider, 5000);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('model not found');
    expect(result.fix).toContain('provider config');
  });

  it('returns ok:false on timeout', async () => {
    const provider = makeEmbedProvider({
      embed: vi.fn().mockReturnValue(new Promise(() => {})),
    });
    const result = await embedProbe(provider, 50);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('timeout');
  });

  it('calls embed with [\'ping\']', async () => {
    const embedFn = vi.fn().mockResolvedValue([new Float32Array(1024).fill(0.1)]);
    const provider = makeEmbedProvider({ embed: embedFn });
    await embedProbe(provider, 5000);
    expect(embedFn).toHaveBeenCalledWith(['ping']);
  });

  it('includes latency in success message', async () => {
    const provider = makeEmbedProvider();
    const result = await embedProbe(provider, 5000);
    expect(result.message).toMatch(/in \d+ms/);
  });
});
