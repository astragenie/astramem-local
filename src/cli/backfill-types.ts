/**
 * `astramem-local backfill-types [--apply] [--batch-size N] [--limit N] [--reset] [--json]`
 *
 * FEAT-552 sub-scope B (AC-B2): one-shot, operator-invoked re-typing of
 * EXISTING stored atoms using the deterministic type-hint rules module
 * (src/distill/type-hints.ts) — the same zero-LLM patterns applied going
 * forward at distill time (07-memory-normalize.ts), run retroactively over
 * the corpus. Fixes the "~1/3 of decisions invisible to type-filtered
 * search" product defect for atoms extracted before this tier existed (or
 * while `distill.typeHints` was 'off'), with zero LLM calls.
 *
 * Dry-run is the DEFAULT (mirrors retag/entity-backfill/repo-identity-backfill
 * — every other backfill CLI in this repo previews before mutating): prints
 * the would-change census (fromType -> toType -> count) with no row
 * mutated. `--apply` actually updates `memories.type` and appends a
 * correction-style audit event per change (src/distill/backfill-types.ts's
 * doc comment explains why that's tagged `type_corrected`, not
 * `memory_corrected`).
 *
 * Resumable: batches run against `memories` ordered by rowid, and after
 * every batch this CLI persists the last-examined rowid to a checkpoint
 * file (<dataDir>/backfill-types.checkpoint.json). An interrupted --apply
 * run resumes from that point on the next invocation instead of re-scanning
 * (harmless but wasteful) or silently skipping unexamined rows (worse).
 * Dry-run runs never read or write the checkpoint — a preview should always
 * reflect the WHOLE corpus, never a resume point left over from a previous
 * --apply run. `--reset` clears the checkpoint before running (start over).
 */
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { openRuntimeDb } from './open-runtime-db.js';
import { MemoryEventRepo } from '../storage/memory-events.js';
import { runTypeBackfillBatch, type TypeChangeCandidate } from '../distill/backfill-types.js';

const DEFAULT_BATCH_SIZE = 500;

function parseArg(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

function checkpointPath(dataDir: string): string {
  return join(dataDir, 'backfill-types.checkpoint.json');
}

function readCheckpoint(path: string): number {
  if (!existsSync(path)) return 0;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { lastRowid?: unknown };
    return typeof raw.lastRowid === 'number' && Number.isFinite(raw.lastRowid) ? raw.lastRowid : 0;
  } catch {
    // Malformed checkpoint — same non-fatal "start over" posture the rest of
    // this repo's disk-state readers take (e.g. loadConfigFromDisk on a
    // malformed config.yaml). Never blocks the run.
    return 0;
  }
}

function writeCheckpoint(path: string, lastRowid: number): void {
  writeFileSync(path, JSON.stringify({ lastRowid, updatedAt: new Date().toISOString() }, null, 2), 'utf8');
}

export interface BackfillTypesRunResult {
  dryRun: boolean;
  scanned: number;
  changed: number;
  census: Record<string, Record<string, number>>;
  candidates: TypeChangeCandidate[];
  resumedFromRowid: number;
  lastRowid: number;
  exhausted: boolean;
}

export async function backfillTypesCommand(args: string[]): Promise<void> {
  const jsonMode = args.includes('--json');
  const apply = args.includes('--apply');
  const reset = args.includes('--reset');
  const batchSizeArg = parseArg(args, '--batch-size');
  const batchSize = batchSizeArg ? Math.max(1, Number(batchSizeArg)) : DEFAULT_BATCH_SIZE;
  const limitArg = parseArg(args, '--limit');
  const overallLimit = limitArg ? Math.max(1, Number(limitArg)) : undefined;

  const { db, dataDir } = openRuntimeDb();
  const events = new MemoryEventRepo(db);
  const cpPath = checkpointPath(dataDir);

  if (reset && existsSync(cpPath)) unlinkSync(cpPath);

  // Dry-run always previews the WHOLE corpus from the start — resuming a
  // preview from a stale --apply checkpoint would silently hide already-seen
  // candidates from the operator deciding whether to --apply at all.
  const resumedFromRowid = apply ? readCheckpoint(cpPath) : 0;

  let startAfterRowid = resumedFromRowid;
  let scanned = 0;
  let changed = 0;
  const census: Record<string, Record<string, number>> = {};
  const candidates: TypeChangeCandidate[] = [];
  let exhausted = false;

  for (;;) {
    const remaining = overallLimit !== undefined ? overallLimit - scanned : undefined;
    if (remaining !== undefined && remaining <= 0) break;
    const thisBatchSize = remaining !== undefined ? Math.min(batchSize, remaining) : batchSize;

    const result = runTypeBackfillBatch(db, events, { apply, batchSize: thisBatchSize, startAfterRowid });

    scanned += result.scanned;
    changed += result.changed;
    candidates.push(...result.candidates);
    for (const [from, toCounts] of Object.entries(result.census)) {
      census[from] ??= {};
      for (const [to, count] of Object.entries(toCounts)) {
        census[from][to] = (census[from][to] ?? 0) + count;
      }
    }
    startAfterRowid = result.lastRowid;
    exhausted = result.exhausted;

    // Checkpoint after every batch (apply mode only — dry-run never writes
    // one) so a kill mid-run loses at most one in-flight batch, never the
    // whole scan.
    if (apply) writeCheckpoint(cpPath, startAfterRowid);

    if (result.exhausted || result.scanned === 0) break;
  }

  db.close();

  const output: BackfillTypesRunResult = {
    dryRun: !apply,
    scanned,
    changed,
    census,
    candidates,
    resumedFromRowid,
    lastRowid: startAfterRowid,
    exhausted,
  };

  if (jsonMode) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  console.log('');
  console.log('  AstraMemory Type Backfill');
  console.log('  ─────────────────────────');
  if (apply && resumedFromRowid > 0) {
    console.log(`  Resumed from checkpoint rowid ${resumedFromRowid}.`);
  }
  console.log(`  Scanned: ${scanned}`);
  console.log(`  Changed: ${changed}`);
  console.log(`  Would-change census (fromType -> toType: count):`);
  const fromTypes = Object.keys(census).sort();
  if (fromTypes.length === 0) {
    console.log('    (no candidates found)');
  }
  for (const from of fromTypes) {
    const toCounts = census[from] ?? {};
    for (const [to, count] of Object.entries(toCounts).sort()) {
      console.log(`    ${from} -> ${to}: ${count}`);
    }
  }
  if (!apply) {
    console.log('  --dry-run: no rows were mutated. Re-run with --apply to update memories.type.');
  } else if (!exhausted) {
    console.log(`  Batch limit reached at rowid ${startAfterRowid} — re-run to continue (resumable).`);
  } else {
    console.log('  Scan complete — reached the end of the table.');
  }
  console.log('');
}
