/**
 * tests/doctor/model-fit-check.test.ts
 *
 * Issue #279: doctor's "Model fit canary" — WARNs when a config-pinned
 * Ollama LLM model (compaction/extraction) is either on a known-bad list
 * (qwen3:8b — does not fit an 8 GB VRAM card) or is measured (via Ollama's
 * `/api/ps`, reusing the existing GPU/VRAM probe infra) as currently
 * spilling to CPU. Never fires for codex-subscription/azure-openai/
 * openai-compatible — no local VRAM constraint applies. Reuses
 * `fetchOllamaPs`'s injectable seam (same pattern as
 * tests/doctor/gpu-checks.test.ts) so no test ever touches a real Ollama
 * instance.
 */
import { describe, it, expect } from 'vitest';
import {
  checkModelFitCanary,
  findUnfitOllamaModels,
  KNOWN_BAD_OLLAMA_MODELS,
  RECOMMENDED_OLLAMA_MODEL,
  type ModelFitLlmSettings,
} from '../../src/doctor/checks/model-fit.js';
import { getChecks } from '../../src/doctor/checks.js';
import { DEFAULT_OLLAMA_LLM_MODEL } from '../../src/cli/init.js';

function ollamaSettings(compactionModel: string, extractionModel = compactionModel): ModelFitLlmSettings {
  return {
    compaction: { provider: 'ollama', model: compactionModel },
    extraction: { provider: 'ollama', model: extractionModel },
  };
}

describe('doctor "Model fit canary" check (issue #279)', () => {
  it('RECOMMENDED_OLLAMA_MODEL matches src/cli/init.ts\'s DEFAULT_OLLAMA_LLM_MODEL (single source of truth, regression guard)', () => {
    expect(RECOMMENDED_OLLAMA_MODEL).toBe(DEFAULT_OLLAMA_LLM_MODEL);
  });

  it('RECOMMENDED_OLLAMA_MODEL is never itself on the known-bad list', () => {
    expect(KNOWN_BAD_OLLAMA_MODELS.has(RECOMMENDED_OLLAMA_MODEL)).toBe(false);
  });

  it('WARNs when compaction is pinned to qwen3:8b (known-bad, Ollama unreachable)', async () => {
    const check = checkModelFitCanary(ollamaSettings('qwen3:8b', RECOMMENDED_OLLAMA_MODEL), {
      fetchOllamaPs: async () => null,
    });
    const result = await check.run();
    expect(result.ok).toBe(false);
    expect(result.message).toContain('qwen3:8b');
    expect(result.message).toContain('compaction');
    expect(result.message).not.toContain('extraction=');
    expect(result.fix).toContain('config upgrade-model');
  });

  it('WARNs for both roles when both compaction and extraction are pinned to qwen3:8b', async () => {
    const check = checkModelFitCanary(ollamaSettings('qwen3:8b'), { fetchOllamaPs: async () => null });
    const result = await check.run();
    expect(result.ok).toBe(false);
    expect(result.message).toContain('compaction=qwen3:8b');
    expect(result.message).toContain('extraction=qwen3:8b');
  });

  it('PASSes when both roles are pinned to qwen2.5:7b (known-good, Ollama unreachable)', async () => {
    const check = checkModelFitCanary(ollamaSettings('qwen2.5:7b'), { fetchOllamaPs: async () => null });
    const result = await check.run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('qwen2.5:7b');
  });

  it('PASSes cleanly (no local VRAM constraint) when both roles use codex-subscription', async () => {
    const check = checkModelFitCanary(
      {
        compaction: { provider: 'codex-subscription', model: 'gpt-5.4-mini' },
        extraction: { provider: 'codex-subscription', model: 'gpt-5.4-mini' },
      },
      { fetchOllamaPs: async () => { throw new Error('must not be called — no ollama in use'); } },
    );
    const result = await check.run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('no local VRAM constraint');
  });

  it('WARNs on a live measured CPU-offload signal even for a model NOT on the known-bad list', async () => {
    const check = checkModelFitCanary(ollamaSettings('some-other-model:7b'), {
      fetchOllamaPs: async () => [{ name: 'some-other-model:7b', size: 5_000_000_000, size_vram: 500_000_000 }],
    });
    const result = await check.run();
    expect(result.ok).toBe(false);
    expect(result.message).toContain('some-other-model:7b');
    expect(result.message.toLowerCase()).toContain('spilling to cpu');
  });

  it('PASSes when the live model is fully resident in VRAM', async () => {
    const check = checkModelFitCanary(ollamaSettings('qwen2.5:7b'), {
      fetchOllamaPs: async () => [{ name: 'qwen2.5:7b', size: 5_000_000_000, size_vram: 5_000_000_000 }],
    });
    const result = await check.run();
    expect(result.ok).toBe(true);
  });

  it('model name matching is case-insensitive', async () => {
    const check = checkModelFitCanary(ollamaSettings('QWEN3:8B', RECOMMENDED_OLLAMA_MODEL), {
      fetchOllamaPs: async () => null,
    });
    const result = await check.run();
    expect(result.ok).toBe(false);
  });

  it('findUnfitOllamaModels returns [] when neither role uses ollama', async () => {
    const findings = await findUnfitOllamaModels(
      {
        compaction: { provider: 'azure-openai', model: 'gpt-4o' },
        extraction: { provider: 'azure-openai', model: 'gpt-4o' },
      },
      { fetchOllamaPs: async () => { throw new Error('must not be called'); } },
    );
    expect(findings).toEqual([]);
  });

  it('is registered in the core doctor check registry as "Model fit canary"', async () => {
    // Both roles non-ollama so no network fetch ever fires — this only
    // proves the check is wired into coreChecks()/getChecks(), not the
    // detection logic itself (covered directly above).
    const checks = getChecks({
      llmConfig: {
        compaction: { provider: 'codex-subscription', model: 'gpt-5.4-mini' },
        extraction: { provider: 'codex-subscription', model: 'gpt-5.4-mini' },
      },
    });
    const check = checks.find((c) => c.name === 'Model fit canary');
    expect(check).toBeDefined();
    const result = await check!.run();
    expect(result.ok).toBe(true);
  });

  it('getChecks() defaults llmConfig to defaultConfig().llm when omitted (codex-subscription default — no local VRAM constraint)', async () => {
    const checks = getChecks({});
    const check = checks.find((c) => c.name === 'Model fit canary');
    expect(check).toBeDefined();
    const result = await check!.run();
    expect(result.ok).toBe(true);
  });
});
