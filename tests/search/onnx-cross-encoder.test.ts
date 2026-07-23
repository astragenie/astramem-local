import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mocks the shared logger module (same pattern as tests/server/score-contract.test.ts)
// so the batchSize-clamp WARN (issue #17 severity downgrade — see below) can be
// asserted directly instead of just inferred from behavior.
const { warnMock, mockLog } = vi.hoisted(() => {
  const warnMock = vi.fn();
  const mockLog: Record<string, unknown> = {
    info: vi.fn(),
    warn: warnMock,
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
  };
  mockLog['child'] = vi.fn(() => mockLog);
  return { warnMock, mockLog };
});

vi.mock('../../src/log/logger.js', () => ({
  logger: mockLog,
  childLogger: vi.fn(() => mockLog),
}));

import {
  OnnxCrossEncoderProvider,
  extractSigmoidScores,
  sigmoid,
  DEFAULT_BATCH_SIZE,
  type OnnxCrossEncoderBackend,
  type OnnxCrossEncoderConfig,
  type OnnxCrossEncoderModelOutput,
  type OnnxCrossEncoderTensorLike,
} from '../../src/search/onnx-cross-encoder.js';
import {
  DEFAULT_RERANK_DTYPE,
  DEFAULT_RERANK_HF_MODEL_ID,
  DEFAULT_RERANK_MODEL_LABEL,
  DEFAULT_RERANK_REVISION,
  RERANK_MODEL_REGISTRY,
} from '../../src/search/onnx-rerank-registry.js';
import type { CrossEncoderCandidate } from '../../src/search/rerank.js';

// ---------------------------------------------------------------------------
// Fake backend helpers — no network, no model download. These exercise
// OnnxCrossEncoderProvider's own orchestration logic (lazy-load memoization,
// batching, AbortSignal handling) via the loadBackend DI seam, mirroring
// tests/providers/embed/onnx.test.ts's posture for the embed provider.
// ---------------------------------------------------------------------------

function fakeLogitsTensor(rows: number[]): OnnxCrossEncoderTensorLike {
  return { dims: [rows.length, 1], tolist: () => rows.map((r) => [r]) };
}

/** Deterministic fake backend: score = fraction of shared word tokens between
 * query and text (same idea as the mock provider's Jaccard, but scaled to a
 * logit-ish range so sigmoid still separates high/low relevance) — never
 * touches ONNX/tokenizer/network. */
function makeFakeBackend(overrides: Partial<OnnxCrossEncoderBackend> = {}): OnnxCrossEncoderBackend {
  return {
    async tokenize(queries, texts) {
      return { queries, texts };
    },
    async run(inputs) {
      const { queries, texts } = inputs as unknown as { queries: string[]; texts: string[] };
      const rows = queries.map((q, i) => {
        const qTokens = new Set(q.toLowerCase().split(/\W+/).filter(Boolean));
        const tTokens = new Set((texts[i] ?? '').toLowerCase().split(/\W+/).filter(Boolean));
        let shared = 0;
        for (const t of qTokens) if (tTokens.has(t)) shared++;
        // Scale so a real overlap produces a clearly positive logit and no
        // overlap produces a clearly negative one — sigmoid then separates them.
        const logit = shared === 0 ? -5 : shared * 3;
        return logit;
      });
      return { logits: fakeLogitsTensor(rows) };
    },
    ...overrides,
  };
}

function providerWithFakeBackend(
  config: OnnxCrossEncoderConfig = {},
  backend?: OnnxCrossEncoderBackend,
): OnnxCrossEncoderProvider {
  const be = backend ?? makeFakeBackend();
  return new OnnxCrossEncoderProvider({ ...config, loadBackend: async () => be });
}

function candidates(pairs: Array<[string, string]>): CrossEncoderCandidate[] {
  return pairs.map(([id, text]) => ({ id, text, fusedScore: 0 }));
}

