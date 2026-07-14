/**
 * gpu-checks.ts — FEAT-485: doctor checks for the two silent GPU/VRAM
 * failure modes that cost an entire debugging night on 2026-07-13.
 *
 * FAILURE MODE 1 — orphaned llama-server processes. When Ollama is
 * force-killed, its `llama-server` child process SURVIVES and keeps its GPU
 * allocation. Six accumulated on the operator's box, leaking ~6.8 GB of an
 * 8 GB card. Ollama then loaded qwen2.5:7b with only 0.59 GB of 4.99 GB
 * actually on the GPU — silently running the rest on CPU. Everything got
 * ~4x slower and presented as "this model is slow", sending the operator on
 * a multi-hour wild goose chase into model selection. Nothing said a word.
 *
 * FAILURE MODE 2 — silent CPU offload. Ollama's GET /api/ps returns loaded
 * models with both `size` and `size_vram`. When `size_vram` << `size`, part
 * of the model is on CPU. This is THE tell, and it is invisible from
 * latency alone.
 *
 * DIAGNOSTIC ONLY. Neither this module nor src/doctor/probes/gpu-vram-
 * probe.ts contains a kill path — no `process.kill`, no `taskkill`, no
 * `pkill`, nothing that terminates a process. This whole feature exists
 * BECAUSE of a process-kill accident; auto-killing a `llama-server` that
 * Ollama legitimately owns would nuke a running model mid-inference. Checks
 * below only ever report PIDs and print the command the OPERATOR can choose
 * to run themselves.
 */
import { platform } from 'node:os';
import type { Check, CheckResult } from './types.js';
import {
  listProcesses as defaultListProcesses,
  queryNvidiaSmiUsedMemory,
  fetchOllamaPs as defaultFetchOllamaPs,
  readPersistedEnvVars as defaultReadPersistedEnvVars,
  type ProcessInfo,
  type OllamaPsModel,
  type PersistedEnvValue,
} from './probes/gpu-vram-probe.js';

export interface GpuCheckOpts {
  /** Base URL of the Ollama API. Default http://127.0.0.1:11434. */
  ollamaBaseUrl?: string;
  /** Injectable process lister — tests substitute a stub instead of a real
   *  OS enumeration. Defaults to the real cross-platform implementation.
   *  `null` means enumeration failed (timeout, missing binary, unparsable
   *  output) — MUST be treated as inconclusive, never as "zero processes". */
  listProcesses?: () => Promise<ProcessInfo[] | null>;
  /** Injectable nvidia-smi VRAM-by-PID lookup — tests substitute a stub;
   *  `null` means "unavailable" (no NVIDIA GPU / nvidia-smi not on PATH). */
  queryGpuMemory?: (pids: number[]) => Promise<Map<number, number> | null>;
  /** Injectable Ollama /api/ps fetch — tests substitute a stub; `null`
   *  means Ollama is unreachable. */
  fetchOllamaPs?: (baseUrl: string) => Promise<OllamaPsModel[] | null>;
  /** Injectable environment map for the tuning-vars row's "doctor process
   *  couldn't determine the real value" fallback text. Defaults to
   *  `process.env`. Never used as the primary source of truth — see
   *  `readPersistedEnvVars`. */
  env?: NodeJS.ProcessEnv;
  /** Injectable persisted-env reader for the tuning-vars row — this is the
   *  actual source of truth, not `env`/`process.env` (which is only the
   *  doctor process's own inherited environment, not Ollama's). Tests
   *  substitute a stub; `null` means "cannot determine" (non-Windows, or the
   *  lookup failed) and must be reported honestly, never as "(unset)".
   *  Defaults to the real Windows registry-backed implementation. */
  readPersistedEnvVars?: (names: readonly string[]) => Promise<Map<string, PersistedEnvValue> | null>;
}

const LLAMA_SERVER_RE = /^llama-server(\.exe)?$/i;
const OLLAMA_RE = /^ollama(\.exe)?$/i;

/** Below this fraction of a loaded model's bytes resident in VRAM, doctor
 *  WARNs — this is the exact 2026-07-13 signature (0.59/4.99 ≈ 0.12).
 *  Exported so `src/doctor/checks/model-fit.ts` (issue #279) can apply the
 *  SAME live-offload floor to a specific config-pinned model instead of
 *  duplicating the constant. */
