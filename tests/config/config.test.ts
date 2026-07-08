import { describe, it, expect, vi } from 'vitest';
import { loadConfig, defaultConfig, applyFusionGovernance } from '../../src/config/config.js';

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
