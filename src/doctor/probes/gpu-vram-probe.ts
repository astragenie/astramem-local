/**
 * gpu-vram-probe.ts — real (non-test) implementations for the FEAT-485 GPU
 * checks: OS process enumeration, nvidia-smi VRAM lookup, and Ollama's
 * /api/ps. Every function here is READ-ONLY and DIAGNOSTIC ONLY — none of
 * them, and nothing in src/doctor/gpu-checks.ts that consumes them, ever
 * signals, kills, or otherwise touches a process. That constraint exists
 * because this feature exists BECAUSE of a process-kill accident (see
 * gpu-checks.ts's module doc comment) — do not add one here.
 *
 * Every function degrades gracefully: no NVIDIA GPU, no `nvidia-smi` on
 * PATH, an unsupported platform, or a permissions error all resolve to
 * `null` (or `[]` for the process list), never a thrown error. Callers
 * (gpu-checks.ts) treat `null`/failure as "unavailable" and report an
 * informational, non-failing row rather than propagating the error.
 */
import { exec } from 'node:child_process';
import { platform } from 'node:os';

export interface ProcessInfo {
  pid: number;
  /** Parent PID, or null when it could not be determined (e.g. a POSIX `ps`
   *  line with ppid 0, or a parse failure for that one row). */
  ppid: number | null;
  name: string;
}

export interface OllamaPsModel {
  name: string;
  /** Total model size in bytes, as reported by Ollama's /api/ps. */
  size: number;
  /** Bytes of `size` actually resident on GPU VRAM. size_vram < size means
   *  part of the model is running on CPU. */
  size_vram: number;
}

/**
 * Cold `powershell.exe` process startup (CLR + assembly resolution, not the
 * cmdlet itself) was measured at ~5.8-6.1s on a loaded dev box (see
 * instance-lock.ts's `getProcessStartTime`, the reference implementation for
 * this exact bug class — PR #224). ANY invocation of `powershell.exe`, CIM
 * or not, pays this cost. A timeout below this doesn't make the check
 * faster, it makes it fail closed on every real invocation while every
 * mocked test stays green (ADR-015). Match instance-lock.ts's bound.
 */
const POWERSHELL_TIMEOUT_MS = 15_000;
/** Native, fast binaries (`ps`, `nvidia-smi`) — no CLR/profile cold-start
 *  cost, so the default stays tight. */
const NATIVE_CMD_TIMEOUT_MS = 5_000;

function runCmd(cmd: string, timeoutMs = NATIVE_CMD_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout);
    });
  });
}

/**
 * Enumerate live OS processes with pid/ppid/name. Cross-platform:
 *  - Windows: PowerShell `Get-CimInstance Win32_Process` (tasklist has no
 *    parent-PID column at all, which is exactly the field this feature
 *    needs to tell an orphan from a legitimate child).
 *  - POSIX (Linux/macOS): `ps -eo pid,ppid,comm`.
 *
 * Returns `null` on any failure (command missing, non-zero exit, unparsable
 * output, timeout) — NEVER `[]` for a failure. `[]` is reserved for a
 * genuine "the command ran and there are zero rows" result. Conflating the
 * two is the exact ADR-015 bug this function used to have: the caller
 * (`checkOrphanedLlamaServer` in doctor/gpu-checks.ts) filters an empty
 * process list down to zero "llama-server" matches and reports a green "no
 * llama-server processes running" — a broken enumeration and a clean box
 * were the same observable state. Mirrors `readPersistedEnvVars` below,
 * which already got this distinction right.
 */