export const CPU_OFFLOAD_RATIO_FLOOR = 0.9;

const TUNING_VARS = [
  'OLLAMA_NUM_PARALLEL',
  'OLLAMA_MAX_LOADED_MODELS',
  'OLLAMA_FLASH_ATTENTION',
  'OLLAMA_KV_CACHE_TYPE',
  'OLLAMA_KEEP_ALIVE',
] as const;

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function bytesToGb(bytes: number): string {
  return (bytes / 1024 ** 3).toFixed(2);
}

function mibToGb(mib: number): string {
  return (mib / 1024).toFixed(2);
}

/** Advisory-only text: the exact command an operator could run to terminate
 *  the given PIDs. Never executed by this code — see module doc comment. */
function killHint(pids: number[]): string {
  if (platform() === 'win32') {
    return pids.map((pid) => `taskkill /PID ${pid} /F`).join('  ');
  }
  return pids.map((pid) => `kill ${pid}`).join('  ');
}

async function reportOrphans(
  orphans: ProcessInfo[],
  queryGpuMemory: (pids: number[]) => Promise<Map<number, number> | null>,
): Promise<CheckResult> {
  const pidList = orphans.map((p) => p.pid).join(', ');

  let vramMap: Map<number, number> | null;
  try {
    vramMap = await queryGpuMemory(orphans.map((p) => p.pid));
  } catch {
    vramMap = null;
  }

  const vramMsg = vramMap
    ? ` — approx ${mibToGb(orphans.reduce((sum, p) => sum + (vramMap!.get(p.pid) ?? 0), 0))} GB of VRAM reclaimable`
    : ' — VRAM usage unavailable (nvidia-smi not found, no NVIDIA GPU, or unreadable)';

  return {
    ok: false,
    message: `${orphans.length} orphaned llama-server process(es) with no live Ollama parent: PID ${pidList}${vramMsg}`,
    fix:
      'These PIDs appear orphaned (their parent Ollama process is gone). Diagnostic only — verify before ' +
      'acting; astramem doctor never kills anything itself. If confirmed orphaned, the operator can run: ' +
      killHint(orphans.map((p) => p.pid)),
  };
}

// ─── Check: Orphaned llama-server processes ──────────────────────────────

