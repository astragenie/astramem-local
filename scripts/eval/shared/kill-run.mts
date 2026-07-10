/**
 * Operator cleanup CLI (review fix, Finding 2 — a concrete, copy-pasteable
 * command for the "my detached run looks stuck" README playbook). Reads
 * `daemon-manifest.json` from the given run dir and signals ONLY the
 * daemons `killManifestDaemons` can confirm are still alive on their
 * recorded port (../shared/daemon-manifest.ts's identity guard, review fix
 * Finding 1) — never a machine-wide image-name sweep (CLAUDE.md's Do-NOT
 * section), and never a signal sent on ambiguous identity (skip-by-default,
 * no force flag in this slice).
 *
 * bun scripts/eval/shared/kill-run.mts <run-dir> [--signal SIGTERM]
 */
import { pathToFileURL } from 'node:url';
import { readDaemonManifest, killManifestDaemons, type KillManifestResult } from './daemon-manifest.js';
import { readRunStatus, patchRunStatus } from './run-status.js';

export interface KillRunOutcome {
  result: KillManifestResult | undefined;
  /** Human-readable lines already formatted for console output — kept on
   *  the return value so a test can assert on content without capturing
   *  console.log. */
  lines: string[];
  exitCode: number;
}

/** Core logic, factored out of the CLI entry point below so it's directly
 *  unit-testable (same "CLI + module" shape as ../longmemeval/ingest.mts
 *  and friends) without spawning this file as a subprocess. */
export function killRun(runDir: string, signal: NodeJS.Signals = 'SIGTERM'): KillRunOutcome {
  const manifest = readDaemonManifest(runDir);
  if (!manifest) {
    return {
      result: undefined,
      lines: [`no daemon-manifest.json found in ${runDir} -- nothing to kill (or this run dir predates FEAT-462 slice B).`],
      exitCode: 1,
    };
  }
  if (manifest.daemons.length === 0) {
    return { result: undefined, lines: [`daemon-manifest.json in ${runDir} has no recorded daemons -- nothing to do.`], exitCode: 0 };
  }

  const result = killManifestDaemons(manifest, signal);
  const lines = result.outcomes.map(o => `shard ${o.shard} (${o.label}) pid=${o.pid ?? 'n/a'} port=${o.port}: ${o.action} -- ${o.detail}`);
  lines.push(`\n${result.killed.length} killed, ${result.alreadyDead.length} already dead, ${result.skipped.length} skipped (identity could not be confirmed).`);

  if (result.killed.length > 0) {
    const existing = readRunStatus(runDir);
    patchRunStatus(runDir, {
      status: 'failed',
      phase: 'failed',
      orchestrator_pid: existing?.orchestrator_pid ?? -1,
      started_at: existing?.started_at ?? new Date().toISOString(),
      error: `manually killed via kill-run.mts (${result.killed.length} daemon(s) signaled)`,
      exit_code: 1,
    });
    lines.push(`run-status.json updated to 'failed'. Resume with --resume ${runDir} once ready.`);
  }

  // Non-zero exit when anything couldn't be confirmed dead/killed -- an
  // operator running this unattended (e.g. from a cron/scheduled cleanup)
  // should see a failure signal when identity couldn't be verified, rather
  // than a silent no-op.
  return { result, lines, exitCode: result.skipped.length > 0 ? 1 : 0 };
}

// ── CLI entry ────────────────────────────────────────────────────────────
const isMain = (() => {
  try {
    return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();

if (isMain) {
  const args = process.argv.slice(2);
  const runDir = args[0];
  const signalIdx = args.indexOf('--signal');
  const signal = (signalIdx >= 0 ? args[signalIdx + 1] : 'SIGTERM') as NodeJS.Signals;

  if (!runDir || runDir.startsWith('--')) {
    console.error('usage: bun scripts/eval/shared/kill-run.mts <run-dir> [--signal SIGTERM]');
    process.exitCode = 1;
  } else {
    const outcome = killRun(runDir, signal);
    for (const line of outcome.lines) console.log(line);
    process.exitCode = outcome.exitCode;
  }
}
