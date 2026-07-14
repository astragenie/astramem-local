import { describe, it, expect, vi } from 'vitest';
import {
  loadConfig,
  defaultConfig,
  applyFusionGovernance,
  applyDurabilityGateGovernance,
  applyExtractProfileGovernance,
} from '../../src/config/config.js';

describe('loadConfig', () => {
  it('returns defaults when no file present', () => {
    const cfg = loadConfig(undefined);
    expect(cfg.port).toBe(7777);
    expect(cfg.embedding.provider).toBe('ollama');
    expect(cfg.budget.daily_usd).toBe(10);
  });

  it('overrides defaults from passed object', () => {
    const cfg = loadConfig({ port: 8888 } as any);
    expect(cfg.port).toBe(8888);
    expect(cfg.embedding.provider).toBe('ollama');
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
  // Embedding is unaffected — stays on ollama/mxbai-embed-large.
  it('llm.compaction/extraction default to codex-subscription/gpt-5.4-mini', () => {
    const cfg = defaultConfig();
    expect(cfg.llm.compaction.provider).toBe('codex-subscription');
    expect(cfg.llm.compaction.model).toBe('gpt-5.4-mini');
    expect(cfg.llm.extraction.provider).toBe('codex-subscription');
    expect(cfg.llm.extraction.model).toBe('gpt-5.4-mini');
    expect(cfg.embedding.provider).toBe('ollama');
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

  it('loadConfig wires applyFusionGovernance in: an override with an over-ceiling weight comes back clamped', () => {
    const cfg = loadConfig({
      search: { ...defaultConfig().search, zeta: 3 },
    } as any);
    expect(cfg.search.zeta).toBe(cfg.search.governance.maxComponentWeight);
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