export async function listProcesses(): Promise<ProcessInfo[] | null> {
  try {
    if (platform() === 'win32') {
      const out = await runCmd(
        'powershell -NoProfile -NonInteractive -Command ' +
        '"Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress"',
        POWERSHELL_TIMEOUT_MS,
      );
      const trimmed = out.trim();
      if (!trimmed) return []; // command ran, genuinely zero rows (impossible in practice, but a real success).
      const parsed = JSON.parse(trimmed) as unknown;
      const rows = Array.isArray(parsed) ? parsed : [parsed];
      return rows
        .map((r) => {
          const row = r as { ProcessId?: number; ParentProcessId?: number; Name?: string };
          if (typeof row.ProcessId !== 'number' || typeof row.Name !== 'string') return null;
          return {
            pid: row.ProcessId,
            ppid: typeof row.ParentProcessId === 'number' ? row.ParentProcessId : null,
            name: row.Name,
          };
        })
        .filter((p): p is ProcessInfo => p !== null);
    }

    // POSIX: `ps -eo pid,ppid,comm` — fixed-width columns, comm may be
    // truncated but that's fine, we only substring-match on it.
    const out = await runCmd('ps -eo pid,ppid,comm');
    const lines = out.split('\n').slice(1).map((l) => l.trim()).filter(Boolean);
    const procs: ProcessInfo[] = [];
    for (const line of lines) {
      const m = line.match(/^(\d+)\s+(\d+)\s+(.+)$/);
      if (!m) continue;
      const [, pidStr, ppidStr, name] = m;
      const pid = Number(pidStr);
      const ppidNum = Number(ppidStr);
      if (Number.isNaN(pid)) continue;
      procs.push({ pid, ppid: ppidNum === 0 || Number.isNaN(ppidNum) ? null : ppidNum, name: name! });
    }
    return procs;
  } catch {
    return null; // could not enumerate — the caller must not treat this as "zero processes".
  }
}

/**
 * Query `nvidia-smi` for per-process VRAM usage (MiB), keyed by PID.
 * Returns `null` when `nvidia-smi` is not on PATH, exits non-zero, or
 * produces unparsable output (no NVIDIA GPU, driver not installed, or a
 * non-NVIDIA box entirely) — never throws.
 */
export async function queryNvidiaSmiUsedMemory(): Promise<Map<number, number> | null> {
  try {
    const out = await runCmd('nvidia-smi --query-compute-apps=pid,used_memory --format=csv,noheader,nounits');
    const trimmed = out.trim();
    const map = new Map<number, number>();
    if (!trimmed) return map; // nvidia-smi present, GPU idle — legitimately empty.
    for (const line of trimmed.split('\n')) {
      const [pidStr, memStr] = line.split(',').map((s) => s.trim());
      const pid = Number(pidStr);
      const mib = Number(memStr);
      if (!Number.isNaN(pid) && !Number.isNaN(mib)) map.set(pid, mib);
    }
    return map;
  } catch {
    return null;
  }
}

export interface PersistedEnvValue {
  value: string;
  scope: 'user' | 'machine';
}

/**
 * Read named env vars from Windows' PERSISTED User/Machine environment
 * (`[Environment]::GetEnvironmentVariables`, which reads the same
 * `HKCU:\Environment` / `HKLM:\...\Session Manager\Environment` registry
 * keys that `setx` and the System Properties dialog write to) — NOT from
 * `process.env` of the calling (doctor) process.
 *
 * This distinction is the whole point: `process.env` only reflects whatever
 * environment the doctor process happened to inherit from the shell that
 * launched it, which can differ from what a long-running Ollama service
 * actually has (different shell, different service account, set after
 * Ollama started, etc). A 2026-07-13 incident on a real box had all five
 * `OLLAMA_*` tuning vars persisted at User scope and demonstrably active in
 * Ollama (confirmed via `size_vram` on a loaded model), while the doctor
 * process's `process.env` had none of them — the original check read
 * `process.env` and confidently reported all five as "(unset)", which was
 * false and pointed debugging in the wrong direction.
 *
 * Returns `null` on non-Windows platforms (there is no equivalent concept of
 * a single persisted user environment on POSIX — env vars there are typically
 * sourced from shell rc files, systemd unit files, launchd plists, etc., with
 * no one canonical read path) or when the PowerShell query itself fails
 * (permissions, PowerShell unavailable, unparsable output). Callers must
 * treat `null` as "cannot determine" and say so honestly — never fall back
 * to silently asserting "(unset)".
 *
 * Even a non-null result is a best-effort proxy, not a guarantee: it reflects
 * what a NEW process would inherit right now, which may still differ from
 * what an already-running Ollama process has if it was launched before the
 * value was set, from a different account, or with an explicit override.
 */
