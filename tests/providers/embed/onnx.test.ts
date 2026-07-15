import { describe, it, expect, vi } from 'vitest';
import {
  OnnxEmbedProvider,
  poolMeanNormalize,
  poolClsNormalize,
  DEFAULT_ONNX_HF_MODEL_ID,
  DEFAULT_ONNX_REVISION,
  DEFAULT_ONNX_DTYPE,
  DEFAULT_ONNX_POOLING,
  ONNX_MODEL_REGISTRY,
  type OnnxEmbedConfig,
  type OnnxBackend,
  type OnnxTensorLike,
  type OnnxPoolingStrategy,
} from '../../../src/providers/embed/onnx.js';
import { QUERY_PREFIX_BY_MODEL } from '../../../src/contracts/embed.js';
import { runEmbedContractSuite } from '../_contract-suite.js';

// ---------------------------------------------------------------------------
// Fake backend helpers — no network, no model download. These exercise
// OnnxEmbedProvider's own orchestration logic (lazy-load memoization,
// dim-assert, AbortSignal handling, health() shape) via the loadBackend DI
// seam (SLICE-1 AC: pure-logic tests always-on).
// ---------------------------------------------------------------------------

function makeUnitVec(dim: number, seed = 0): Float32Array {
  const raw = Array.from({ length: dim }, (_, i) => Math.sin(seed + i * 0.01) + 1e-6);
  const norm = Math.sqrt(raw.reduce((s, v) => s + v * v, 0));
  return new Float32Array(raw.map((v) => v / norm));
}

function fakeTensor(): OnnxTensorLike {
  return { dims: [1, 1], tolist: () => [[1]] };
}

/** Deterministic fake OnnxBackend — never touches ONNX/tokenizer/network. */
function makeFakeBackend(opts: { dim?: number; vecs?: Float32Array[] } = {}): OnnxBackend {
  const dim = opts.dim ?? 1024;
  let call = 0;
  return {
    async tokenize() {
      return { attention_mask: fakeTensor() };
    },
    async run() {
      return { last_hidden_state: fakeTensor() };
    },
    async pool() {
      const vec = opts.vecs ? opts.vecs[call % opts.vecs.length]! : makeUnitVec(dim, call);
      call++;
      return [vec];
    },
  };
}

function providerWithFakeBackend(
  overrides: OnnxEmbedConfig = {},
  backend?: OnnxBackend,
): OnnxEmbedProvider {
  const be = backend ?? makeFakeBackend({ dim: overrides.dim ?? 1024 });
  return new OnnxEmbedProvider({ ...overrides, loadBackend: async () => be });
}

