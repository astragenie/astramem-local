import { describe, it, expect, vi } from 'vitest';
import {
  loadConfig,
  defaultConfig,
  applyFusionGovernance,
  applyDurabilityGateGovernance,
  applyExtractProfileGovernance,
  applyAudioModeGovernance,
  applyCandidateSelectionGovernance,
  applyContradictionDetectionGovernance,
} from '../../src/config/config.js';

describe('loadConfig', () => {
  it('returns defaults when no file present', () => {
    const cfg = loadConfig(undefined);
    expect(cfg.port).toBe(7777);
    expect(cfg.embedding.provider).toBe('onnx');
    expect(cfg.budget.daily_usd).toBe(10);
  });

  it('overrides defaults from passed object', () => {
    const cfg = loadConfig({ port: 8888 } as any);
    expect(cfg.port).toBe(8888);
    expect(cfg.embedding.provider).toBe('onnx');
  });

  it('dev no-auth mode defaults to off', () => {
    expect(defaultConfig().auth.devNoAuth).toBe(false);
  });

  // A shipped default with no assertion is how it silently drifts.
  // 2026-07-14 (v0.18.0): both compaction and extraction moved off
  // ollama/qwen3.5:4b to codex-subscription/gpt-5.4-mini — every local-ollama
  // qwen default has broken at least one shipped install (empty output under
  // thinking mode, VRAM spill; see "qwen3:8b breaks distill extract" /
  // "Ollama 8GB VRAM ceiling" in CLAUDE.md). codex-subscription runs off-box
  // against the operator's own ChatGPT plan and requires `codex login`.
  // Embedding default flipped to in-process ONNX (ADR-018, 2026-07-15): same
  // mxbai-embed-large model, 0.989 cosine parity with Ollama-mxbai, no Ollama
  // process required. Model name is unchanged (registry key); only the runtime
  // provider changed.
  it('llm.compaction/extraction default to codex-subscription/gpt-5.4-mini', () => {
    const cfg = defaultConfig();
    expect(cfg.llm.compaction.provider).toBe('codex-subscription');
    expect(cfg.llm.compaction.model).toBe('gpt-5.4-mini');
    expect(cfg.llm.extraction.provider).toBe('codex-subscription');
    expect(cfg.llm.extraction.model).toBe('gpt-5.4-mini');
    expect(cfg.embedding.provider).toBe('onnx');
    expect(cfg.embedding.model).toBe('mxbai-embed-large');
  });

  it('default config search weights are unchanged by governance (default behavior preserved)', () => {
    const cfg = loadConfig(undefined);
    expect(cfg.search).toEqual(defaultConfig().search);
    expect(cfg.search.eta).toBe(0);
  });

  // FEAT-442: autonomous consolidation auto-accept defaults OFF.
  it('consolidation.autoAcceptThreshold defaults to null (OFF)', () => {
    const cfg = loadConfig(undefined);
    expect(cfg.consolidation.autoAcceptThreshold).toBeNull();
    expect(defaultConfig().consolidation.autoAcceptThreshold).toBeNull();
  });

  it('consolidation.autoAcceptThreshold can be overridden', () => {
    const cfg = loadConfig({ consolidation: { autoAcceptThreshold: 0.9 } } as any);
    expect(cfg.consolidation.autoAcceptThreshold).toBe(0.9);
  });

  // P2.1 stabilization: k-NN candidate selection defaults OFF ('full' —
  // byte-identical to pre-P2.1 behavior).
  it("consolidation.candidateSelection defaults to 'full', knnK to 30, maxCandidatePairsPerRun to null", () => {
    const cfg = loadConfig(undefined);
    expect(cfg.consolidation.candidateSelection).toBe('full');
    expect(cfg.consolidation.knnK).toBe(30);
    expect(cfg.consolidation.maxCandidatePairsPerRun).toBeNull();
    expect(defaultConfig().consolidation.candidateSelection).toBe('full');
  });

  it('consolidation.candidateSelection/knnK/maxCandidatePairsPerRun can be overridden', () => {
    const cfg = loadConfig({
      consolidation: { candidateSelection: 'knn', knnK: 50, maxCandidatePairsPerRun: 5000 },
    } as any);
    expect(cfg.consolidation.candidateSelection).toBe('knn');
    expect(cfg.consolidation.knnK).toBe(50);
    expect(cfg.consolidation.maxCandidatePairsPerRun).toBe(5000);
  });

  // FEAT-455 / ADR-012 decision 4: default OFF, never enabled implicitly.
  it('capture.autoCapture.enabled defaults to false (OFF)', () => {
    const cfg = loadConfig(undefined);
    expect(cfg.capture.autoCapture.enabled).toBe(false);
    expect(defaultConfig().capture.autoCapture.enabled).toBe(false);
  });

  it('capture.autoCapture.relevanceGate defaults match the spike spec (checklist #2)', () => {
    const cfg = defaultConfig();
    expect(cfg.capture.autoCapture.relevanceGate).toEqual({ minChars: 8, maxBytes: 65536, dedupWindow: 20 });
  });

  it('capture.autoCapture.enabled can be overridden — an explicit opt-in round-trips', () => {
    const cfg = loadConfig({ capture: { autoCapture: { enabled: true } } } as any);
    expect(cfg.capture.autoCapture.enabled).toBe(true);
  });

  // distill.costCap ships OFF for beta — codex-subscription (the default
  // compaction/extraction provider) reports usage.usd: 0 always, so a
  // dollar cap can never trip; this call-count/wall-clock cap is opt-in
  // per-operator instead. See Config['distill']['costCap']'s doc comment.
  it('distill.costCap defaults to disabled (beta default, byte-identical no-op)', () => {
    const cfg = loadConfig(undefined);
    expect(cfg.distill.costCap).toEqual({ enabled: false });
    expect(defaultConfig().distill.costCap).toEqual({ enabled: false });
  });

  it('distill.costCap can be overridden — an explicit opt-in with limits round-trips', () => {
    // loadConfig's top-level override merge is shallow (see
    // applyContradictionDetectionGovernance's doc comment), so the override
    // spreads the rest of defaultConfig().distill to avoid losing sibling
    // fields (durabilityGate/extractProfile/etc.) — this test only cares
    // about costCap round-tripping.
    const cfg = loadConfig({
      distill: { ...defaultConfig().distill, costCap: { enabled: true, maxCallsPerJob: 20, maxWallClockMs: 60_000 } },
    } as any);
    expect(cfg.distill.costCap).toEqual({ enabled: true, maxCallsPerJob: 20, maxWallClockMs: 60_000 });
  });

  // Dual-pass extraction shipped as the default 2026-07-15 (measured LoCoMo
  // full-suite gain 0.4610 -> 0.5549; see Config['distill']['extractionPasses']'s
  // doc comment). A shipped default with no assertion is how it silently
  // drifts back — same rationale as the compaction/extraction provider test
  // above.
  it('distill.extractionPasses defaults to 2 (dual-pass, shipped default)', () => {
    const cfg = loadConfig(undefined);
    expect(cfg.distill.extractionPasses).toBe(2);
    expect(defaultConfig().distill.extractionPasses).toBe(2);
  });

  it('distill.extractionPasses: 1 can be overridden — an explicit single-pass opt-out round-trips', () => {
    // Same shallow-merge caveat as the costCap override test above: spread
    // the rest of defaultConfig().distill so sibling fields aren't lost.
    const cfg = loadConfig({
      distill: { ...defaultConfig().distill, extractionPasses: 1 },
    } as any);
    expect(cfg.distill.extractionPasses).toBe(1);
  });
});