function checkOrphanedLlamaServer(opts: {
  ollamaBaseUrl: string;
  listProcesses: () => Promise<ProcessInfo[] | null>;
  queryGpuMemory: (pids: number[]) => Promise<Map<number, number> | null>;
  fetchOllamaPs: (baseUrl: string) => Promise<OllamaPsModel[] | null>;
}): Check {
  return {
    name: 'Orphaned llama-server processes',
    // Not wired into getChecks()/coreChecks() — cli/doctor.ts combines this
    // registry separately, outside schedule.ts's frequent/full split, so
    // this tier value is currently inert for the 15-minute loop. Classified
    // 'full' on its own merits regardless (network call to Ollama's
    // /api/ps + an nvidia-smi subprocess spawn + OS process enumeration) so
    // it can't silently start riding the frequent tier if this registry is
    // ever folded into getChecks() later.
    tier: 'full',
    async run(): Promise<CheckResult> {
      let procs: ProcessInfo[] | null;
      try {
        procs = await opts.listProcesses();
      } catch (err) {
        // Enumeration itself failed — this did NOT verify there are no
        // orphaned llama-server processes, so it must not render/count as
        // if it had confirmed a clean state.
        return { ok: true, inconclusive: true, message: `process enumeration unavailable (non-fatal): ${errMsg(err)}` };
      }

      // `null` (as opposed to a thrown error) is the REAL implementation's
      // failure signal (see gpu-vram-probe.ts's listProcesses) — a
      // PowerShell timeout, missing binary, or unparsable CIM output.
      // Treating it as an empty array here was the actual bug: an empty
      // llamaServers filter and a genuinely clean box produced the
      // identical "no llama-server processes running" green result
      // (ADR-015 — success and silent failure were the same observable
      // state). This must stay inconclusive, not green.
      if (procs === null) {
        return { ok: true, inconclusive: true, message: 'process enumeration unavailable (non-fatal): listProcesses returned null (timeout, missing binary, or unparsable output)' };
      }

      const llamaServers = procs.filter((p) => LLAMA_SERVER_RE.test(p.name));
      if (llamaServers.length === 0) {
        return { ok: true, message: 'no llama-server processes running' };
      }

      const ollamaPids = new Set(procs.filter((p) => OLLAMA_RE.test(p.name)).map((p) => p.pid));
      const noParentOrphans = llamaServers.filter((p) => p.ppid === null || !ollamaPids.has(p.ppid));

      let models: OllamaPsModel[] | null;
      try {
        models = await opts.fetchOllamaPs(opts.ollamaBaseUrl);
      } catch {
        models = null;
      }

      // Highest-confidence signal: no live Ollama parent at all.
      if (noParentOrphans.length > 0) {
        return reportOrphans(noParentOrphans, opts.queryGpuMemory);
      }

      // Lower-confidence signal: every llama-server resolves to a live
      // Ollama parent, but there are more llama-server processes than
      // Ollama reports as currently loaded — some are very likely stale
      // grandchildren of an earlier force-killed daemon (parent PID reuse
      // can hide the orphan from the ppid check above).
      if (models !== null && llamaServers.length > models.length) {
        const pidList = llamaServers.map((p) => p.pid).join(', ');
        return {
          ok: false,
          message:
            `${llamaServers.length} llama-server process(es) running [PID ${pidList}] but Ollama reports only ` +
            `${models.length} model(s) currently loaded — likely stale/orphaned process(es) among them even ` +
            `though all currently resolve to a live Ollama parent (parent PID reuse can produce this).`,
          fix:
            'Cross-check these PIDs against `ollama ps` output, then terminate manually if confirmed orphaned — ' +
            'this check will never do it for you: ' + killHint(llamaServers.map((p) => p.pid)),
        };
      }

      return {
        ok: true,
        message:
          `${llamaServers.length} llama-server process(es), all owned by a live Ollama parent` +
          (models !== null ? ` (matches ${models.length} loaded model(s))` : ''),
      };
    },
  };
}

// ─── Check: Silent CPU offload ────────────────────────────────────────────

function checkSilentCpuOffload(opts: {
  ollamaBaseUrl: string;
  fetchOllamaPs: (baseUrl: string) => Promise<OllamaPsModel[] | null>;
}): Check {
  return {
    name: 'Silent CPU offload',
    tier: 'full', // network call to Ollama's /api/ps — see checkOrphanedLlamaServer's tier comment above
    async run(): Promise<CheckResult> {
      let models: OllamaPsModel[] | null;
      try {
        models = await opts.fetchOllamaPs(opts.ollamaBaseUrl);
      } catch {
        models = null;
      }

      if (models === null) {
        // The fetch either threw or the probe's own null-sentinel fired —
        // both mean this check never actually observed Ollama's loaded
        // models, so it must not render as a confirmed "nothing offloaded"
        // (same ambiguity checkOrphanedLlamaServer's listProcesses===null
        // branch documents above: a probe failure and a genuinely absent
        // Ollama are indistinguishable from here).
        return {
          ok: true,
          inconclusive: true,
          message: 'Ollama /api/ps unreachable — CPU offload check did not run (is Ollama running?)',
        };
      }
      if (models.length === 0) {
        return { ok: true, message: 'no models currently loaded in Ollama' };
      }

      const rows = models.map((m) => ({
        ...m,
        ratio: m.size > 0 ? m.size_vram / m.size : 1,
      }));
      const fmt = (r: (typeof rows)[number]) =>
        `${r.name}: ${(r.ratio * 100).toFixed(1)}% on GPU (ratio ${r.ratio.toFixed(2)}, ${bytesToGb(r.size_vram)}/${bytesToGb(r.size)} GB)`;

      const offloaded = rows.filter((r) => r.ratio < CPU_OFFLOAD_RATIO_FLOOR);
      if (offloaded.length > 0) {
        return {
          ok: false,
          message: `${offloaded.length} model(s) partially offloaded to CPU: ${offloaded.map(fmt).join('; ')}`,
          fix:
            'Free VRAM (see "Orphaned llama-server processes" above), lower OLLAMA_MAX_LOADED_MODELS, or use a ' +
            'smaller/quantized model so the whole thing fits in VRAM — otherwise inference silently runs ~4x ' +
            'slower with no error, ever, telling you why.',
        };
      }

      return { ok: true, message: `all loaded model(s) fully on GPU: ${rows.map(fmt).join('; ')}` };
    },
  };
}

