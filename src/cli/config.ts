/**
 * `astramem-local config upgrade-model [--yes] [--json]`
 *
 * Issue #279: `reinstall` only repoints the release pointer — it never
 * calls `writeConfig`, so an existing operator's pinned
 * `config.llm.{compaction,extraction}.model` (e.g. `qwen3:8b`, which does
 * not fit an 8 GB VRAM card and silently spills to CPU — see doctor's
 * "Model fit canary", src/doctor/checks/model-fit.ts) survives every
 * upgrade untouched.
 *
 * This is the GUIDED migration the issue explicitly asks for: detect the
 * bad pin, print the EXACT recommended edit, and only ever write
 * config.yaml on explicit `--yes`. Preview is the default — a bare
 * invocation (or any invocation without `--yes`) must never silently
 * rewrite a user's config, per the issue's own wording. Same
 * preview-by-default shape as `entity-purge-junk` (src/cli/entity-purge.ts).
 */
import { join } from 'node:path';
import { resolveRuntimeConfig } from '../config/resolve-runtime.js';
import { defaultConfigDir } from '../config/datadir.js';
import { writeConfig } from '../config/writer.js';
import { findUnfitOllamaModels, RECOMMENDED_OLLAMA_MODEL } from '../doctor/checks/model-fit.js';
import type { Config } from '../config/config.js';

export interface ModelUpgradeEdit {
  role: 'compaction' | 'extraction';
  field: string;
  from: string;
  to: string;
  reasons: string[];
}

export interface ModelUpgradePlan {
  edits: ModelUpgradeEdit[];
}

/**
 * Testable core: pure planning, no process.exit, no config.yaml I/O. Reuses
 * `findUnfitOllamaModels` (the exact same detection doctor's "Model fit
 * canary" check runs) so the CLI's recommendation can never drift from what
 * doctor WARNs about.
 */
export async function planModelUpgrade(
  llm: Config['llm'],
  opts: { ollamaBaseUrl?: string } = {},
): Promise<ModelUpgradePlan> {
  const findings = await findUnfitOllamaModels(llm, opts);
  const edits: ModelUpgradeEdit[] = findings.map((f) => ({
    role: f.role,
    field: `llm.${f.role}.model`,
    from: llm[f.role].model,
    to: RECOMMENDED_OLLAMA_MODEL,
    reasons: f.reasons,
  }));
  return { edits };
}

export async function configCommand(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  if (sub === 'upgrade-model') {
    await configUpgradeModelCommand(rest);
    return;
  }
  console.error(`config: unknown subcommand "${sub ?? ''}" (expected: upgrade-model)`);
  process.exit(1);
}

async function configUpgradeModelCommand(args: string[]): Promise<void> {
  const jsonMode = args.includes('--json');
  const apply = args.includes('--yes');

  const { cfg } = resolveRuntimeConfig();
  const plan = await planModelUpgrade(cfg.llm, { ollamaBaseUrl: cfg.ollama.baseUrl });

  if (plan.edits.length === 0) {
    if (jsonMode) {
      console.log(JSON.stringify({ changed: false, edits: [] }, null, 2));
    } else {
      console.log('config upgrade-model: llm.compaction/extraction models look fine — nothing to change.');
    }
    return;
  }

  if (jsonMode) {
    console.log(JSON.stringify({ changed: apply, edits: plan.edits }, null, 2));
  } else {
    console.log('');
    console.log('  AstraMemory Config — upgrade-model');
    console.log('  ──────────────────────────────');
    for (const e of plan.edits) {
      console.log(`  ${e.field}: ${e.from} -> ${e.to}`);
      console.log(`      reason: ${e.reasons.join('; ')}`);
    }
    console.log('');
  }

  if (!apply) {
    if (!jsonMode) {
      console.log('  Nothing was changed. Re-run with --yes to apply this edit to config.yaml.');
      console.log('');
    }
    return;
  }

  let newLlm = cfg.llm;
  for (const e of plan.edits) {
    newLlm = { ...newLlm, [e.role]: { ...newLlm[e.role], model: e.to } };
  }
  const newCfg: Config = { ...cfg, llm: newLlm };
  const configPath = join(defaultConfigDir(), 'config.yaml');
  writeConfig(newCfg, configPath);

  if (!jsonMode) {
    console.log(`  config.yaml updated at ${configPath}`);
    console.log('  Restart the daemon (`astramem-local reinstall` or `service restart`) to pick this up.');
    console.log('');
  }
}