// FEAT-428: fusion-model governance — component ceiling + η eval-evidence
// gate. Arch-review of FEAT-426 findings 1+3: no ceiling on additive fusion
// weights, no eval evidence backing any nonzero optional weight.
describe('applyFusionGovernance', () => {
  const baseSearch = () => defaultConfig().search;

  it('leaves a compliant default config byte-identical (governance is a guard, not a behavior change)', () => {
    const search = baseSearch();
    const governed = applyFusionGovernance(search);
    expect(governed).toEqual(search);
  });

  it('clamps a component weight that exceeds the configured ceiling and logs why', () => {
    const search = { ...baseSearch(), alpha: 40 }; // typo'd 40 instead of 0.4
    const logs: string[] = [];
    const governed = applyFusionGovernance(search, { log: (m) => logs.push(m) });

    expect(governed.alpha).toBe(search.governance.maxComponentWeight);
    expect(logs.some(m => m.includes('search.alpha=40') && m.includes('ceiling'))).toBe(true);
  });

  it('clamps every over-ceiling component independently, leaving compliant ones untouched', () => {
    const search = { ...baseSearch(), gamma: 5, delta: 0.1 };
    const governed = applyFusionGovernance(search);
    expect(governed.gamma).toBe(search.governance.maxComponentWeight);
    expect(governed.delta).toBe(0.1);
    expect(governed.alpha).toBe(0.4);
  });

  it('respects a configured (non-default) ceiling', () => {
    const search = {
      ...baseSearch(),
      beta: 0.5,
      governance: { maxComponentWeight: 0.45 },
    };
    const governed = applyFusionGovernance(search);
    expect(governed.beta).toBe(0.45);
  });

  it('eta>0 with no recorded eval evidence is refused — forced back to 0 — and logs why', () => {
    const search = { ...baseSearch(), eta: 0.3 };
    const logs: string[] = [];
    const governed = applyFusionGovernance(search, {
      log: (m) => logs.push(m),
      checkEvalEvidence: () => false,
    });

    expect(governed.eta).toBe(0);
    expect(logs.some(m => m.includes('search.eta=0.3') && m.includes('eval'))).toBe(true);
  });

  it('eta>0 WITH passing recorded eval evidence is allowed to activate', () => {
    const search = { ...baseSearch(), eta: 0.3 };
    const governed = applyFusionGovernance(search, { checkEvalEvidence: () => true });
    expect(governed.eta).toBe(0.3);
  });

  it('eta=0 (default) never consults eval evidence at all — the gate only fires for eta>0', () => {
    const search = baseSearch();
    const checkEvalEvidence = vi.fn(() => false);
    const governed = applyFusionGovernance(search, { checkEvalEvidence });
    expect(governed.eta).toBe(0);
    expect(checkEvalEvidence).not.toHaveBeenCalled();
  });

  it('the real (uninjected) evidence lookup also refuses eta>0 today (no evidence recorded yet)', () => {
    // No `checkEvalEvidence` override — exercises the real
    // src/eval/eval-evidence.ts lookup, whose table is empty for 'eta' as of
    // FEAT-428. If this ever flips to allow eta>0 without an explicit
    // recorded-evidence entry, that's a regression in the gate itself.
    const search = { ...baseSearch(), eta: 0.2 };
    const governed = applyFusionGovernance(search, { log: () => {} });
    expect(governed.eta).toBe(0);
  });

  it('loadConfig wires applyFusionGovernance in: an override setting eta>0 without evidence comes back 0', () => {
    const cfg = loadConfig({
      search: { ...defaultConfig().search, eta: 0.5 },
    } as any);
    expect(cfg.search.eta).toBe(0);
  });

  // issue #352B: theta (supersession/correction freshness bonus, the 8th
  // fusion component) is gated identically to eta — mirrors the eta block
  // above exactly.
  it('theta>0 with no recorded eval evidence is refused — forced back to 0 — and logs why', () => {
    const search = { ...baseSearch(), theta: 0.3 };
    const logs: string[] = [];
    const governed = applyFusionGovernance(search, {
      log: (m) => logs.push(m),
      checkEvalEvidence: () => false,
    });

    expect(governed.theta).toBe(0);
    expect(logs.some(m => m.includes('search.theta=0.3') && m.includes('eval'))).toBe(true);
  });

  it('theta>0 WITH passing recorded eval evidence is allowed to activate', () => {
    const search = { ...baseSearch(), theta: 0.3 };
    const governed = applyFusionGovernance(search, { checkEvalEvidence: () => true });
    expect(governed.theta).toBe(0.3);
  });

  it('theta=0 (default) never consults eval evidence at all — the gate only fires for theta>0', () => {
    const search = baseSearch();
    const checkEvalEvidence = vi.fn(() => false);
    const governed = applyFusionGovernance(search, { checkEvalEvidence });
    expect(governed.theta).toBe(0);
    expect(checkEvalEvidence).not.toHaveBeenCalled();
  });

  it('the real (uninjected) evidence lookup also refuses theta>0 today (no evidence recorded yet)', () => {
    const search = { ...baseSearch(), theta: 0.2 };
    const governed = applyFusionGovernance(search, { log: () => {} });
    expect(governed.theta).toBe(0);
  });

  it('loadConfig wires applyFusionGovernance in: an override setting theta>0 without evidence comes back 0', () => {
    const cfg = loadConfig({
      search: { ...defaultConfig().search, theta: 0.5 },
    } as any);
    expect(cfg.search.theta).toBe(0);
  });

  it('loadConfig wires applyFusionGovernance in: an override with an over-ceiling weight comes back clamped', () => {
    const cfg = loadConfig({
      search: { ...defaultConfig().search, zeta: 3 },
    } as any);
    expect(cfg.search.zeta).toBe(cfg.search.governance.maxComponentWeight);
  });

  // issue #190 build-sequence phase 4 / AC-7: implicitPositive.enabled gated
  // the same way eta is — a config that turns it on without recorded
  // ADR-005 evidence is forced back to false, mirroring the eta tests above.
  describe('implicitPositive eval-evidence gate', () => {
    const searchWithImplicitEnabled = () => ({
      ...baseSearch(),
      usefulness: { implicitPositive: { ...baseSearch().usefulness.implicitPositive, enabled: true } },
    });

    it('enabled:true with no recorded eval evidence is refused — forced back to false — and logs why', () => {
      const search = searchWithImplicitEnabled();
      const logs: string[] = [];
      const governed = applyFusionGovernance(search, {
        log: (m) => logs.push(m),
        checkEvalEvidence: () => false,
      });

      expect(governed.usefulness.implicitPositive.enabled).toBe(false);
      expect(logs.some(m => m.includes('implicitPositive') && m.includes('eval'))).toBe(true);
    });

    it('enabled:true WITH passing recorded eval evidence is allowed to activate', () => {
      const search = searchWithImplicitEnabled();
      const governed = applyFusionGovernance(search, { checkEvalEvidence: () => true });
      expect(governed.usefulness.implicitPositive.enabled).toBe(true);
    });

    it('enabled:false (default) never consults eval evidence at all — the gate only fires when enabled', () => {
      const search = baseSearch();
      const checkEvalEvidence = vi.fn(() => false);
      const governed = applyFusionGovernance(search, { checkEvalEvidence });
      expect(governed.usefulness.implicitPositive.enabled).toBe(false);
      expect(checkEvalEvidence).not.toHaveBeenCalled();
    });

    it('the real (uninjected) evidence lookup also refuses enabled:true today (no evidence recorded yet)', () => {
      const search = searchWithImplicitEnabled();
      const governed = applyFusionGovernance(search, { log: () => {} });
      expect(governed.usefulness.implicitPositive.enabled).toBe(false);
    });

    it('loadConfig wires the gate in: an override setting enabled:true without evidence comes back false', () => {
      const cfg = loadConfig({
        search: {
          ...defaultConfig().search,
          usefulness: { implicitPositive: { ...defaultConfig().search.usefulness.implicitPositive, enabled: true } },
        },
      } as any);
      expect(cfg.search.usefulness.implicitPositive.enabled).toBe(false);
    });

    it('does not mutate the caller-supplied search.usefulness object (governed is a fresh copy)', () => {
      const search = searchWithImplicitEnabled();
      applyFusionGovernance(search, { checkEvalEvidence: () => false, log: () => {} });
      // The input object itself must be untouched — governed.usefulness is a
      // shallow-cloned sibling, not the same reference mutated in place.
      expect(search.usefulness.implicitPositive.enabled).toBe(true);
    });
  });
});

