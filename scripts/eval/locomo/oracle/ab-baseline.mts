/**
 * ab-baseline.mts — the ONE dev-recipe A/B command every Wave-1 worktree
 * runs identically (2026-07-20 retrieval-overhaul plan, Wave 0, P0.3).
 *
 * A thin wrapper around oracle-factorial.mts, PINNED to the cheap dev
 * recipe locked in docs/specs/20260720-retrieval-overhaul-plan.md's
 * "Measurement protocol" section:
 *   - source    = retrieved-atoms   (the real hybrid /recall path — see
 *                 scripts/eval/locomo/oracle/sources/retrieved-atoms.mts,
 *                 byte-faithful to answer.mts's real retrieval call)
 *   - answerer  = current           (gpt-5-mini, reasoning minimal — the
 *                 FROZEN benchmark answerer; NOT the gpt-5.4 diagnostic
 *                 zep-match reader, which is gate-only)
 *   - judge     = token-F1 (always) + gpt-5-mini llm-judge (secondary) —
 *                 NOT the gpt-5.4 CoT rejudge.mts, which is gate-only
 *   - sample    = conv-26, n=152 (cat1-4) — oracle-factorial's own default
 *                 --conv resolution, pinned explicitly here for clarity
 *
 * This does NOT reimplement any scoring — it shells out to
 * oracle-factorial.mts (same runtime as this process) with a fixed argument
 * set, then reads back its own factorial.json to print the two cat-avg
 * numbers every keep/revert decision in the plan is made from.
 *
 * Usage:
 *   bun scripts/eval/locomo/oracle/ab-baseline.mts --datadir <path> [--label before|after] [--out <dir>]
 *
 * --datadir is REQUIRED and deliberately NOT defaulted to the shared
 * baseline-v2 store — the whole point of this command is comparing a
 * candidate change against a SCRATCH COPY of that store (`cp -r
 * .eval-data/locomo/runs/20260720-baseline-v2/datadir <scratch-path>`),
 * never mounting a second daemon on the shared original: concurrent
 * daemons on one datadir contend on the instance lock (see the plan's
 * "Per-worktree A/B without daemon-lock contention" note).
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ORACLE_FACTORIAL = join(HERE, 'oracle-factorial.mts');
const PINNED_CONV = 'conv-26';

interface FactorialCell {
  sourceId: string;
  answererId: string;
  f1: { category_averaged_accuracy: number; n_total: number };
  llmJudge?: { category_averaged_accuracy: number };
}

function get(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const datadir = get('--datadir');
  if (!datadir) {
    console.error(
      'ab-baseline: --datadir <path> is required — point it at a SCRATCH COPY of a ' +
      'pre-ingested store (e.g. a copy of .eval-data/locomo/runs/20260720-baseline-v2/datadir), ' +
      'never the shared original (concurrent daemons on one datadir contend on the instance lock).',
    );
    process.exit(1);
  }
  if (!existsSync(datadir)) {
    console.error(`ab-baseline: --datadir ${datadir} does not exist.`);
    process.exit(1);
  }

  const label = get('--label') ?? 'ab-baseline';
  // P2 retrieval overhaul (2026-07-20, WT-B): --rerank off|onnx passthrough to
  // oracle-factorial.mts — lets a P2 A/B run through this SAME pinned-recipe
  // wrapper instead of a bespoke script, so the numbers stay comparable to
  // every other ab-baseline run. Omitting it preserves this command's
  // original off-only behavior exactly.
  const rerank = get('--rerank') ?? 'off';
  const outDir = get('--out')
    ?? join('.eval-data', 'locomo', 'oracle', `ab-baseline-${label}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  mkdirSync(outDir, { recursive: true });

  console.log(`ab-baseline [${label}]: source=retrieved-atoms answerer=current conv=${PINNED_CONV} rerank=${rerank} datadir=${datadir}`);
  console.log(`ab-baseline [${label}]: delegating to oracle-factorial.mts (out=${outDir})...\n`);

  const result = spawnSync(
    process.execPath,
    [
      ORACLE_FACTORIAL,
      '--sources', 'retrieved-atoms',
      '--answerers', 'current',
      '--conv', PINNED_CONV,
      '--datadir', datadir,
      '--out', outDir,
      '--rerank', rerank,
    ],
    { stdio: 'inherit' },
  );
  if (result.status !== 0) {
    console.error(`ab-baseline: oracle-factorial.mts exited with status ${result.status ?? 'unknown'}`);
    process.exit(result.status ?? 1);
  }

  const factorialPath = join(outDir, 'factorial.json');
  if (!existsSync(factorialPath)) {
    console.error(`ab-baseline: expected ${factorialPath} to exist after a clean oracle-factorial.mts run — nothing to summarize.`);
    process.exit(1);
  }
  const factorial = JSON.parse(readFileSync(factorialPath, 'utf8')) as { cells: FactorialCell[] };
  const cell = factorial.cells[0];
  if (!cell) {
    console.error(`ab-baseline: ${factorialPath} has no cells — nothing to summarize.`);
    process.exit(1);
  }

  console.log('');
  console.log(`=== ab-baseline [${label}] RESULT (${cell.sourceId} x ${cell.answererId}, ${PINNED_CONV}) ===`);
  console.log(`  n (cat1-4)        : ${cell.f1.n_total}`);
  console.log(`  token-F1 cat-avg  : ${cell.f1.category_averaged_accuracy.toFixed(4)}`);
  console.log(`  llm-judge cat-avg : ${cell.llmJudge ? cell.llmJudge.category_averaged_accuracy.toFixed(4) : 'n/a (run without --no-llm-judge to get this)'}`);
  console.log(`  datadir           : ${datadir}`);
  console.log(`  factorial.json    : ${factorialPath}`);
}

await main();
