/**
 * Judge orchestrator (plan doc section 2 + 3.4, adapted for Azure — see
 * judge/evaluate_qa_azure.py's header for exactly what and why it diverges
 * from the upstream script).
 *
 * 1. Ensures a pristine clone of xiaowu0162/LongMemEval exists at
 *    .eval-data/LongMemEval (kept unmodified, for provenance/diffing against
 *    our fork — not executed directly, since it can't reach Azure unmodified).
 * 2. Ensures the judge's python deps (openai, backoff, tqdm, numpy) are
 *    importable, installing them via pip if not.
 * 3. Runs judge/evaluate_qa_azure.py against the hypothesis + reference
 *    files with AZURE_OPENAI_* env set.
 * 4. Runs judge/metrics.mts on the result file and prints the report (NOT
 *    upstream's print_qa_metrics.py — see metrics.mts header for why).
 *
 * bun scripts/eval/longmemeval/judge.mts --hyp <hypotheses.jsonl>
 *   --ref <dataset.json> [--judge gpt-5-mini|gpt-4o] [--skip-clone]
 */
import { existsSync, mkdirSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveAzureConfig } from './lib/config.js';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const UPSTREAM_REPO_URL = 'https://github.com/xiaowu0162/LongMemEval';
const UPSTREAM_CLONE_DIR = join(SCRIPT_DIR, '..', '..', '..', '.eval-data', 'LongMemEval');

function ensureUpstreamCloned(): void {
  if (existsSync(UPSTREAM_CLONE_DIR)) {
    console.log(`Upstream LongMemEval already present at ${UPSTREAM_CLONE_DIR} (not re-cloned).`);
    return;
  }
  console.log(`Cloning ${UPSTREAM_REPO_URL} -> ${UPSTREAM_CLONE_DIR} (pristine reference copy, not executed directly)...`);
  mkdirSync(dirname(UPSTREAM_CLONE_DIR), { recursive: true });
  execFileSync('git', ['clone', '--depth', '1', UPSTREAM_REPO_URL, UPSTREAM_CLONE_DIR], { stdio: 'inherit' });
}

function ensurePythonDeps(pythonBin: string): void {
  const check = spawnSync(pythonBin, ['-c', 'import openai, backoff, tqdm, numpy'], { stdio: 'pipe' });
  if (check.status === 0) {
    console.log('Judge python deps already importable (openai, backoff, tqdm, numpy).');
    return;
  }
  console.log('Installing judge python deps (openai backoff tqdm numpy) via pip...');
  const install = spawnSync(pythonBin, ['-m', 'pip', 'install', '--quiet', 'openai', 'backoff', 'tqdm', 'numpy'], { stdio: 'inherit' });
  if (install.status !== 0) throw new Error('pip install of judge dependencies failed — see output above.');
}

function findPython(): string {
  for (const bin of ['python3', 'python']) {
    const probe = spawnSync(bin, ['--version'], { stdio: 'pipe' });
    if (probe.status === 0) return bin;
  }
  throw new Error('No python3/python found on PATH — required for the official LongMemEval judge script.');
}

const args = process.argv.slice(2);
const get = (flag: string): string | undefined => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (flag: string): boolean => args.includes(flag);

const hypPath = get('--hyp');
const refPath = get('--ref');
const judge = get('--judge') ?? 'gpt-5-mini';
const skipClone = has('--skip-clone');

if (!hypPath || !refPath) {
  console.error('Usage: bun judge.mts --hyp <hypotheses.jsonl> --ref <dataset.json> [--judge gpt-5-mini|gpt-4o] [--skip-clone]');
  process.exit(1);
}
if (judge === 'gpt-4o') {
  console.log('NOTE: gpt-4o is the final-published-numbers judge (plan doc section 6 cost note) — do not burn it on routine smoke iterations.');
}

if (!skipClone) ensureUpstreamCloned();

const pythonBin = findPython();
ensurePythonDeps(pythonBin);

const azureCfg = resolveAzureConfig();
console.log(`Judging ${hypPath} with Azure deployment "${judge}" (endpoint=${azureCfg.endpoint}, api-version=${azureCfg.apiVersion})...`);

const forkScript = join(SCRIPT_DIR, 'judge', 'evaluate_qa_azure.py');
const run = spawnSync(pythonBin, [forkScript, judge, hypPath, refPath], {
  stdio: 'inherit',
  env: {
    ...process.env,
    AZURE_OPENAI_ENDPOINT: azureCfg.endpoint,
    AZURE_OPENAI_API_KEY: azureCfg.key,
    AZURE_OPENAI_API_VERSION: azureCfg.apiVersion,
  },
});
if (run.status !== 0) {
  console.error(`evaluate_qa_azure.py exited with status ${run.status}`);
  process.exit(run.status ?? 1);
}

const resultsPath = `${hypPath}.eval-results-${judge}`;
console.log(`\nAggregating metrics from ${resultsPath}...`);
const metricsRun = spawnSync('bun', [join(SCRIPT_DIR, 'judge', 'metrics.mts'), '--results', resultsPath, '--ref', refPath], { stdio: 'inherit' });
process.exit(metricsRun.status ?? 0);