// FEAT-441 fix pass (2026-07-09 review MEDIUM): distill.durabilityGate is a
// closed 3-value enum but config.yaml has no schema — an invalid/typo value
// must fall back to the documented 'off' default with a WARN, not silently
// behave as 'lenient' (see gateDurability's mode fallthrough).
describe('applyDurabilityGateGovernance', () => {
  it('leaves each valid mode byte-identical (governance is a guard, not a behavior change)', () => {
    for (const mode of ['strict', 'lenient', 'off'] as const) {
      const distill = { durabilityGate: mode, chunkConcurrency: 2, extractProfile: 'engineering' as const, compaction: 'auto' as const, maxChunkChars: 3200 , extractionPasses: 1 as const };
      expect(applyDurabilityGateGovernance(distill)).toEqual(distill);
    }
  });

  it('falls back to off and logs why on an invalid/typo value', () => {
    const distill = { durabilityGate: 'strcit' as any, chunkConcurrency: 2, extractProfile: 'engineering' as const, compaction: 'auto' as const, maxChunkChars: 3200 , extractionPasses: 1 as const };
    const logs: string[] = [];
    const governed = applyDurabilityGateGovernance(distill, { log: (m) => logs.push(m) });

    expect(governed.durabilityGate).toBe('off');
    expect(logs.some(m => m.includes('durabilityGate') && m.includes('strcit'))).toBe(true);
  });

  it('loadConfig wires applyDurabilityGateGovernance in: an invalid override comes back "off"', () => {
    const cfg = loadConfig({ distill: { durabilityGate: 'bogus' as any } } as any);
    expect(cfg.distill.durabilityGate).toBe('off');
  });

  it('loadConfig leaves a valid distill.durabilityGate untouched', () => {
    const cfg = loadConfig({ distill: { durabilityGate: 'strict' } } as any);
    expect(cfg.distill.durabilityGate).toBe('strict');
  });
});

