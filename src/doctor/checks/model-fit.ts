/**
 * model-fit.ts — issue #279: doctor canary for a config-pinned Ollama LLM
 * model that does not fit local VRAM.
 *
 * `reinstall` only repoints the release pointer — it NEVER calls
 * `writeConfig`, so an existing operator's `config.llm.{compaction,
 * extraction}.model` survives every upgrade untouched. `qwen3:8b` (5.76 GB
 * resident) does not fit an 8 GB VRAM card; Ollama silently spills the rest
 * to CPU, distill calls that normally take well under a second instead take
 * 9-35s, and long-running distill jobs POISON on timeout — while `doctor`
 * stayed green throughout (see CLAUDE.md's "Ollama 8GB VRAM ceiling" and
 * "qwen3:8b breaks distill extract" learnings). Success (a green doctor)
 * and silent failure (a poisoned distill pipeline) look identical — exactly
 * the class ADR-015 exists to kill.
 *
 * REUSES the existing GPU/VRAM probe infra (`gpu-vram-probe.ts`'s
 * `fetchOllamaPs`, already powering `gpu-checks.ts`'s "Silent CPU offload"
 * check, and that same check's `CPU_OFFLOAD_RATIO_FLOOR`) instead of adding
 * a new VRAM probe. Two independent signals feed one WARN:
 *
 *  1. STATIC — the configured model is on `KNOWN_BAD_OLLAMA_MODELS` (a
 *     named, extensible constant; a documented incompatibility, not a live
 *     measurement). Fires even when Ollama isn't running right now — the
 *     whole point is to catch a stale pin BEFORE the next distill job runs
 *     into it, not only after it has already spilled to CPU.
 *  2. LIVE — Ollama's `/api/ps` (`fetchOllamaPs`) reports the configured
 *     model currently loaded with `size_vram/size` below
 *     `CPU_OFFLOAD_RATIO_FLOOR` — an actual measurement, not an inference.
 *
 * Only relevant when the compaction/extraction provider is `'ollama'` — no
 * local VRAM constraint applies to `codex-subscription`/`azure-openai`/
 * `openai-compatible`, so this check PASSes cleanly (unconditionally — the
 * row is always present, this is just its content) for those.
 */
import type { Check, CheckResult } from '../types.js';
import { fetchOllamaPs as defaultFetchOllamaPs, type OllamaPsModel } from '../probes/gpu-vram-probe.js';
import { CPU_OFFLOAD_RATIO_FLOOR } from '../gpu-checks.js';

export interface ModelFitLlmConfig {
  provider: string;
  model: string;
}

export interface ModelFitLlmSettings {
  compaction: ModelFitLlmConfig;
  extraction: ModelFitLlmConfig;
}

export interface ModelFitFinding {
  role: 'compaction' | 'extraction';
  model: string;
  reasons: string[];
}

export interface ModelFitOpts {
  ollamaBaseUrl?: string;
  /** Injectable Ollama /api/ps fetch — tests substitute a stub; mirrors
   *  gpu-checks.ts's GpuCheckOpts seam. Defaults to the real fetch. */
  fetchOllamaPs?: (baseUrl: string) => Promise<OllamaPsModel[] | null>;
}

/**
 * Known Ollama models that do not fit an 8 GB VRAM card at their default
 * quantization — a small, extensible, named list (not an inline literal),
 * per issue #279. Seed: `qwen3:8b` (5.76 GB resident — see CLAUDE.md's
 * "Ollama 8GB VRAM ceiling" / "qwen3:8b breaks distill extract" learnings).
 * `qwen2.5:7b` (~4.7 GB, see `RECOMMENDED_OLLAMA_MODEL` below) is the known-
 * GOOD replacement and must never be added here.
 */
export const KNOWN_BAD_OLLAMA_MODELS: ReadonlySet<string> = new Set(['qwen3:8b']);

/**
 * The model `astramem-local config upgrade-model` (src/cli/config.ts)
 * recommends in place of a known-bad/unfitting pin. Mirrors
 * `src/cli/init.ts`'s `DEFAULT_OLLAMA_LLM_MODEL` (the wizard's own
 * recommended default) — kept as a separate constant rather than an import
 * to avoid a doctor/-layer -> cli/-layer dependency (no other file under
 * `src/doctor/` imports from `src/cli/`); a value drift between the two is
 * covered by tests/cli/config-upgrade-model.test.ts, which imports both and
 * asserts equality.
 */
