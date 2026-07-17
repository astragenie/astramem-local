/**
 * ollama-orphans.ts — unattended doctor canary for issue #399.
 *
 * When Ollama is force-killed (crash, OOM-kill, a stray `taskkill`), its
 * `llama-server` child process SURVIVES and keeps its GPU allocation — the
 * same failure mode `src/doctor/gpu-checks.ts`'s "Orphaned llama-server
 * processes" check already detects (FEAT-485, 2026-07-13: six accumulated
 * orphans leaked ~6.8 GB of an 8 GB card). That check is rich (VRAM
 * quantification via nvidia-smi, plus a lower-confidence Ollama /api/ps
 * cross-check) but is wired ONLY into the manual `astramem-local doctor` CLI
 * command (`src/cli/doctor.ts`'s `getGpuChecks()` call) — never into the
 * unattended periodic schedule (`src/doctor/schedule.ts` only ever calls
 * `checks/index.ts`'s `getChecks()`, which `getGpuChecks()` is not part of).
 * That gap is exactly why a live incident (pid 31436, dead parent 6384,
 * holding ~2 GB VRAM) went undetected for hours on 2026-07-16 — nobody
 * happened to run `doctor` by hand while it was happening. Another instance
 * of this repo's dominant failure mode: built, wired [to the CLI], never
 * invoked [unattended].
 *
 * This check is the lightweight, periodic-schedule sibling: the SAME
 * highest-confidence signal (a `llama-server` process whose parent PID is
 * not a live Ollama process), reusing the same proven cross-platform process
 * enumeration (`listProcesses`, `../probes/gpu-vram-probe.js`) rather than
 * duplicating it, but with no VRAM lookup and no Ollama `/api/ps` network
 * call — so it can be registered unconditionally into `checks/index.ts`'s
 * `coreChecks()` without a new opts seam (mirrors
 * `task-repetition-dormancy.ts`'s pattern of an injectable function
 * parameter with a real default, not a `DoctorCheckOpts` field). The richer
 * CLI-only check in gpu-checks.ts stays exactly as-is — this does not
 * replace it, it fills the "nobody's watching overnight" gap.
 *
 * Tier: `'full'`, not `'cheap'`. Process enumeration on win32 is a real
 * PowerShell child-process spawn (`Get-CimInstance Win32_Process`) —
 * measured at ~800ms for a lightly loaded box, and gpu-vram-probe.ts's own
 * doc comment cites up to 5.8-6.1s cold-start on a loaded one. That is the
 * exact cost class `task-repetition-dormancy.ts`'s header already measured
 * as unsafe on the 15-minute frequent-tier schedule ("process spawn overhead
 * is not free the way the tier's other members are") — this check follows
 * that established precedent rather than the "cheap" classification a naive
 * read of `spool-quarantine.ts`'s shape might suggest, to avoid repeating
 * the #226 cost-tier-misclassification incident. `getChecks()` (no tier
 * filter) still runs this on the manual CLI doctor run AND on
 * `schedule.ts`'s existing >=24h `runFullDoctorChecks` piggyback tick — the
 * actual fix for "nobody ran doctor overnight," without inventing a new
 * timer (see schedule.ts's module doc comment on why a new interval is
 * avoided).
 *
 * Diagnostic only — no kill path, ever. See gpu-checks.ts's module doc
 * comment for why: this whole failure class exists BECAUSE of a
 * process-kill accident (CLAUDE.md's image-name-kill hard rule), and an
 * auto-kill "fix" here would repeat exactly that mistake.
 */
import { platform } from 'node:os';
import type { Check, CheckResult } from '../types.js';
import { listProcesses as defaultListProcesses, type ProcessInfo } from '../probes/gpu-vram-probe.js';

const LLAMA_SERVER_RE = /^llama-server(\.exe)?$/i;
const OLLAMA_RE = /^ollama(\.exe)?$/i;

/** Advisory-only text: the exact command an operator could run to terminate
 *  the given PIDs. Never executed by this code — see module doc comment. */
function killHint(pids: number[]): string {
  if (platform() === 'win32') {
    return pids.map((pid) => `taskkill /PID ${pid} /F`).join('  ');
  }
  return pids.map((pid) => `kill ${pid}`).join('  ');
}

export function checkOllamaOrphans(
  /** Injectable process lister — tests substitute a stub instead of
   *  depending on real OS process state. Defaults to the real cross-platform
   *  implementation (gpu-vram-probe.ts's listProcesses, already covering
   *  win32 via Get-CimInstance and POSIX via `ps -eo pid,ppid,comm`).
   *  `null` (as opposed to a thrown error) is that implementation's own
   *  failure signal for "enumeration ran but produced nothing usable" —
   *  MUST be treated as inconclusive, never as "zero processes". */
  listProcessesImpl: () => Promise<ProcessInfo[] | null> = defaultListProcesses,
): Check {
  return {
    name: 'Orphaned llama-server processes (unattended canary)',
    tier: 'full',
    async run(): Promise<CheckResult> {
      let procs: ProcessInfo[] | null;
      try {
        procs = await listProcessesImpl();
      } catch (err) {
        // Enumeration itself failed — this did NOT verify there are no
        // orphaned llama-server processes, so it must not render/count as
        // if it had confirmed a clean state (ADR-015).
        const msg = err instanceof Error ? err.message : String(err);
        return {
          ok: true,
          inconclusive: true,
          message: `ollama orphaned llama-server: process enumeration unavailable (non-fatal): ${msg}`,
        };
      }

      if (procs === null) {
        return {
          ok: true,
          inconclusive: true,
          message:
            'ollama orphaned llama-server: process enumeration unavailable (non-fatal) — timeout, missing ' +
            'binary, or unparsable output',
        };
      }

      const llamaServers = procs.filter((p) => LLAMA_SERVER_RE.test(p.name));
      if (llamaServers.length === 0) {
        return { ok: true, message: 'ollama orphaned llama-server: no llama-server processes running' };
      }

      const ollamaPids = new Set(procs.filter((p) => OLLAMA_RE.test(p.name)).map((p) => p.pid));
      const orphans = llamaServers.filter((p) => p.ppid === null || !ollamaPids.has(p.ppid));

      if (orphans.length === 0) {
        return {
          ok: true,
          message: `ollama orphaned llama-server: ${llamaServers.length} running, all parented to a live Ollama process`,
        };
      }

      const pidList = orphans.map((p) => p.pid).join(', ');
      return {
        ok: false,
        message:
          `ollama orphaned llama-server: ${orphans.length} of ${llamaServers.length} llama-server process(es) ` +
          `have no live Ollama parent — PID ${pidList} — holding VRAM indefinitely`,
        fix:
          'Diagnostic only — verify before acting (cross-check with the richer "Orphaned llama-server processes" ' +
          'row from `astramem-local doctor`, which quantifies reclaimable VRAM). If confirmed orphaned, the ' +
          'operator can terminate by PID (never by image name — other processes may share it): ' +
          killHint(orphans.map((p) => p.pid)),
      };
    },
  };
}