// P2.1 stabilization: consolidation.candidateSelection is a closed 2-value
// enum, same config.yaml-has-no-schema governance concern as
// durabilityGate/audio.mode — an invalid/typo value (or an out-of-range
// knnK/maxCandidatePairsPerRun) must fall back to its documented default
// with a WARN, never silently pass through.
// 2026-07-16 operator request: judge provider/model override — see
// Config['consolidation']['contradictionDetection'].provider's doc comment.
describe('applyContradictionDetectionGovernance — judge provider override', () => {
  const cdBase = { mode: 'enabled' as const, minSimilarity: 0.6, minConfidence: 0.7, maxPerRun: 200, maxWallClockMs: 300_000 };
  const consolidationOf = (cd: Record<string, unknown>) =>
    ({ ...defaultConfig().consolidation, contradictionDetection: cd }) as any;

  it('a valid provider override passes through untouched', () => {
    const input = consolidationOf({ ...cdBase, provider: 'ollama', model: 'qwen2.5:7b' });
    expect(applyContradictionDetectionGovernance(input, { log: () => {} })).toEqual(input);
  });

  it('unset provider/model stays unset (ride-extraction default)', () => {
    const input = consolidationOf({ ...cdBase });
    const out = applyContradictionDetectionGovernance(input, { log: () => {} });
    expect(out.contradictionDetection.provider).toBeUndefined();
    expect(out.contradictionDetection.model).toBeUndefined();
  });

  it('an invalid provider is DROPPED with a warning, never fatal — a typo must not reach buildLLMProvider\'s throwing Azure fall-through at boot', () => {
    const log = vi.fn();
    const input = consolidationOf({ ...cdBase, provider: 'olama', model: 'qwen2.5:7b' });
    const out = applyContradictionDetectionGovernance(input, { log });
    expect(out.contradictionDetection.provider).toBeUndefined();
    // model kept: harmless alone (judge rides extraction provider with the
    // overridden model name only if a later run re-adds a valid provider —
    // model without provider is still a meaningful half-override).
    expect(out.contradictionDetection.model).toBe('qwen2.5:7b');
    expect(out.contradictionDetection.mode).toBe('enabled');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('olama'));
  });
});

