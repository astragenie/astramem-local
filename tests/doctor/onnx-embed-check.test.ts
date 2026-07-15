/**
 * tests/doctor/onnx-embed-check.test.ts
 *
 * ADR-018 SLICE-2 — `checkOnnxEmbedHealth` (src/doctor/checks/onnx-embed.ts):
 * an additive, onnx-scoped supplementary doctor check, distinct from the
 * generic `checkEmbed` (embed.ts) that already probes ANY EmbedProvider via
 * a real embed() call. This suite proves:
 *
 *   1. the check itself reports ok/fail correctly off a stubbed
 *      EmbedProvider.health() (no real ONNX session, no model download);
 *   2. the registry (`getChecks`) only ever adds it when the supplied
 *      `embedProvider` is actually an `OnnxEmbedProvider` instance — an
 *      ollama/azure/mock provider must never see this check in its results;
 *   3. it declares tier: 'full' — by construction (see the check's own doc
 *      comment: it's gated on `opts.embedProvider`, which the frequent tier
 *      always strips), not an accident.
 */
import { describe, it, expect } from 'vitest';
import { checkOnnxEmbedHealth } from '../../src/doctor/checks/onnx-embed.js';
import { getChecks } from '../../src/doctor/checks.js';
import { OnnxEmbedProvider } from '../../src/providers/embed/onnx.js';
import { makeMockProviders } from '../../src/pipeline/mock-providers.js';
import type { EmbedHealth, EmbedProvider } from '../../src/contracts/embed.js';

function stubProvider(health: EmbedHealth): EmbedProvider {
  return {
    name: 'onnx',
    model: health.model,
    dim: health.dim,
    async embed() {
      return [];
    },
    async health() {
      return health;
    },
  };
}

describe('checkOnnxEmbedHealth (ADR-018 SLICE-2)', () => {
  it('declares tier "full"', () => {
    const check = checkOnnxEmbedHealth(stubProvider({ ok: true, model: 'mxbai-embed-large-v1', dim: 1024 }));
    expect(check.tier).toBe('full');
  });

  it('ok:true with a descriptive message when health() reports ok', async () => {
    const check = checkOnnxEmbedHealth(stubProvider({ ok: true, model: 'mxbai-embed-large-v1', dim: 1024 }));
    const result = await check.run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('mxbai-embed-large-v1');
    expect(result.message).toContain('1024-dim');
  });

  it('ok:false with onnx-specific fix guidance when health() reports failure', async () => {
    const check = checkOnnxEmbedHealth(
      stubProvider({ ok: false, model: 'mxbai-embed-large-v1', dim: 1024, error: 'model artifact not found' }),
    );
    const result = await check.run();
    expect(result.ok).toBe(false);
    expect(result.message).toContain('model artifact not found');
    expect(result.fix).toMatch(/onnxEmbed\.modelPath/);
  });

  it('ok:false with a generic message when health() fails without an error string', async () => {
    const check = checkOnnxEmbedHealth(stubProvider({ ok: false, model: 'mxbai-embed-large-v1', dim: 1024 }));
    const result = await check.run();
    expect(result.ok).toBe(false);
    expect(result.message).toContain('unknown failure');
  });

  describe('registry gating (getChecks)', () => {
    it('includes "ONNX embed health" when embedProvider is an OnnxEmbedProvider instance', async () => {
      const provider = new OnnxEmbedProvider({
        loadBackend: async () => ({
          async tokenize() {
            return { attention_mask: { dims: [1, 1], tolist: () => [[1]] } };
          },
          async run() {
            return { last_hidden_state: { dims: [1, 1], tolist: () => [[1]] } };
          },
          async pool() {
            return [new Float32Array(1024).fill(0.01)];
          },
        }),
      });
      const checks = getChecks({ embedProvider: provider });
      const names = checks.map((c) => c.name);
      expect(names.some((n) => n.startsWith('ONNX embed health'))).toBe(true);
    });

    it('does NOT include "ONNX embed health" for a non-onnx (mock) embed provider', async () => {
      const providers = makeMockProviders();
      const checks = getChecks({ embedProvider: providers.embed });
      const names = checks.map((c) => c.name);
      expect(names.some((n) => n.startsWith('ONNX embed health'))).toBe(false);
      // Sanity: the generic embed probe IS still present for the mock provider.
      expect(names.some((n) => n.startsWith('Embed probe'))).toBe(true);
    });

    it('does NOT include "ONNX embed health" when no embedProvider is supplied at all', () => {
      const checks = getChecks({});
      const names = checks.map((c) => c.name);
      expect(names.some((n) => n.startsWith('ONNX embed health'))).toBe(false);
    });
  });
});