// ─── Check: Ollama tuning env vars (informational) ───────────────────────

const TUNING_VARS_CONTEXT =
  'these materially affect Ollama throughput/VRAM fit (flash-attn + q8 KV cache dropped qwen3:8b from 6.2 to ' +
  '5.76 GB on the operator\'s box, the difference between fitting and not fitting on 8 GB).';

function checkOllamaTuningEnvVars(opts: {
  env: NodeJS.ProcessEnv;
  readPersistedEnvVars: (names: readonly string[]) => Promise<Map<string, PersistedEnvValue> | null>;
}): Check {
  return {
    name: 'Ollama tuning env vars',
    tier: 'cheap', // local registry/env read only, no network — see checkOrphanedLlamaServer's tier comment above
    async run(): Promise<CheckResult> {
      let persisted: Map<string, PersistedEnvValue> | null;
      try {
        persisted = await opts.readPersistedEnvVars(TUNING_VARS);
      } catch {
        persisted = null;
      }

      // Cannot determine Ollama's real environment from here (non-Windows,
      // or the registry lookup failed) — report that honestly. Do NOT fall
      // back to `process.env`/`opts.env` as if it were the answer: that is
      // the doctor process's OWN environment, which is exactly what caused
      // this check to falsely report five active vars as "(unset)" on
      // 2026-07-13. It's shown below only as a clearly-labeled, separate
      // hint, never as the claimed value.
      if (persisted === null) {
        const doctorEnvHint = TUNING_VARS.map((v) => `${v}=${opts.env[v] ?? '(unset in doctor process)'}`).join(', ');
        return {
          ok: true,
          inconclusive: true,
          message:
            `cannot determine Ollama's actual tuning env vars from here — persisted-environment lookup is ` +
            `unavailable on this platform (or failed), and this doctor process's own environment is NOT ` +
            `necessarily what the running Ollama service sees. For reference only, the doctor process itself ` +
            `sees: ${doctorEnvHint}. ${TUNING_VARS_CONTEXT} Verify with \`ollama ps\` / observed VRAM instead of ` +
            `trusting this row.`,
        };
      }

      const parts = TUNING_VARS.map((v) => {
        const p = persisted!.get(v);
        return p ? `${v}=${p.value} [persisted:${p.scope}]` : `${v}=(not set at User/Machine scope)`;
      });
      return {
        ok: true,
        message:
          `${parts.join(', ')} — read from the Windows persisted User/Machine environment (registry), not this ` +
          `doctor process's own environment. ${TUNING_VARS_CONTEXT} May still not exactly match a running Ollama ` +
          `service launched from a different account or with an explicit environment override.`,
      };
    },
  };
}

// ─── Registry entry point ─────────────────────────────────────────────────

export function getGpuChecks(rawOpts: GpuCheckOpts = {}): Check[] {
  const ollamaBaseUrl = rawOpts.ollamaBaseUrl ?? 'http://127.0.0.1:11434';
  const listProcesses = rawOpts.listProcesses ?? defaultListProcesses;
  const queryGpuMemory = rawOpts.queryGpuMemory ?? (() => queryNvidiaSmiUsedMemory());
  const fetchOllamaPs = rawOpts.fetchOllamaPs ?? defaultFetchOllamaPs;
  const env = rawOpts.env ?? process.env;
  const readPersistedEnvVars = rawOpts.readPersistedEnvVars ?? defaultReadPersistedEnvVars;

  return [
    checkOrphanedLlamaServer({ ollamaBaseUrl, listProcesses, queryGpuMemory, fetchOllamaPs }),
    checkSilentCpuOffload({ ollamaBaseUrl, fetchOllamaPs }),
    checkOllamaTuningEnvVars({ env, readPersistedEnvVars }),
  ];
}