export async function readPersistedEnvVars(
  names: readonly string[],
): Promise<Map<string, PersistedEnvValue> | null> {
  if (platform() !== 'win32') return null;
  try {
    const out = await runCmd(
      'powershell -NoProfile -NonInteractive -Command ' +
      '"$u = [Environment]::GetEnvironmentVariables(\'User\'); ' +
      '$m = [Environment]::GetEnvironmentVariables(\'Machine\'); ' +
      '[PSCustomObject]@{User=$u; Machine=$m} | ConvertTo-Json -Compress -Depth 4"',
      POWERSHELL_TIMEOUT_MS,
    );
    const trimmed = out.trim();
    if (!trimmed) return null;
    const parsed: unknown = JSON.parse(trimmed);

    // VALIDATE the shape — do not cast and hope.
    //
    // This check exists because its absence was a milder recurrence of the exact
    // bug this whole function was written to fix. `doctor` used to read the wrong
    // process's environment and print "(unset)" for settings that were demonstrably
    // ON — a confident false claim. The fix reads the persisted registry env instead.
    //
    // But a bare `as { User?: ...; Machine?: ... }` cast asserts a shape the compiler
    // cannot check. A payload that is syntactically valid JSON yet has NEITHER key —
    // an array, a scalar, a PowerShell error object, a shape change in a future
    // Windows/PS version — would make every lookup return undefined and hand back an
    // EMPTY (non-null) Map. The caller then renders that as a confident
    // "(not set at User/Machine scope)": the same confident false claim, through a
    // narrower door.
    //
    // An empty Map means "I looked and they are genuinely absent."
    // `null` means "I could not look." Those must never be confused. If the payload
    // carries neither scope object, we could not look — return null and let the
    // caller say "cannot determine" honestly.
    const asObj = (v: unknown): Record<string, unknown> | undefined =>
      v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

    const root = asObj(parsed);
    if (!root) return null;
    const userScope = asObj(root.User);
    const machineScope = asObj(root.Machine);
    if (!userScope && !machineScope) return null;

    const findCaseInsensitive = (obj: Record<string, unknown> | undefined, name: string): string | undefined => {
      if (!obj) return undefined;
      const key = Object.keys(obj).find((k) => k.toUpperCase() === name.toUpperCase());
      return key !== undefined ? String(obj[key]) : undefined;
    };

    const map = new Map<string, PersistedEnvValue>();
    for (const name of names) {
      const userVal = findCaseInsensitive(userScope, name);
      if (userVal !== undefined) {
        map.set(name, { value: userVal, scope: 'user' });
        continue;
      }
      const machineVal = findCaseInsensitive(machineScope, name);
      if (machineVal !== undefined) {
        map.set(name, { value: machineVal, scope: 'machine' });
      }
    }
    return map;
  } catch {
    return null;
  }
}

/**
 * Fetch Ollama's `GET /api/ps` (currently-loaded models, with `size` and
 * `size_vram` per model — THE tell for silent CPU offload, invisible from
 * latency alone). Returns `null` when Ollama is unreachable (not running,
 * wrong port, network error) — that is not a doctor failure, just "nothing
 * to check right now".
 */
export async function fetchOllamaPs(baseUrl: string): Promise<OllamaPsModel[] | null> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/ps`, {
      signal: AbortSignal.timeout(3_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { models?: OllamaPsModel[] };
    return data.models ?? [];
  } catch {
    return null;
  }
}
