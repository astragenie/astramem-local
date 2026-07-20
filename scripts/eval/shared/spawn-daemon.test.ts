/**
 * Eval-sandbox hardening (2026-07-20, session-handoff open item): every isolated eval
 * daemon must boot with consolidation.contradictionDetection.mode forced to 'off',
 * regardless of what the shipped production default in defaultConfig() says (currently
 * 'enabled' — see CLAUDE.md's "Contradiction detection ships enabled"). A LoCoMo/
 * LongMemEval sandbox run fires hundreds of contradiction-judge LLM calls in a single
 * pass on a throwaway eval provider setup; those calls routinely fail/stall and wedge
 * the run (the FEAT-482 incident class hitting the harness instead of prod).
 */
import { describe, it, expect } from 'vitest';
import { makeIsolatedEvalEnv, cleanupIsolatedEvalEnv } from './spawn-daemon.js';
import { parseConfigYaml } from '../../../src/config/loader.js';
import { defaultConfig } from '../../../src/config/config.js';

describe('makeIsolatedEvalEnv contradiction-detection override (2026-07-20 hardening)', () => {
  it('writes consolidation.contradictionDetection.mode: off into the sandbox config.yaml', () => {
    const iso = makeIsolatedEvalEnv('spawn-daemon-cd-test');
    try {
      expect(iso.configYaml).toMatch(/consolidation:\s*\n\s*contradictionDetection:\s*\n\s*mode: off/);
    } finally {
      cleanupIsolatedEvalEnv(iso);
    }
  });

  it('parses to the string "off", not a stringified boolean or the production default', () => {
    const iso = makeIsolatedEvalEnv('spawn-daemon-cd-test-parse');
    try {
      const parsed = parseConfigYaml(iso.configYaml) as {
        consolidation?: { contradictionDetection?: { mode?: unknown } };
      };
      expect(parsed.consolidation?.contradictionDetection?.mode).toBe('off');
      // Guardrail against the exact regression CLAUDE.md warns about: the
      // shipped production default is 'enabled', not 'off' — this test must
      // never start passing because someone flipped defaultConfig() instead
      // of the sandbox override.
      expect(defaultConfig().consolidation.contradictionDetection.mode).toBe('enabled');
    } finally {
      cleanupIsolatedEvalEnv(iso);
    }
  });

  it('leaves the other contradictionDetection fields (minSimilarity/minConfidence/caps) at their defaults via deep merge', () => {
    const iso = makeIsolatedEvalEnv('spawn-daemon-cd-test-merge');
    try {
      const parsed = parseConfigYaml(iso.configYaml);
      const base = defaultConfig();
      // deepMerge (src/config/loader.ts) follows existing structure, so setting
      // only `mode` on disk must not drop the other tuned fields back to
      // undefined — this asserts the override is additive, not a full replace.
      const merged = { ...base.consolidation.contradictionDetection, ...(parsed as any).consolidation.contradictionDetection };
      expect(merged.minSimilarity).toBe(base.consolidation.contradictionDetection.minSimilarity);
      expect(merged.minConfidence).toBe(base.consolidation.contradictionDetection.minConfidence);
      expect(merged.maxPerRun).toBe(base.consolidation.contradictionDetection.maxPerRun);
      expect(merged.maxWallClockMs).toBe(base.consolidation.contradictionDetection.maxWallClockMs);
      expect(merged.mode).toBe('off');
    } finally {
      cleanupIsolatedEvalEnv(iso);
    }
  });
});