describe('applyCandidateSelectionGovernance', () => {
  const base = {
    autoAcceptThreshold: null,
    contradictionDetection: { mode: 'off' as const, minSimilarity: 0.6, minConfidence: 0.7, maxPerRun: 200, maxWallClockMs: 300_000 },
    candidateSelection: 'full' as const,
    knnK: 30,
    maxCandidatePairsPerRun: null,
  };

  it('leaves a valid config byte-identical (governance is a guard, not a behavior change)', () => {
    expect(applyCandidateSelectionGovernance(base)).toEqual(base);
    const knnCfg = { ...base, candidateSelection: 'knn' as const, knnK: 50, maxCandidatePairsPerRun: 1000 };
    expect(applyCandidateSelectionGovernance(knnCfg)).toEqual(knnCfg);
  });

  it("falls back to 'full' and logs why on an invalid/typo candidateSelection", () => {
    const cfg = { ...base, candidateSelection: 'k-nn' as any };
    const logs: string[] = [];
    const governed = applyCandidateSelectionGovernance(cfg, { log: (m) => logs.push(m) });

    expect(governed.candidateSelection).toBe('full');
    expect(logs.some(m => m.includes('candidateSelection') && m.includes('k-nn'))).toBe(true);
  });

  it('falls back to knnK=30 on a non-positive-integer knnK', () => {
    for (const bad of [0, -5, 2.5]) {
      const cfg = { ...base, knnK: bad };
      const logs: string[] = [];
      const governed = applyCandidateSelectionGovernance(cfg, { log: (m) => logs.push(m) });
      expect(governed.knnK).toBe(30);
      expect(logs.some(m => m.includes('knnK'))).toBe(true);
    }
  });

  it('falls back to maxCandidatePairsPerRun=null on a non-positive-integer value (null itself stays null)', () => {
    expect(applyCandidateSelectionGovernance(base).maxCandidatePairsPerRun).toBeNull();
    for (const bad of [0, -1, 2.5]) {
      const cfg = { ...base, maxCandidatePairsPerRun: bad };
      const logs: string[] = [];
      const governed = applyCandidateSelectionGovernance(cfg, { log: (m) => logs.push(m) });
      expect(governed.maxCandidatePairsPerRun).toBeNull();
      expect(logs.some(m => m.includes('maxCandidatePairsPerRun'))).toBe(true);
    }
  });

  it('loadConfig wires applyCandidateSelectionGovernance in: an invalid override comes back "full"', () => {
    const cfg = loadConfig({ consolidation: { candidateSelection: 'bogus' as any } } as any);
    expect(cfg.consolidation.candidateSelection).toBe('full');
  });

  it('loadConfig leaves a valid consolidation.candidateSelection untouched', () => {
    const cfg = loadConfig({ consolidation: { candidateSelection: 'knn', knnK: 40, maxCandidatePairsPerRun: 2000 } } as any);
    expect(cfg.consolidation.candidateSelection).toBe('knn');
    expect(cfg.consolidation.knnK).toBe(40);
    expect(cfg.consolidation.maxCandidatePairsPerRun).toBe(2000);
  });
});

