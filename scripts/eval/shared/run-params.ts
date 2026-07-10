/**
 * Resume scope-guard (FEAT-462 review fix, finding 5 — MEDIUM-HIGH). A
 * `--resume` invocation launched with different sampling flags than the
 * original run — most dangerously a SMALLER `--n` — can silently complete
 * a scope-narrowed run that looks fully successful: `sampleStratified` /
 * `sampleLocomo` are seeded shuffles that slice a prefix, so a smaller `n`
 * under the same seed produces a sample that is a strict SUBSET of the
 * original larger one. Every one of those sessions is already `ok:true`
 * in the ledger from the larger original run, so nothing gets re-ingested,
 * nothing fails, and `run-manifest.json`'s `counts.sampled` just reflects
 * the smaller number — with nothing warning that the scope silently
 * narrowed. That is the "quietly publish a dishonest number" failure this
 * FEAT exists to prevent, and it's the opposite (and more dangerous)
 * direction from "resume found nothing to skip, re-ingests everything."
 *
 * Fix: persist the scope-determining params to `run-params.json` on the
 * FIRST (non-resume) invocation. On `--resume`, load it and compare — ANY
 * mismatch is a hard, non-zero-exit refusal naming every differing param
 * and its original value. There is no override flag: an operator who
 * wants different params starts a fresh run dir. A run dir with no
 * `run-params.json` (e.g. one created before this fix existed) also
 * hard-errors on `--resume` — an honest "this run dir predates resume
 * support," not a silent proceed.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';

export type RunParams = Record<string, string | number | boolean | null>;

/** sha256 of the dataset file's raw bytes — cheap relative to the
 *  load+JSON.parse the harness already does on every invocation (the
 *  dataset gets read again right after), and catches a --resume pointed
 *  at a same-path-but-different dataset file (e.g. a re-downloaded LoCoMo
 *  dataset, or a hand-edited LongMemEval subset). */
export function hashDatasetFile(path: string): string {
  const hash = createHash('sha256');
  hash.update(readFileSync(path));
  return hash.digest('hex');
}

export function writeRunParams(runParamsPath: string, params: RunParams): void {
  const sorted: RunParams = {};
  for (const key of Object.keys(params).sort()) sorted[key] = params[key]!;
  writeFileSync(runParamsPath, JSON.stringify(sorted, null, 2), 'utf8');
}

export interface RunParamsCheckResult {
  ok: boolean;
  /** true if run-params.json itself was missing — a pre-fix run dir. */
  missingFile: boolean;
  /** One "param: original=X, current=Y" line per differing (or
   *  present-on-only-one-side) key. Empty when ok. */
  mismatches: string[];
}

export function checkRunParams(runParamsPath: string, current: RunParams): RunParamsCheckResult {
  if (!existsSync(runParamsPath)) {
    return { ok: false, missingFile: true, mismatches: [] };
  }
  const original = JSON.parse(readFileSync(runParamsPath, 'utf8')) as RunParams;
  const mismatches: string[] = [];
  const allKeys = new Set([...Object.keys(original), ...Object.keys(current)]);
  for (const key of [...allKeys].sort()) {
    const o = original[key] ?? null;
    const c = current[key] ?? null;
    if (o !== c) mismatches.push(`${key}: original=${JSON.stringify(o)}, current=${JSON.stringify(c)}`);
  }
  return { ok: mismatches.length === 0, missingFile: false, mismatches };
}

export type ResumeGuardResult =
  | { action: 'proceed-fresh' }
  | { action: 'proceed-resume' }
  | { action: 'refuse'; refuseMessage: string };

/**
 * The single decision point both `run-smoke.mts` and `run.mts` call
 * (FEAT-462 AC-6 — identical shared logic, not per-harness copies). Pulled
 * out of the CLI files themselves so this specific decision (write vs.
 * compare vs. refuse) is unit-testable without spawning either harness as
 * a subprocess or touching Ollama/Azure/a daemon — the CLI's own job is
 * reduced to "call this, print refuseMessage and exit(1) on refuse."
 */
export function evaluateResumeGuard(runParamsPath: string, resuming: boolean, current: RunParams): ResumeGuardResult {
  if (!resuming) {
    writeRunParams(runParamsPath, current);
    return { action: 'proceed-fresh' };
  }
  const check = checkRunParams(runParamsPath, current);
  if (check.missingFile) {
    return {
      action: 'refuse',
      refuseMessage: 'no run-params.json found in this run dir -- it predates FEAT-462\'s resume support, so there is no record of the original sampling flags to verify against. Refusing to resume; start a fresh run dir.',
    };
  }
  if (!check.ok) {
    const lines = check.mismatches.map(m => `  ${m}`).join('\n');
    return {
      action: 'refuse',
      refuseMessage: `refusing to resume -- these params differ from the original invocation (resuming anyway could silently narrow or change the run's scope):\n${lines}\nStart a fresh run dir if you intend different params.`,
    };
  }
  return { action: 'proceed-resume' };
}
