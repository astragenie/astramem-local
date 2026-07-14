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
    // Issue #261: a second `signal` argument is now also passed (see the
    // AbortSignal cancellation test below).
    expect(embedFn).toHaveBeenCalledWith(['ping'], expect.anything());
  });

  // Issue #261: proves the probe actually CANCELS a slow/hung embed call on
  // timeout rather than merely abandoning its promise — the underlying
  // "request" (here, a background timer standing in for a real embed call)
  // must never run to completion once the probe has timed out.
  it('issue #261: on timeout, cancels the in-flight embed() call (fires its signal) instead of abandoning it', async () => {
    let sawAbort = false;
    let completed = false;
    const provider = makeEmbedProvider({
      embed: vi.fn((_texts, signal?: AbortSignal) => new Promise<Float32Array[]>((resolve) => {
        const t = setTimeout(() => {
          completed = true;
          resolve([new Float32Array(1024).fill(0.1)]);
        }, 200);
        signal?.addEventListener('abort', () => {
          sawAbort = true;
          clearTimeout(t);
        });
      })),
    });

    const result = await embedProbe(provider, 20);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('timeout');
    expect(sawAbort).toBe(true);

    await new Promise((r) => setTimeout(r, 250));
    expect(completed).toBe(false);
  });

  it('includes latency in success message', async () => {
    const provider = makeEmbedProvider();
    const result = await embedProbe(provider, 5000);
    expect(result.message).toMatch(/in \d+ms/);
  });

  // FEAT-409 AC-3 — expectedDim is DERIVED from provider.dim (config-driven
  // via providers/index.ts), not a hardcoded 1024 constant. A provider
  // configured for dim=768 whose actual output is 1024-dim (the OPPOSITE
  // mismatch direction from the '768 (mismatch)' case above) must still
  // fail loud, proving the expectation tracks the provider's own dim.
  it('derives expectedDim from provider.dim (768-configured provider, 1024 actual output)', async () => {
    const provider = makeEmbedProvider({
      embed: vi.fn().mockResolvedValue([new Float32Array(1024).fill(0.1)]),
    });
    (provider as { dim: number }).dim = 768;
    const result = await embedProbe(provider, 5000);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('dim 1024');
    expect(result.message).toContain('expected 768');
  });

  it('succeeds when a non-default configured dim matches actual output (768/768)', async () => {
    const provider = makeEmbedProvider({
      embed: vi.fn().mockResolvedValue([new Float32Array(768).fill(0.1)]),
    });
    (provider as { dim: number }).dim = 768;
    const result = await embedProbe(provider, 5000);
    expect(result.ok).toBe(true);
    expect(result.message).toContain('768-dim');
  });

  it('an explicit expectedDim overrides the provider.dim default', async () => {
    const provider = makeEmbedProvider({
      embed: vi.fn().mockResolvedValue([new Float32Array(1024).fill(0.1)]),
    });
    const result = await embedProbe(provider, 5000, 1024);
    expect(result.ok).toBe(true);
  });
});
