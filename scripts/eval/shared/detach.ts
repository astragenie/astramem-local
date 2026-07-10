/**
 * `--detach` execution mode (FEAT-462 slice B, AC-2). Survives the invoking
 * terminal/session ending — one of three recorded eval-death causes
 * (CLAUDE.md Do-NOT section, this FEAT's own body). Mechanism: a plain
 * `child_process.spawn(..., { detached: true }).unref()` re-invocation of
 * the SAME script with the SAME args, stdio redirected to files in the run
 * dir, rather than the `AstraMemoryD` schtasks-keepalive pattern the FEAT
 * body cites as a reference point.
 *
 * Chose plain detached spawn over schtasks deliberately: schtasks is a
 * Windows-only registration mechanism (this repo's daemon uses it because
 * the daemon is a long-lived OS service that must survive REBOOTS, not just
 * a terminal closing — see CLAUDE.md's "Service / upgrade" section); an eval
 * harness run only needs to survive the launching terminal/session dying,
 * which `detached: true` + `unref()` already provides on both Windows (new
 * process group, no console) and POSIX (new session) with zero OS-specific
 * registration, no admin/non-elevated concerns, and no leftover scheduled
 * task to clean up after the run finishes. If a future need arises for
 * surviving a full reboot, that would be a genuinely different requirement
 * warranting schtasks — not needed for "don't die when the terminal closes".
 *
 * `evaluateDetachDecision` is the single decision point (same pattern as
 * ../shared/run-params.ts's `evaluateResumeGuard`, DEC-012 precedent) both
 * harnesses call — pure, unit-testable without ever spawning a process.
 */
import { spawn } from 'node:child_process';
import { openSync, closeSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/** Set by the parent on the child's env so the child's own re-evaluation of
 *  `--detach` on startup resolves to 'run-inline' instead of forking again. */
export const DETACHED_CHILD_ENV_VAR = 'ASTRAMEM_EVAL_DETACHED_CHILD';

export function isDetachedChild(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[DETACHED_CHILD_ENV_VAR] === '1';
}

export type DetachDecision =
  | { action: 'run-inline' }
  | { action: 'spawn-detached' };

/**
 * `detachRequested` = `--detach` was passed on argv. `alreadyDetached` =
 * this process IS the detached child (env marker set). A detached child
 * that still has `--detach` in its argv (harmless — buildDetachedChildArgs
 * doesn't need to strip it, the env marker alone decides) must run inline,
 * not fork again.
 */
export function evaluateDetachDecision(opts: { detachRequested: boolean; alreadyDetached: boolean }): DetachDecision {
  if (!opts.detachRequested || opts.alreadyDetached) return { action: 'run-inline' };
  return { action: 'spawn-detached' };
}

/**
 * Rewrites the parent's original argv for the detached child: strips
 * `--detach` (the child must not re-detach) and forces `--run-dir <runDir>`
 * (replacing any existing occurrence) so the child lands on the EXACT same
 * run dir the parent already committed to and printed to the operator —
 * `--run-dir`'s own default is a `new Date().toISOString()` timestamp
 * computed at call time, which would silently diverge on a second
 * invocation if not pinned explicitly.
 */
export function buildDetachedChildArgs(originalArgs: string[], runDir: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < originalArgs.length; i++) {
    const arg = originalArgs[i]!;
    if (arg === '--detach') continue;
    if (arg === '--run-dir') { i++; continue; } // drop it and its value; re-added below
    out.push(arg);
  }
  out.push('--run-dir', runDir);
  return out;
}

export interface SpawnDetachedOpts {
  /** Absolute path to the .mts entry script (e.g. run-smoke.mts) — the same
   *  file currently executing, re-invoked as a child. */
  scriptPath: string;
  args: string[];
  cwd: string;
  runDir: string;
  /** Defaults to process.execPath, i.e. whatever runtime is running the
   *  parent (bun or node) -- same runtime for the child. */
  execPath?: string;
  env?: Record<string, string>;
}

export interface DetachedChild {
  pid: number | undefined;
  stdoutPath: string;
  stderrPath: string;
}

/** Spawns the detached child and returns immediately — does not wait for
 *  the child to do anything. Caller (the harness's own --detach branch) is
 *  responsible for writing the initial run-status.json and exiting. */
export function spawnDetached(opts: SpawnDetachedOpts): DetachedChild {
  mkdirSync(opts.runDir, { recursive: true });
  const stdoutPath = join(opts.runDir, 'detached-stdout.log');
  const stderrPath = join(opts.runDir, 'detached-stderr.log');
  const outFd = openSync(stdoutPath, 'a');
  const errFd = openSync(stderrPath, 'a');
  try {
    const child = spawn(
      opts.execPath ?? process.execPath,
      [opts.scriptPath, ...opts.args],
      {
        cwd: opts.cwd,
        detached: true,
        stdio: ['ignore', outFd, errFd],
        env: { ...(process.env as Record<string, string>), ...opts.env, [DETACHED_CHILD_ENV_VAR]: '1' },
      },
    );
    child.unref();
    return { pid: child.pid, stdoutPath, stderrPath };
  } finally {
    // The child has its own dup'd copies of these fds via stdio; safe to
    // close our handles once spawn() has returned.
    closeSync(outFd);
    closeSync(errFd);
  }
}