describe('onnx-cross-encoder', () => {
  beforeEach(() => {
    warnMock.mockClear();
  });

  describe('sigmoid', () => {
    it('maps 0 to 0.5', () => {
      expect(sigmoid(0)).toBeCloseTo(0.5, 6);
    });
    it('is monotonic and bounded to (0,1)', () => {
      expect(sigmoid(-100)).toBeGreaterThan(0);
      expect(sigmoid(-100)).toBeLessThan(0.001);
      // 100 saturates to exactly 1.0 in double precision — use a value large
      // enough to be "clearly positive" but small enough to stay < 1 exactly.
      expect(sigmoid(20)).toBeLessThan(1);
      expect(sigmoid(20)).toBeGreaterThan(0.999);
      expect(sigmoid(1)).toBeGreaterThan(sigmoid(0));
    });
  });

  describe('extractSigmoidScores', () => {
    it('extracts one sigmoid-transformed score per row, in order', () => {
      const output: OnnxCrossEncoderModelOutput = { logits: fakeLogitsTensor([0, 5, -5]) };
      const scores = extractSigmoidScores(output);
      expect(scores).toHaveLength(3);
      expect(scores[0]).toBeCloseTo(0.5, 4);
      expect(scores[1]!).toBeGreaterThan(0.99);
      expect(scores[2]!).toBeLessThan(0.01);
    });
  });

  describe('pinned artifact constants', () => {
    it('pins a real 40-char HF commit SHA, never "main"', () => {
      expect(DEFAULT_RERANK_REVISION).toMatch(/^[0-9a-f]{40}$/);
      expect(DEFAULT_RERANK_REVISION).not.toBe('main');
    });
    it('points at the Xenova ms-marco-MiniLM-L-6-v2 export', () => {
      expect(DEFAULT_RERANK_HF_MODEL_ID).toBe('Xenova/ms-marco-MiniLM-L-6-v2');
    });
    it('defaults to the q8 (quantized) artifact', () => {
      expect(DEFAULT_RERANK_DTYPE).toBe('q8');
    });
    it('registry entry matches the pinned constants for the default label', () => {
      const entry = RERANK_MODEL_REGISTRY[DEFAULT_RERANK_MODEL_LABEL];
      expect(entry).toBeDefined();
      expect(entry!.hfRepo).toBe(DEFAULT_RERANK_HF_MODEL_ID);
      expect(entry!.defaultRevision).toBe(DEFAULT_RERANK_REVISION);
    });
  });

  describe('OnnxCrossEncoderProvider (fake backend)', () => {
    it('has name "onnx"', () => {
      expect(providerWithFakeBackend().name).toBe('onnx');
    });

    it('reorders candidates sensibly: higher lexical overlap scores higher', async () => {
      const provider = providerWithFakeBackend();
      const scores = await provider.score(
        'sqlite vec hybrid search',
        candidates([
          ['high', 'sqlite vec bm25 fusion hybrid search'],
          ['low', 'a completely different topic about cooking'],
        ]),
      );
      expect(scores.get('high')!).toBeGreaterThan(scores.get('low')!);
    });

    it('every score is in [0,1]', async () => {
      const provider = providerWithFakeBackend();
      const scores = await provider.score('x y z', candidates([['a', 'x y z'], ['b', 'unrelated']]));
      for (const s of scores.values()) {
        expect(s).toBeGreaterThanOrEqual(0);
        expect(s).toBeLessThanOrEqual(1);
      }
    });

    it('returns an empty map for zero candidates without touching the backend', async () => {
      const loadBackend = vi.fn(async () => makeFakeBackend());
      const provider = new OnnxCrossEncoderProvider({ loadBackend });
      const scores = await provider.score('q', []);
      expect(scores.size).toBe(0);
      expect(loadBackend).not.toHaveBeenCalled();
    });

    it('memoizes the backend load across multiple score() calls', async () => {
      const loadBackend = vi.fn(async () => makeFakeBackend());
      const provider = new OnnxCrossEncoderProvider({ loadBackend });
      await provider.score('q', candidates([['a', 'a']]));
      await provider.score('q', candidates([['b', 'b']]));
      expect(loadBackend).toHaveBeenCalledTimes(1);
    });

    it('preload() triggers the same lazy load a first score() call would', async () => {
      const loadBackend = vi.fn(async () => makeFakeBackend());
      const provider = new OnnxCrossEncoderProvider({ loadBackend });
      await provider.preload();
      expect(loadBackend).toHaveBeenCalledTimes(1);
      await provider.score('q', candidates([['a', 'a']]));
      expect(loadBackend).toHaveBeenCalledTimes(1);
    });

    it('a failed load is not memoized — a later call can retry', async () => {
      let attempt = 0;
      const loadBackend = vi.fn(async () => {
        attempt++;
        if (attempt === 1) throw new Error('transient failure');
        return makeFakeBackend();
      });
      const provider = new OnnxCrossEncoderProvider({ loadBackend });
      await expect(provider.score('q', candidates([['a', 'a']]))).rejects.toThrow('transient failure');
      const scores = await provider.score('q', candidates([['a', 'a']]));
      expect(scores.get('a')).toBeDefined();
      expect(loadBackend).toHaveBeenCalledTimes(2);
    });

    it('batches candidates according to batchSize, calling run() once per batch', async () => {
      let runCalls = 0;
      const backend = makeFakeBackend({
        async run(inputs) {
          runCalls++;
          const { queries } = inputs as unknown as { queries: string[] };
          return { logits: fakeLogitsTensor(queries.map(() => 1)) };
        },
      });
      const provider = providerWithFakeBackend({ batchSize: 2 }, backend);
      const scores = await provider.score(
        'q',
        candidates([
          ['a', 'x'],
          ['b', 'y'],
          ['c', 'z'],
          ['d', 'w'],
          ['e', 'v'],
        ]),
      );
      expect(runCalls).toBe(3); // 2 + 2 + 1
      expect(scores.size).toBe(5);
    });

    it('respects an already-aborted signal between batches', async () => {
      const provider = providerWithFakeBackend({ batchSize: 1 });
      const controller = new AbortController();
      controller.abort();
      await expect(
        provider.score('q', candidates([['a', 'a'], ['b', 'b']]), controller.signal),
      ).rejects.toThrow();
    });

    it('resolves hfModelId/revision/dtype from the registry when only `model` is set', () => {
      // Indirect assertion: constructing with an unregistered model falls back
      // to the hardcoded DEFAULT_* constants rather than throwing — proves the
      // resolution chain (explicit > registry > hardcoded default) runs without
      // needing to reach into private fields.
      expect(() => new OnnxCrossEncoderProvider({ model: 'totally-unregistered-model' })).not.toThrow();
      expect(() => new OnnxCrossEncoderProvider({ model: DEFAULT_RERANK_MODEL_LABEL })).not.toThrow();
    });
  });

  // Issue #17: the old guard was
  // `config.batchSize && config.batchSize > 0 ? Math.floor(config.batchSize) : DEFAULT_BATCH_SIZE`.
  // A fractional 0<batchSize<1 (e.g. 0.5) passes `>0`, then `Math.floor(0.5)`
  // collapses it to 0 — `score()`'s `for (i=0;i<candidates.length;i+=this.batchSize)`
  // never advances `i`. Against the fake backend used elsewhere in this file
  // (no macrotask boundary) that spins forever; against the REAL onnxruntime
  // backend it doesn't hang (session.run() runs inside a setImmediate
  // macrotask, and the tokenizer throws on an empty batch), so the actual
  // observable failure is a SILENT no-op rerank on every call, not a hang —
  // severity was re-checked and downgraded accordingly. Either way the fix
  // floors FIRST, then requires the result be >=1 before accepting it, so 0,
  // negative, and NaN batchSize all fall back to DEFAULT_BATCH_SIZE the same
  // way a fractional one now does — and, per that re-check, the fallback is
  // no longer silent: an out-of-range override now logs a WARN (ADR-015 —
  // silently substituting a default for a bad override makes the misconfig
  // indistinguishable from a correct one).
  describe('batchSize normalization (issue #17 — fractional/zero/negative/NaN batchSize falls back to DEFAULT_BATCH_SIZE, loudly)', () => {
    /** Runs score() over `numCandidates` fake candidates with the given raw
     *  `batchSize` config and returns how many `run()` batches it took —
     *  proves both (a) the constructor normalized batchSize to something
     *  >=1 (otherwise this call never resolves and the test itself times
     *  out) and (b) exactly which value it normalized to. */
    async function runBatchCountFor(
      batchSizeConfig: number | undefined,
      numCandidates: number,
    ): Promise<{ runCalls: number; scored: number }> {
      let runCalls = 0;
      const backend = makeFakeBackend({
        async run(inputs) {
          runCalls++;
          const { queries } = inputs as unknown as { queries: string[] };
          return { logits: fakeLogitsTensor(queries.map(() => 1)) };
        },
      });
      const provider = providerWithFakeBackend({ batchSize: batchSizeConfig }, backend);
      const cands = candidates(
        Array.from({ length: numCandidates }, (_, i) => [`id${i}`, `text${i}`] as [string, string]),
      );
      const scores = await provider.score('q', cands);
      return { runCalls, scored: scores.size };
    }

    // 20 candidates over DEFAULT_BATCH_SIZE (16) -> ceil(20/16) = 2 batches.
    const expectedDefaultRunCalls = Math.ceil(20 / DEFAULT_BATCH_SIZE);

    it('batchSize 0.5 falls back to DEFAULT_BATCH_SIZE instead of flooring to 0, and logs a WARN', async () => {
      const { runCalls, scored } = await runBatchCountFor(0.5, 20);
      expect(scored).toBe(20);
      expect(runCalls).toBe(expectedDefaultRunCalls);
      expect(warnMock).toHaveBeenCalledTimes(1);
      expect(warnMock.mock.calls[0]?.[0]).toMatchObject({ configured_batch_size: 0.5, effective_batch_size: DEFAULT_BATCH_SIZE });
    });

    it('batchSize 0 falls back to DEFAULT_BATCH_SIZE, and logs a WARN', async () => {
      const { runCalls, scored } = await runBatchCountFor(0, 20);
      expect(scored).toBe(20);
      expect(runCalls).toBe(expectedDefaultRunCalls);
      expect(warnMock).toHaveBeenCalledTimes(1);
      expect(warnMock.mock.calls[0]?.[0]).toMatchObject({ configured_batch_size: 0, effective_batch_size: DEFAULT_BATCH_SIZE });
    });

    it('batchSize -1 falls back to DEFAULT_BATCH_SIZE, and logs a WARN', async () => {
      const { runCalls, scored } = await runBatchCountFor(-1, 20);
      expect(scored).toBe(20);
      expect(runCalls).toBe(expectedDefaultRunCalls);
      expect(warnMock).toHaveBeenCalledTimes(1);
      expect(warnMock.mock.calls[0]?.[0]).toMatchObject({ configured_batch_size: -1, effective_batch_size: DEFAULT_BATCH_SIZE });
    });

    it('batchSize NaN falls back to DEFAULT_BATCH_SIZE, and logs a WARN', async () => {
      const { runCalls, scored } = await runBatchCountFor(Number.NaN, 20);
      expect(scored).toBe(20);
      expect(runCalls).toBe(expectedDefaultRunCalls);
      expect(warnMock).toHaveBeenCalledTimes(1);
      expect(warnMock.mock.calls[0]?.[0]).toMatchObject({ effective_batch_size: DEFAULT_BATCH_SIZE });
      expect(Number.isNaN(warnMock.mock.calls[0]?.[0]?.configured_batch_size)).toBe(true);
    });

    it('a valid batchSize of exactly 1 is honored, not treated as invalid, and logs NO warn', async () => {
      const { runCalls, scored } = await runBatchCountFor(1, 3);
      expect(scored).toBe(3);
      expect(runCalls).toBe(3); // one candidate per batch
      expect(warnMock).not.toHaveBeenCalled();
    });

    it('an omitted batchSize (default path) logs NO warn', async () => {
      const { scored } = await runBatchCountFor(undefined, 3);
      expect(scored).toBe(3);
      expect(warnMock).not.toHaveBeenCalled();
    });

    it('score() terminates instead of spinning forever on a pathological batchSize (direct regression)', async () => {
      // With the pre-fix guard this call never resolves — this.batchSize
      // stays 0 and the for-loop's `i` never advances — so the test would
      // time out instead of completing. Asserting completion IS the
      // regression check.
      const provider = providerWithFakeBackend({ batchSize: 0.5 });
      const scores = await provider.score('q', candidates([['a', 'a'], ['b', 'b'], ['c', 'c']]));
      expect(scores.size).toBe(3);
    });
  });
});