// FEAT-489 Slice A / ADR-017: audio.mode is a closed 3-value enum, same
// config.yaml-has-no-schema governance concern as durabilityGate — an
// invalid/typo value must fall back to the documented, ADR-017-required
// 'off' default with a WARN, never silently pass through.
describe('applyAudioModeGovernance', () => {
  it('leaves each valid mode byte-identical (governance is a guard, not a behavior change)', () => {
    for (const mode of ['off', 'dry-run', 'enabled'] as const) {
      const audio = { mode };
      expect(applyAudioModeGovernance(audio)).toEqual(audio);
    }
  });

  it('falls back to off and logs why on an invalid/typo value', () => {
    const audio = { mode: 'on' as any };
    const logs: string[] = [];
    const governed = applyAudioModeGovernance(audio, { log: (m) => logs.push(m) });

    expect(governed.mode).toBe('off');
    expect(logs.some(m => m.includes('audio.mode') && m.includes('on'))).toBe(true);
  });

  it('loadConfig wires applyAudioModeGovernance in: an invalid override comes back "off"', () => {
    const cfg = loadConfig({ audio: { mode: 'bogus' as any } } as any);
    expect(cfg.audio.mode).toBe('off');
  });

  it('loadConfig leaves a valid audio.mode untouched', () => {
    const cfg = loadConfig({ audio: { mode: 'dry-run' } } as any);
    expect(cfg.audio.mode).toBe('dry-run');
  });

  it('defaultConfig ships audio.mode off', () => {
    expect(defaultConfig().audio.mode).toBe('off');
  });
});

