/**
 * tests/cli/config-upgrade-model.test.ts
 *
 * Issue #279: `astramem-local config upgrade-model` is the GUIDED migration
 * companion to doctor's "Model fit canary" — detect a known-bad/unfitting
 * pinned Ollama model and print the exact recommended edit, but NEVER write
 * config.yaml without explicit `--yes` (the issue's own wording: "Do NOT
 * silently rewrite a user's config"). `planModelUpgrade` is the testable
 * core: pure, no process.exit, no filesystem I/O — exercised directly here,
 * same convention as tests/cli/reembed-dim.test.ts testing `runReembedDim`
 * rather than the full CLI wrapper.
 */
import { describe, it, expect } from 'vitest';
import { planModelUpgrade } from '../../src/cli/config.js';
import { RECOMMENDED_OLLAMA_MODEL } from '../../src/doctor/checks/model-fit.js';
import type { Config } from '../../src/config/config.js';

function llmConfig(compactionModel: string, extractionModel = compactionModel): Config['llm'] {
  return {
    compaction: { provider: 'ollama', model: compactionModel },
    extraction: { provider: 'ollama', model: extractionModel },
  };
}

describe('astramem-local config upgrade-model (issue #279)', () => {
  it('detects a qwen3:8b pin and offers qwen2.5:7b — a plan is pure data, never a write', async () => {
    const plan = await planModelUpgrade(llmConfig('qwen3:8b'), { ollamaBaseUrl: 'http://127.0.0.1:11434' });

    expect(plan.edits).toHaveLength(2); // compaction + extraction both pinned
    for (const edit of plan.edits) {
      expect(edit.from).toBe('qwen3:8b');
      expect(edit.to).toBe(RECOMMENDED_OLLAMA_MODEL);
      expect(edit.field).toContain('.model');
      expect(edit.reasons.join(' ')).toMatch(/known-bad/i);
    }
    const roles = plan.edits.map((e) => e.role).sort();
    expect(roles).toEqual(['compaction', 'extraction']);
  });

  it('detects a single unfit role (extraction only) — leaves the other alone', async () => {
    const plan = await planModelUpgrade(llmConfig(RECOMMENDED_OLLAMA_MODEL, 'qwen3:8b'));
    expect(plan.edits).toHaveLength(1);
    expect(plan.edits[0]!.role).toBe('extraction');
    expect(plan.edits[0]!.from).toBe('qwen3:8b');
  });

  it('returns an empty plan (nothing to change) when already on the recommended model', async () => {
    const plan = await planModelUpgrade(llmConfig(RECOMMENDED_OLLAMA_MODEL));
    expect(plan.edits).toEqual([]);
  });

  it('returns an empty plan for a non-ollama provider regardless of model name', async () => {
    const plan = await planModelUpgrade({
      compaction: { provider: 'codex-subscription', model: 'gpt-5.4-mini' },
      extraction: { provider: 'codex-subscription', model: 'gpt-5.4-mini' },
    });
    expect(plan.edits).toEqual([]);
  });

  it('planModelUpgrade never performs a config.yaml write itself — same detection findUnfitOllamaModels backs (single source of truth)', async () => {
    // No fs/writeConfig import in this test at all — planModelUpgrade's
    // signature returns a plan object; nothing here calls writeConfig.
    // This test documents the "detect-and-offer, no silent write" contract:
    // the CLI wrapper (configCommand) only ever calls writeConfig behind an
    // explicit --yes check, and the planning step above is decoupled from
    // that decision entirely.
    const plan = await planModelUpgrade(llmConfig('qwen3:8b'));
    expect(plan.edits.length).toBeGreaterThan(0);
    expect(Object.keys(plan)).toEqual(['edits']); // no side-effect fields, no handles, no fs state
  });
});