export const RECOMMENDED_OLLAMA_MODEL = 'qwen2.5:7b';

function normalizeModel(model: string): string {
  return model.trim().toLowerCase();
}

/**
 * Pure detection core, shared by the doctor check below AND
 * `astramem-local config upgrade-model` (src/cli/config.ts) — one place
 * decides "is this model unfit", so the CLI's recommendation can never
 * drift from what doctor actually WARNs about. No side effects: never
 * touches config.yaml, only reads live Ollama state via the injectable
 * `fetchOllamaPs`.
 */
export async function findUnfitOllamaModels(
  llm: ModelFitLlmSettings,
  opts: ModelFitOpts = {},
): Promise<ModelFitFinding[]> {
  const ollamaBaseUrl = opts.ollamaBaseUrl ?? 'http://127.0.0.1:11434';
  const fetchOllamaPs = opts.fetchOllamaPs ?? defaultFetchOllamaPs;

  const roles: Array<{ role: 'compaction' | 'extraction'; cfg: ModelFitLlmConfig }> = [
    { role: 'compaction', cfg: llm.compaction },
    { role: 'extraction', cfg: llm.extraction },
  ];
  const ollamaRoles = roles.filter((r) => r.cfg.provider === 'ollama');
  if (ollamaRoles.length === 0) return [];

  // Single /api/ps fetch, reused across both roles — `null` (unreachable
  // Ollama) is a valid, non-fatal outcome: the LIVE signal is simply
  // unavailable, the STATIC known-bad-list signal still applies.
  let liveModels: OllamaPsModel[] | null = null;
  try {
    liveModels = await fetchOllamaPs(ollamaBaseUrl);
  } catch {
    liveModels = null;
  }

  const findings: ModelFitFinding[] = [];
  for (const { role, cfg } of ollamaRoles) {
    const model = normalizeModel(cfg.model);
    const knownBad = KNOWN_BAD_OLLAMA_MODELS.has(model);

    const loaded = liveModels?.find((m) => normalizeModel(m.name) === model);
    const liveRatio = loaded && loaded.size > 0 ? loaded.size_vram / loaded.size : undefined;
    const offloading = liveRatio !== undefined && liveRatio < CPU_OFFLOAD_RATIO_FLOOR;

    if (!knownBad && !offloading) continue;

    const reasons: string[] = [];
    if (knownBad) {
      reasons.push('on known-bad list (does not fit an 8 GB VRAM card at default quantization)');
    }
    if (offloading) {
      reasons.push(
        `measured ${(liveRatio! * 100).toFixed(1)}% resident in VRAM ` +
        `(below the ${(CPU_OFFLOAD_RATIO_FLOOR * 100).toFixed(0)}% floor) — spilling to CPU right now`,
      );
    }
    findings.push({ role, model: cfg.model, reasons });
  }
  return findings;
}

// ─── Check: Model fit canary ───────────────────────────────────────────────

export function checkModelFitCanary(llm: ModelFitLlmSettings, opts: ModelFitOpts = {}): Check {
  return {
    name: 'Model fit canary',
    tier: 'full', // network call to Ollama's /api/ps — mirrors checkSilentCpuOffload's tier in gpu-checks.ts
    async run(): Promise<CheckResult> {
      const ollamaInUse = llm.compaction.provider === 'ollama' || llm.extraction.provider === 'ollama';
      if (!ollamaInUse) {
        return {
          ok: true,
          message: `no local VRAM constraint (compaction: ${llm.compaction.provider}, extraction: ${llm.extraction.provider})`,
        };
      }

      const findings = await findUnfitOllamaModels(llm, opts);
      if (findings.length === 0) {
        return {
          ok: true,
          message:
            `configured Ollama model(s) fit local VRAM: ` +
            [llm.compaction, llm.extraction]
              .filter((c) => c.provider === 'ollama')
              .map((c) => c.model)
              .join(', '),
        };
      }

      return {
        ok: false,
        message:
          `${findings.length} configured Ollama model(s) unfit for local VRAM: ` +
          findings.map((f) => `${f.role}=${f.model} (${f.reasons.join('; ')})`).join('; '),
        fix:
          `Run \`astramem-local config upgrade-model\` to see the exact recommended edit ` +
          `(add --yes to apply) — switches to ${RECOMMENDED_OLLAMA_MODEL} (~4.7 GB, fits an 8 GB ` +
          `card). Or edit config.yaml's llm.compaction/extraction.model by hand and restart the daemon.`,
      };
    },
  };
}