// FEAT-479 (D3 §3.2) AC-2: distill.extractProfile is a closed 2-value enum,
// same config.yaml-has-no-schema governance concern applyDurabilityGateGovernance
// already covers for durabilityGate — a typo'd value must fall back to the
// documented 'engineering' default with a WARN, not reach runPipeline's
// precedence resolution as an unrecognized string.
describe('applyExtractProfileGovernance', () => {
  it('leaves each valid profile byte-identical (governance is a guard, not a behavior change)', () => {
    for (const profile of ['engineering', 'conversational'] as const) {
      const distill = { durabilityGate: 'off' as const, chunkConcurrency: 2, extractProfile: profile, compaction: 'auto' as const, maxChunkChars: 3200 , extractionPasses: 1 as const };
      expect(applyExtractProfileGovernance(distill)).toEqual(distill);
    }
  });

  it('falls back to engineering and logs why on an invalid/typo value', () => {
    const distill = { durabilityGate: 'off' as const, chunkConcurrency: 2, extractProfile: 'enginering' as any, compaction: 'auto' as const, maxChunkChars: 3200 , extractionPasses: 1 as const };
    const logs: string[] = [];
    const governed = applyExtractProfileGovernance(distill, { log: (m) => logs.push(m) });

    expect(governed.extractProfile).toBe('engineering');
    expect(logs.some(m => m.includes('extractProfile') && m.includes('enginering'))).toBe(true);
  });

  it('loadConfig wires applyExtractProfileGovernance in: an invalid override comes back "engineering"', () => {
    const cfg = loadConfig({ distill: { extractProfile: 'bogus' as any } } as any);
    expect(cfg.distill.extractProfile).toBe('engineering');
  });

  it('loadConfig leaves a valid distill.extractProfile untouched', () => {
    const cfg = loadConfig({ distill: { extractProfile: 'conversational' } } as any);
    expect(cfg.distill.extractProfile).toBe('conversational');
  });

  it('loadConfig composes both distill governance functions: an invalid durabilityGate does not clobber a valid extractProfile, and vice versa', () => {
    const cfg1 = loadConfig({ distill: { durabilityGate: 'bogus' as any, extractProfile: 'conversational' } } as any);
    expect(cfg1.distill.durabilityGate).toBe('off');
    expect(cfg1.distill.extractProfile).toBe('conversational');

    const cfg2 = loadConfig({ distill: { durabilityGate: 'strict', extractProfile: 'bogus' as any } } as any);
    expect(cfg2.distill.durabilityGate).toBe('strict');
    expect(cfg2.distill.extractProfile).toBe('engineering');
  });

  it('defaultConfig ships extractProfile: "engineering" (byte-identical pre-FEAT-479 default)', () => {
    expect(defaultConfig().distill.extractProfile).toBe('engineering');
  });
});