describe('onnx-embed', () => {
  // -------------------------------------------------------------------------
  // Contract suite — fake backend, always-on, no network/model download.
  // -------------------------------------------------------------------------
  runEmbedContractSuite('onnx', () => providerWithFakeBackend());

  describe('pinned artifact constants (ADR-018 Risk A)', () => {
    it('pins a real 40-char HF commit SHA, never "main"', () => {
      expect(DEFAULT_ONNX_REVISION).toMatch(/^[0-9a-f]{40}$/);
      expect(DEFAULT_ONNX_REVISION).not.toBe('main');
    });

    it('points at the mixedbread-ai first-party repo', () => {
      expect(DEFAULT_ONNX_HF_MODEL_ID).toBe('mixedbread-ai/mxbai-embed-large-v1');
    });

    it('defaults to the q8 (onnx/model_quantized.onnx) artifact', () => {
      expect(DEFAULT_ONNX_DTYPE).toBe('q8');
    });
  });

  // ---------------------------------------------------------------------------
  // ADR-018 SLICE-5 — model registry. "Add a model = one entry" is the
  // stated goal; these tests pin the two seeded entries' shape and guard
  // against the registry's audit-trail `queryPrefix` field silently
  // drifting from the actual runtime source of truth (QUERY_PREFIX_BY_MODEL,
  // contracts/embed.ts).
  // ---------------------------------------------------------------------------
  describe('ONNX_MODEL_REGISTRY (ADR-018 SLICE-5)', () => {
    it('registers mxbai-embed-large-v1 with cls pooling (corrected default)', () => {
      const entry = ONNX_MODEL_REGISTRY['mxbai-embed-large-v1'];
      expect(entry).toBeDefined();
      expect(entry!.hfRepo).toBe('mixedbread-ai/mxbai-embed-large-v1');
      expect(entry!.defaultRevision).toBe(DEFAULT_ONNX_REVISION);
      expect(entry!.defaultDtype).toBe('q8');
      expect(entry!.pooling).toBe('cls');
    });

    it('registers bge-m3 pinned to the Xenova export with cls pooling', () => {
      const entry = ONNX_MODEL_REGISTRY['bge-m3'];
      expect(entry).toBeDefined();
      expect(entry!.hfRepo).toBe('Xenova/bge-m3');
      expect(entry!.defaultRevision).toBe('4de13258303883538bd53b696b452bf8099f0858');
      expect(entry!.defaultRevision).toMatch(/^[0-9a-f]{40}$/);
      expect(entry!.defaultDtype).toBe('q8');
      expect(entry!.pooling).toBe('cls');
    });

    it('never pins "main" as a revision for any registered model', () => {
      for (const [model, entry] of Object.entries(ONNX_MODEL_REGISTRY)) {
        expect(entry.defaultRevision, `${model} revision`).not.toBe('main');
        expect(entry.defaultRevision, `${model} revision`).toMatch(/^[0-9a-f]{40}$/);
      }
    });

    it('every registry entry queryPrefix stays in sync with QUERY_PREFIX_BY_MODEL (no silent drift)', () => {
      for (const [model, entry] of Object.entries(ONNX_MODEL_REGISTRY)) {
        expect(entry.queryPrefix, `${model} queryPrefix`).toBe(QUERY_PREFIX_BY_MODEL[model] ?? '');
      }
    });

    it('DEFAULT_ONNX_POOLING (fallback for unregistered models) is mean, not cls', () => {
      // Preserves SLICE-1/2 behavior for any model string not yet onboarded
      // into the registry — only the two registered models default to cls.
      expect(DEFAULT_ONNX_POOLING).toBe('mean');
    });
  });

  // ---------------------------------------------------------------------------
  // ADR-018 SLICE-5 — pooling/artifact resolution dispatch. Exercised via
  // the loadBackend DI seam: capture the ResolvedOnnxLoadOpts the provider
  // actually hands to the backend loader, without downloading a real model.
  // ---------------------------------------------------------------------------
  describe('model resolution dispatch (registry vs explicit override)', () => {
    function captureLoadOpts(): {
      loadBackend: NonNullable<OnnxEmbedConfig['loadBackend']>;
      captured: { current?: { hfModelId: string; revision: string; dtype: string; pooling: OnnxPoolingStrategy } };
    } {
      const captured: { current?: { hfModelId: string; revision: string; dtype: string; pooling: OnnxPoolingStrategy } } = {};
      const loadBackend: NonNullable<OnnxEmbedConfig['loadBackend']> = async (opts) => {
        captured.current = opts;
        return makeFakeBackend();
      };
      return { loadBackend, captured };
    }

    it('defaults to mxbai-embed-large-v1 registry entry (cls pooling) when model is unset', async () => {
      const { loadBackend, captured } = captureLoadOpts();
      const p = new OnnxEmbedProvider({ loadBackend });
      await p.embed(['x']);
      expect(captured.current?.hfModelId).toBe('mixedbread-ai/mxbai-embed-large-v1');
      expect(captured.current?.pooling).toBe('cls');
    });

    it('resolves bge-m3 registry entry when model: "bge-m3" is set — one-line model switch', async () => {
      const { loadBackend, captured } = captureLoadOpts();
      const p = new OnnxEmbedProvider({ model: 'bge-m3', loadBackend });
      await p.embed(['x']);
      expect(captured.current?.hfModelId).toBe('Xenova/bge-m3');
      expect(captured.current?.revision).toBe('4de13258303883538bd53b696b452bf8099f0858');
      expect(captured.current?.dtype).toBe('q8');
      expect(captured.current?.pooling).toBe('cls');
      expect(p.model).toBe('bge-m3');
    });

    it('falls back to DEFAULT_ONNX_POOLING (mean) for an unregistered custom model', async () => {
      const { loadBackend, captured } = captureLoadOpts();
      const p = new OnnxEmbedProvider({ model: 'some-unregistered-model', loadBackend });
      await p.embed(['x']);
      expect(captured.current?.pooling).toBe('mean');
      // hfModelId falls back to the SLICE-1 constant, not a registry entry.
      expect(captured.current?.hfModelId).toBe(DEFAULT_ONNX_HF_MODEL_ID);
    });

    it('an explicit config.pooling override wins over the registry default', async () => {
      const { loadBackend, captured } = captureLoadOpts();
      const p = new OnnxEmbedProvider({ model: 'bge-m3', pooling: 'mean', loadBackend });
      await p.embed(['x']);
      expect(captured.current?.pooling).toBe('mean');
    });

    it('an explicit config.hfModelId/revision/dtype override wins over the registry', async () => {
      const { loadBackend, captured } = captureLoadOpts();
      const p = new OnnxEmbedProvider({
        model: 'bge-m3',
        hfModelId: 'some-org/custom-bge-m3-fork',
        revision: 'deadbeef',
        dtype: 'fp32',
        loadBackend,
      });
      await p.embed(['x']);
      expect(captured.current?.hfModelId).toBe('some-org/custom-bge-m3-fork');
      expect(captured.current?.revision).toBe('deadbeef');
      expect(captured.current?.dtype).toBe('fp32');
      // pooling still resolves from the registry since it wasn't overridden.
      expect(captured.current?.pooling).toBe('cls');
    });
  });

  describe('embed()', () => {
    it('returns Float32Array[] length 1024 for each input', async () => {
      const p = providerWithFakeBackend();
      const results = await p.embed(['text one', 'text two']);
      expect(results).toHaveLength(2);
      for (const arr of results) {
        expect(arr).toBeInstanceOf(Float32Array);
        expect(arr.length).toBe(1024);
      }
    });

    it('returns [] for an empty input array without loading the backend', async () => {
      const loadBackend = vi.fn(async () => makeFakeBackend());
      const p = new OnnxEmbedProvider({ loadBackend });
      const results = await p.embed([]);
      expect(results).toEqual([]);
      expect(loadBackend).not.toHaveBeenCalled();
    });

    it('throws when dim !== configured dim', async () => {
      const backend = makeFakeBackend({ vecs: [makeUnitVec(768)] });
      const p = providerWithFakeBackend({ dim: 1024 }, backend);
      await expect(p.embed(['text'])).rejects.toThrow(/dimension mismatch.*expected 1024.*got 768/i);
    });

    it('memoizes the backend load across multiple embed() calls', async () => {
      const loadBackend = vi.fn(async () => makeFakeBackend());
      const p = new OnnxEmbedProvider({ loadBackend });
      await p.embed(['a']);
      await p.embed(['b', 'c']);
      expect(loadBackend).toHaveBeenCalledTimes(1);
    });

    it('does not memoize a failed backend load — retries on next call', async () => {
      let attempt = 0;
      const loadBackend = vi.fn(async () => {
        attempt++;
        if (attempt === 1) throw new Error('cold-start network unreachable');
        return makeFakeBackend();
      });
      const p = new OnnxEmbedProvider({ loadBackend });
      await expect(p.embed(['a'])).rejects.toThrow('cold-start network unreachable');
      const results = await p.embed(['a']);
      expect(results).toHaveLength(1);
      expect(loadBackend).toHaveBeenCalledTimes(2);
    });

    // ADR-018: signal checked BETWEEN texts, not mid-single-inference —
    // documented as a materially weaker guarantee than the HTTP providers'.
    it('honors an AbortSignal at the next between-texts checkpoint', async () => {
      const controller = new AbortController();
      let tokenizeCalls = 0;
      const backend: OnnxBackend = {
        async tokenize() {
          tokenizeCalls++;
          if (tokenizeCalls === 2) controller.abort();
          return { attention_mask: fakeTensor() };
        },
        async run() {
          return { last_hidden_state: fakeTensor() };
        },
        async pool() {
          return [makeUnitVec(1024)];
        },
      };
      const p = providerWithFakeBackend({}, backend);
      await expect(p.embed(['one', 'two', 'three'], controller.signal)).rejects.toThrow();
      // Aborted during text 2's tokenize; text 3 must never be reached.
      expect(tokenizeCalls).toBe(2);
    });
  });

  describe('preload() (ADR-018 SLICE-2 — startup preload)', () => {
    it('triggers the lazy backend load (getBackend) exactly once', async () => {
      const loadBackend = vi.fn(async () => makeFakeBackend());
      const p = new OnnxEmbedProvider({ loadBackend });
      await p.preload();
      expect(loadBackend).toHaveBeenCalledTimes(1);
    });

    it('memoizes with embed()/health() — preload() then embed() does not reload', async () => {
      const loadBackend = vi.fn(async () => makeFakeBackend());
      const p = new OnnxEmbedProvider({ loadBackend });
      await p.preload();
      await p.embed(['a']);
      await p.health();
      expect(loadBackend).toHaveBeenCalledTimes(1);
    });

    it('embed() after a successful preload() does not pay any additional load latency (already warm)', async () => {
      const loadBackend = vi.fn(async () => makeFakeBackend());
      const p = new OnnxEmbedProvider({ loadBackend });
      await p.preload();
      const results = await p.embed(['warm text']);
      expect(results).toHaveLength(1);
      expect(loadBackend).toHaveBeenCalledTimes(1);
    });

    it('rejects when the backend load fails — caller must catch, it is not swallowed', async () => {
      const p = new OnnxEmbedProvider({
        loadBackend: async () => {
          throw new Error('model artifact not found');
        },
      });
      await expect(p.preload()).rejects.toThrow('model artifact not found');
    });

    it('a failed preload() does not permanently wedge the provider — a later embed() retries', async () => {
      let attempt = 0;
      const loadBackend = vi.fn(async () => {
        attempt++;
        if (attempt === 1) throw new Error('cold-start network unreachable');
        return makeFakeBackend();
      });
      const p = new OnnxEmbedProvider({ loadBackend });
      await expect(p.preload()).rejects.toThrow('cold-start network unreachable');
      const results = await p.embed(['a']);
      expect(results).toHaveLength(1);
      expect(loadBackend).toHaveBeenCalledTimes(2);
    });
  });

  describe('queryPrefix', () => {
    it('defaults to empty string', () => {
      const p = providerWithFakeBackend();
      expect(p.queryPrefix).toBe('');
    });

    it('passes through an explicit queryPrefix unchanged (RECALL-S1, resolved upstream)', () => {
      const prefix = 'Represent this sentence for searching relevant passages: ';
      const p = providerWithFakeBackend({ queryPrefix: prefix });
      expect(p.queryPrefix).toBe(prefix);
    });
  });

  describe('health()', () => {
    it('ok:true with correct model + dim when the smoke inference succeeds', async () => {
      const p = providerWithFakeBackend();
      const h = await p.health();
      expect(h).toEqual({ ok: true, model: 'mxbai-embed-large-v1', dim: 1024 });
    });

    it('ok:false with an error message when the backend fails to load', async () => {
      const p = new OnnxEmbedProvider({
        loadBackend: async () => {
          throw new Error('model artifact not found');
        },
      });
      const h = await p.health();
      expect(h.ok).toBe(false);
      expect(h.error).toMatch(/model artifact not found/);
      expect(h.dim).toBe(1024);
    });

    it('ok:false when the smoke inference produces the wrong dim', async () => {
      const backend = makeFakeBackend({ vecs: [makeUnitVec(768)] });
      const p = providerWithFakeBackend({}, backend);
      const h = await p.health();
      expect(h.ok).toBe(false);
      expect(h.error).toMatch(/dim 768.*expected 1024/i);
    });
  });

  // ---------------------------------------------------------------------------
  // Mean-pool + L2-normalize correctness — exercises the REAL production
  // pooling code path (poolMeanNormalize — the same function
  // loadTransformersBackend wires as `pool` for real embed()/health() calls)
  // against hand-built synthetic Tensors. Tensor construction +
  // mean_pooling()/.normalize() are pure tensor math, NOT inference — no
  // ONNX session, no model download, no network involved.
  // ---------------------------------------------------------------------------
  describe('poolMeanNormalize() — mean-pool/normalize correctness', () => {
    it('excludes padding tokens (mask=0) from the mean and L2-normalizes to a unit vector', async () => {
      const { Tensor } = await import('@huggingface/transformers');
      // batch=1, seq=3, hidden=4 — token 2 is padding (mask=0) and carries
      // deliberately out-of-range values that must NOT leak into the mean.
      const lastHiddenState = new Tensor(
        'float32',
        new Float32Array([
          1, 0, 0, 0, // token 0
          0, 1, 0, 0, // token 1
          9, 9, 9, 9, // token 2 (padding — must be excluded)
        ]),
        [1, 3, 4],
      );
      const attentionMask = new Tensor('int64', BigInt64Array.from([1n, 1n, 0n]), [1, 3]);

      const [vec] = await poolMeanNormalize({ last_hidden_state: lastHiddenState }, attentionMask);

      expect(vec).toBeInstanceOf(Float32Array);
      expect(vec!.length).toBe(4);

      // Mean over the two real tokens only: [0.5, 0.5, 0, 0]; L2-normalized: [1/sqrt(2), 1/sqrt(2), 0, 0]
      const expected = 1 / Math.sqrt(2);
      expect(vec![0]).toBeCloseTo(expected, 5);
      expect(vec![1]).toBeCloseTo(expected, 5);
      expect(vec![2]).toBeCloseTo(0, 5);
      expect(vec![3]).toBeCloseTo(0, 5);

      const norm = Math.sqrt(Array.from(vec!).reduce((s, v) => s + v * v, 0));
      expect(norm).toBeCloseTo(1, 5);
    });

    it('produces a unit vector (norm ≈ 1) at production dim (1024) for a non-trivial hidden state', async () => {
      const { Tensor } = await import('@huggingface/transformers');
      const dim = 1024;
      const seqLen = 5;
      const data = new Float32Array(seqLen * dim);
      for (let i = 0; i < data.length; i++) data[i] = Math.sin(i * 0.017) * 3.7;
      const lastHiddenState = new Tensor('float32', data, [1, seqLen, dim]);
      const attentionMask = new Tensor('int64', BigInt64Array.from([1n, 1n, 1n, 1n, 1n]), [1, seqLen]);

      const [vec] = await poolMeanNormalize({ last_hidden_state: lastHiddenState }, attentionMask);
      expect(vec!.length).toBe(dim);
      const norm = Math.sqrt(Array.from(vec!).reduce((s, v) => s + v * v, 0));
      expect(norm).toBeCloseTo(1, 5);
    });
  });

  // ---------------------------------------------------------------------------
  // CLS-pool + L2-normalize correctness (ADR-018 SLICE-5) — exercises the
  // REAL production poolClsNormalize code path (the same function
  // loadTransformersBackend wires as `pool` when a model's registry entry
  // says `pooling: 'cls'`, e.g. bge-m3 and mxbai-embed-large-v1) against
  // hand-built synthetic Tensors. No ONNX session, no model download.
  // ---------------------------------------------------------------------------
  describe('poolClsNormalize() — cls-pool/normalize correctness', () => {
    it('takes ONLY the first token (index 0), ignoring later tokens entirely', async () => {
      const { Tensor } = await import('@huggingface/transformers');
      // batch=1, seq=3, hidden=4 — token 0 is [CLS]; tokens 1-2 carry
      // deliberately different values that must NOT leak into the result
      // (unlike mean pooling, CLS pooling must ignore them outright, not
      // just mask them).
      const lastHiddenState = new Tensor(
        'float32',
        new Float32Array([
          1, 0, 0, 0, // token 0 ([CLS] — the only one that matters)
          9, 9, 9, 9, // token 1 (real content, must be ignored)
          -5, -5, -5, -5, // token 2 (real content, must be ignored)
        ]),
        [1, 3, 4],
      );
      // Attention mask is unused by CLS pooling but still part of the
      // shared pool() signature — all-ones here (no padding).
      const attentionMask = new Tensor('int64', BigInt64Array.from([1n, 1n, 1n]), [1, 3]);

      const [vec] = await poolClsNormalize({ last_hidden_state: lastHiddenState }, attentionMask);

      expect(vec).toBeInstanceOf(Float32Array);
      expect(vec!.length).toBe(4);
      // [1,0,0,0] is already unit-length — normalize is a no-op here.
      expect(vec![0]).toBeCloseTo(1, 5);
      expect(vec![1]).toBeCloseTo(0, 5);
      expect(vec![2]).toBeCloseTo(0, 5);
      expect(vec![3]).toBeCloseTo(0, 5);

      const norm = Math.sqrt(Array.from(vec!).reduce((s, v) => s + v * v, 0));
      expect(norm).toBeCloseTo(1, 5);
    });

    it('L2-normalizes a non-trivial CLS vector to unit length', async () => {
      const { Tensor } = await import('@huggingface/transformers');
      const lastHiddenState = new Tensor(
        'float32',
        new Float32Array([
          3, 4, 0, 0, // token 0 ([CLS]) — norm 5 pre-normalize
          100, 100, 100, 100, // token 1 (ignored)
        ]),
        [1, 2, 4],
      );
      const attentionMask = new Tensor('int64', BigInt64Array.from([1n, 1n]), [1, 2]);

      const [vec] = await poolClsNormalize({ last_hidden_state: lastHiddenState }, attentionMask);
      expect(vec![0]).toBeCloseTo(0.6, 5); // 3/5
      expect(vec![1]).toBeCloseTo(0.8, 5); // 4/5
      const norm = Math.sqrt(Array.from(vec!).reduce((s, v) => s + v * v, 0));
      expect(norm).toBeCloseTo(1, 5);
    });

    it('produces a unit vector (norm ≈ 1) at production dim (1024) for a non-trivial hidden state', async () => {
      const { Tensor } = await import('@huggingface/transformers');
      const dim = 1024;
      const seqLen = 5;
      const data = new Float32Array(seqLen * dim);
      for (let i = 0; i < data.length; i++) data[i] = Math.sin(i * 0.017) * 3.7;
      const lastHiddenState = new Tensor('float32', data, [1, seqLen, dim]);
      const attentionMask = new Tensor('int64', BigInt64Array.from([1n, 1n, 1n, 1n, 1n]), [1, seqLen]);

      const [vec] = await poolClsNormalize({ last_hidden_state: lastHiddenState }, attentionMask);
      expect(vec!.length).toBe(dim);
      const norm = Math.sqrt(Array.from(vec!).reduce((s, v) => s + v * v, 0));
      expect(norm).toBeCloseTo(1, 5);
    });
  });

  // ---------------------------------------------------------------------------
  // Real model — gated behind ASTRA_TEST_ONNX_LIVE=1 (network + a one-time
  // ~337MB download; mirrors ollama-embed.test.ts's INTEGRATION_LIVE-gated
  // block). Never runs in default CI.
  // ---------------------------------------------------------------------------
  describe.skipIf(!process.env.ASTRA_TEST_ONNX_LIVE)('live model (real download + inference)', () => {
    it('embeds real text end-to-end at the configured dim', async () => {
      const p = new OnnxEmbedProvider();
      const vecs = await p.embed(['hello from a real onnx inference']);
      expect(vecs).toHaveLength(1);
      expect(vecs[0]!.length).toBe(1024);
      const norm = Math.sqrt(Array.from(vecs[0]!).reduce((s, v) => s + v * v, 0));
      expect(norm).toBeCloseTo(1, 3);
    }, 180_000);

    it('health() reports ok:true against the real model', async () => {
      const p = new OnnxEmbedProvider();
      const h = await p.health();
      expect(h.ok).toBe(true);
      expect(h.dim).toBe(1024);
    }, 180_000);
  });

  // ---------------------------------------------------------------------------
  // ADR-018 SLICE-5 — bge-m3 PRE-GATE. Gated behind ASTRA_TEST_ONNX_LIVE=1
  // (network + a one-time ~570MB q8 download of Xenova/bge-m3). This is a
  // SMOKE gate, not the full ADR-018 Risk-B parity harness (cosine-vs-Ollama
  // + retrieval-eval floors) — that is the benchmark's job (out of SLICE-5
  // scope per the dispatch). Exists because the bge-m3 de-risk research
  // (docs/research/20260715-bge-m3-onnx-model-matrix.md) explicitly flagged
  // "no published numeric parity check between Xenova/bge-m3's ONNX export
  // and FlagEmbedding's PyTorch reference" as an open knowledge gap — this
  // is this repo's own minimal first-party sanity check that the artifact +
  // cls-pooling wiring actually produces sane, semantically-meaningful
  // vectors (not just "runs without throwing").
  // ---------------------------------------------------------------------------
  describe.skipIf(!process.env.ASTRA_TEST_ONNX_LIVE)('live model — bge-m3 (real download + inference)', () => {
    function cosine(a: Float32Array, b: Float32Array): number {
      let dot = 0;
      for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
      return dot; // both inputs are already L2-normalized by the provider.
    }

    it('embeds real text end-to-end at dim 1024, unit-norm output', async () => {
      const p = new OnnxEmbedProvider({ model: 'bge-m3' });
      const vecs = await p.embed(['hello from a real bge-m3 onnx inference']);
      expect(vecs).toHaveLength(1);
      expect(vecs[0]!.length).toBe(1024);
      const norm = Math.sqrt(Array.from(vecs[0]!).reduce((s, v) => s + v * v, 0));
      expect(norm).toBeCloseTo(1, 3);
    }, 300_000);

    it('health() reports ok:true against the real bge-m3 model', async () => {
      const p = new OnnxEmbedProvider({ model: 'bge-m3' });
      const h = await p.health();
      expect(h.ok).toBe(true);
      expect(h.dim).toBe(1024);
      expect(h.model).toBe('bge-m3');
    }, 300_000);

    it('semantic sanity: a query is closer to its paraphrase than to an unrelated sentence', async () => {
      const p = new OnnxEmbedProvider({ model: 'bge-m3' });
      const [query, paraphrase, unrelated] = await p.embed([
        'What is the capital of France?',
        'Which city serves as the capital of France?',
        'The recipe calls for two cups of flour and a pinch of salt.',
      ]);
      const simParaphrase = cosine(query!, paraphrase!);
      const simUnrelated = cosine(query!, unrelated!);
      expect(simParaphrase).toBeGreaterThan(simUnrelated);
    }, 300_000);

    it('semantic sanity: a Chinese query is closer to its Chinese paraphrase than to an unrelated Chinese sentence (bge-m3\'s stated multilingual point)', async () => {
      const p = new OnnxEmbedProvider({ model: 'bge-m3' });
      const [query, paraphrase, unrelated] = await p.embed([
        '法国的首都是哪里?',
        '法国的首都是哪座城市?',
        '这个食谱需要两杯面粉和一撮盐。',
      ]);
      const simParaphrase = cosine(query!, paraphrase!);
      const simUnrelated = cosine(query!, unrelated!);
      expect(simParaphrase).toBeGreaterThan(simUnrelated);
    }, 300_000);
  });
});
