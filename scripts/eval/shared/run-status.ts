/**
 * Pollable run-status file (FEAT-462 slice B, AC-2). `run-smoke.mts` and
 * `run.mts` both write `run-status.json` into the run dir at phase
 * transitions and periodically during ingest, so a later session (or the
 * same session after `--detach` has moved the real work into a detached
 * child) can check on a run without needing the original process's stdout
 * — the exact gap AC-2 exists to close ("the invoking terminal or session
 * ends" and the operator has nothing left to poll).
 *
 * Written unconditionally on every invocation, detached or not (same
 * AC-7-safe precedent as ../shared/resume-ledger.ts and run-params.json —
 * additive files, never gate existing output). `--detach` only changes who
 * is doing the writing (a detached child instead of the invoking process),
 * never whether the file exists.
 *
 * Atomic tmp+rename writes (same technique as src/config/writer.ts's
 * `writeConfig`, FEAT-433) so a poller reading run-status.json mid-write —
 * this file IS being read live, unlike config.yaml which src/config/loader.ts
 * only reads once at boot — never observes a torn/partial JSON file.
 */
import { writeFileSync, readFileSync, mkdirSync, renameSync, unlinkSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * `distill_wait` and `answering` were missing, and they are the two phases that
 * TAKE THE TIME. A run could only ever report itself as 'ingesting' or
 * 'completed' — so for the entire multi-hour middle of a run, the status file
 * named a phase the run had already left.
 *
 * 2026-07-14: a full-suite LoCoMo run reported `{phase: "ingesting",
 * sessions_done: 1}` for 90 minutes. Ingest had in fact finished — 272/272
 * transcripts, 2521 atoms on disk — and the run was wedged in the distill wait.
 * Every field in that status line was wrong, and it was wrong in the reassuring
 * direction: it looked like early, healthy progress.
 *
 * A status file that can only describe the phases you don't need to watch is
 * worse than none: it is trusted, and it lies.
 */
export type RunPhase =
  | 'starting'
  | 'sampling'
  | 'ingesting'
  | 'distill_wait'
  | 'answering'
  | 'completed'
  | 'failed';

export interface RunStatus {
  status: 'running' | 'completed' | 'failed';
  phase: RunPhase;
  /** PID of the orchestrator process — the detached child when `detached`
   *  is true, otherwise the invoking process itself. */
  orchestrator_pid: number;
  detached: boolean;
  started_at: string;
  updated_at: string;
  sessions_done: number;
  sessions_total: number;
  /** Distill-wait progress. Absent before that phase begins. */
  conversations_ready?: number;
  conversations_total?: number;
  conversations_timed_out?: number;
  exit_code?: number;
  error?: string;
}

export function runStatusPath(runDir: string): string {
  return join(runDir, 'run-status.json');
}

/** Same tmp-file + rename technique as src/config/writer.ts's writeConfig —
 *  see that file's header comment for why truncate-in-place is unsafe for a
 *  file that's read while it may still be being written. */
export function writeRunStatus(runDir: string, status: RunStatus): void {
  mkdirSync(runDir, { recursive: true });
  const path = runStatusPath(runDir);
  const tmpPath = join(runDir, `.run-status.json.${process.pid}.${Date.now()}.tmp`);
  try {
    writeFileSync(tmpPath, JSON.stringify(status, null, 2), 'utf8');
    renameSync(tmpPath, path);
  } catch (err) {
    try { unlinkSync(tmpPath); } catch { /* best-effort cleanup */ }
    throw err;
  }
}

export function readRunStatus(runDir: string): RunStatus | undefined {
  const path = runStatusPath(runDir);
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as RunStatus;
  } catch {
    // Torn read raced an in-flight write on a filesystem where rename isn't
    // fully atomic, or a pre-462 run dir's leftover garbage — treat as
    // "nothing readable yet" rather than crash a poller.
    return undefined;
  }
}

/** Merge `patch` over the existing status (defaulting fields the caller
 *  omits), stamp `updated_at`, and write atomically. Returns the merged
 *  status so callers can log/return it without a second read. */
export function patchRunStatus(runDir: string, patch: Partial<RunStatus> & { orchestrator_pid: number; started_at: string }): RunStatus {
  const existing = readRunStatus(runDir);
  const merged: RunStatus = {
    status: 'running',
    phase: 'starting',
    detached: false,
    sessions_done: 0,
    sessions_total: 0,
    ...existing,
    ...patch,
    updated_at: new Date().toISOString(),
  };
  writeRunStatus(runDir, merged);
  return merged;
}

/** Pure throttle decision for the periodic (not phase-transition) status
 *  writes — testable without timers or real I/O. Phase-transition writes
 *  always flush regardless of this. */
export function shouldFlushProgress(lastFlushMs: number, nowMs: number, minIntervalMs = 2_000): boolean {
  return nowMs - lastFlushMs >= minIntervalMs;
}

export function formatRunStatus(status: RunStatus): string {
  const lines = [
    `status:            ${status.status}`,
    `phase:              ${status.phase}`,
    `orchestrator_pid:   ${status.orchestrator_pid}`,
    `detached:           ${status.detached}`,
    `started_at:         ${status.started_at}`,
    `updated_at:         ${status.updated_at}`,
    `sessions:           ${status.sessions_done}/${status.sessions_total}`,
  ];
  if (status.exit_code !== undefined) lines.push(`exit_code:          ${status.exit_code}`);
  if (status.error) lines.push(`error:              ${status.error}`);
  return lines.join('\n');
}

/** Shared `--status <run-dir>` implementation for both harnesses (mirrors
 *  ../shared/run-params.ts's single-shared-decision-point precedent — the
 *  CLI's job is reduced to "call this and exit"). Returns the process exit
 *  code the caller should use. */
export function printRunStatus(runDir: string): number {
  const status = readRunStatus(runDir);
  if (!status) {
    console.error(`no run-status.json found in ${runDir} -- this run dir predates --detach/status support, or hasn't started yet.`);
    return 1;
  }
  console.log(formatRunStatus(status));
  return 0;
}
