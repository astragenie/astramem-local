// FEAT-454 — named retrieval presets: unit coverage for the routing/
// governance seam in src/search/presets.ts. End-to-end REST + MCP coverage
// (including the 400 cases and cross-surface parity) lives in
// tests/mcp/preset-parity.test.ts; the byte-identical default-ranking AC-1
// snapshot lives in tests/eval/retrieval-eval.test.ts (mirrors the AC-6
// zeta=0 pattern).

import { describe, it, expect } from 'vitest';
import { defaultConfig } from '../../src/config/config.js';
import {
  RETRIEVAL_PRESETS,
  resolvePresetWeights,
  validatePresetFilters,
  PresetValidationError,
} from '../../src/search/presets.js';

describe('RETRIEVAL_PRESETS', () => {
  it('is the documented five-value enum', () => {
    expect([...RETRIEVAL_PRESETS]).toEqual(['default', 'recent', 'exact', 'entity', 'temporal']);
  });
});

describe('resolvePresetWeights', () => {
  const base = defaultConfig().search;

  it('default returns the base weights unchanged (AC-1: byte-identical)', () => {
    expect(resolvePresetWeights('default', base)).toEqual(base);
  });

  it('entity and temporal do not alter weights — they route to filters only', () => {
    expect(resolvePresetWeights('entity', base)).toEqual(base);
    expect(resolvePresetWeights('temporal', base)).toEqual(base);
  });

  it('recent boosts delta (freshness) relative to the base, leaves other components alone', () => {
    const governed = resolvePresetWeights('recent', base);
    expect(governed.delta).toBeGreaterThan(base.delta);
    expect(governed.alpha).toBe(base.alpha);
    expect(governed.beta).toBe(base.beta);
    expect(governed.gamma).toBe(base.gamma);
  });

  it('exact boosts alpha (BM25) relative to the base, leaves other components alone', () => {
    const governed = resolvePresetWeights('exact', base);
    expect(governed.alpha).toBeGreaterThan(base.alpha);
    expect(governed.beta).toBe(base.beta);
    expect(governed.gamma).toBe(base.gamma);
    expect(governed.delta).toBe(base.delta);
  });

  it('AC-2: a scaled preset that would exceed the component ceiling is clamped, never left over-ceiling', () => {
    const lowCeiling = {
      ...base,
      alpha: 0.9,
      governance: { maxComponentWeight: 1.0 },
    };
    const governed = resolvePresetWeights('exact', lowCeiling);
    expect(governed.alpha).toBeLessThanOrEqual(1.0);
    expect(governed.alpha).toBe(1.0); // 0.9 * 2 = 1.8, clamped to the ceiling
  });

  it('AC-2: every preset is constructed through applyFusionGovernance — an eta configured without eval evidence stays forced to 0', () => {
    const withEta = { ...base, eta: 0.3 };
    for (const preset of RETRIEVAL_PRESETS) {
      expect(resolvePresetWeights(preset, withEta).eta).toBe(0);
    }
  });
});

describe('validatePresetFilters (AC-3)', () => {
  it('default/recent/exact never require a filter', () => {
    for (const preset of ['default', 'recent', 'exact'] as const) {
      expect(() => validatePresetFilters(preset, {})).not.toThrow();
    }
  });

  it('entity without filters.entity throws PresetValidationError', () => {
    expect(() => validatePresetFilters('entity', {})).toThrow(PresetValidationError);
  });

  it('entity with filters.entity supplied does not throw', () => {
    expect(() => validatePresetFilters('entity', { entity: 'postgres' })).not.toThrow();
  });

  it('temporal without filters.as_of throws PresetValidationError', () => {
    expect(() => validatePresetFilters('temporal', {})).toThrow(PresetValidationError);
  });

  it('temporal with filters.as_of supplied does not throw', () => {
    expect(() => validatePresetFilters('temporal', { as_of: 1_700_000_000_000 })).not.toThrow();
  });
});
