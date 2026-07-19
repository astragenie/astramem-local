/**
 * Archive a LoCoMo run's provenance into the repo (2026-07-18, operator
 * directive: "record all runs with parameters and save as important
 * artifact"). Run dirs live in gitignored .eval-data/ and get deleted or
 * overwritten — this copies the durable evidence into docs/eval-runs/ so
 * every published or referenced number is checkable from git history alone.
 *
 *   bun scripts/eval/locomo/archive-run.mts --run-dir <dir> --name <slug>
 *
 * Copies: run-manifest.json, run-params.json, <run>.metrics.json (if judged),
 * every sandbox-config.yaml. Appends a one-line row to docs/eval-runs/LEDGER.md.
 * Idempotent per --name (re-archiving overwrites the same folder).
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, readdirSync, statSync, appendFileSync } from 'node:fs';
import { join, basename } from 'node:path';

const args = process.argv.slice(2);
const get = (flag: string): string | undefined => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};

const runDir = get('--run-dir');
const name = get('--name');
if (!runDir || !name || !/^[a-z0-9][a-z0-9-]*$/.test(name)) {
  console.error('Usage: bun scripts/eval/locomo/archive-run.mts --run-dir <dir> --name <kebab-slug>');
  process.exit(1);
}
if (!existsSync(runDir)) {
  console.error(`run dir not found: ${runDir}`);
  process.exit(1);
}

const destRoot = join('docs', 'eval-runs');
const dest = join(destRoot, name);
mkdirSync(dest, { recursive: true });

const copied: string[] = [];
function copyIfExists(src: string, destName?: string): void {
  if (existsSync(src)) {
    copyFileSync(src, join(dest, destName ?? basename(src)));
    copied.push(destName ?? basename(src));
  }
}

copyIfExists(join(runDir, 'run-manifest.json'));
copyIfExists(join(runDir, 'run-params.json'));
copyIfExists(join(runDir, 'sandbox-config.yaml'));
// Sharded runs keep per-shard sandbox configs one level down.
for (const entry of readdirSync(runDir)) {
  const p = join(runDir, entry);
  if (statSync(p).isDirectory() && existsSync(join(p, 'sandbox-config.yaml'))) {
    copyIfExists(join(p, 'sandbox-config.yaml'), `${entry}-sandbox-config.yaml`);
  }
}
// judge.mts writes <runDir>.metrics.json as a SIBLING of the run dir.
copyIfExists(`${runDir.replace(/[\\/]+$/, '')}.metrics.json`, 'metrics.json');

// Ledger row: date | name | score | atoms-if-knowable | key params.
let score = 'unjudged';
let n = '';
const metricsPath = join(dest, 'metrics.json');
if (existsSync(metricsPath)) {
  try {
    const m = JSON.parse(readFileSync(metricsPath, 'utf8'));
    const f1 = m.f1 ?? (Array.isArray(m.runs) ? m.runs[0]?.f1 : undefined) ?? m;
    const catAvg = f1.category_averaged_accuracy ?? f1.categoryAveraged ?? (() => {
      const cats = f1.per_category ? Object.values(f1.per_category) as Array<{ accuracy: number; n: number }> : [];
      return cats.length ? cats.reduce((s, c) => s + c.accuracy, 0) / cats.length : undefined;
    })();
    const total = f1.per_category
      ? (Object.values(f1.per_category) as Array<{ n: number }>).reduce((s, c) => s + c.n, 0)
      : undefined;
    score = catAvg !== undefined ? catAvg.toFixed(4) : 'see-file';
    n = total !== undefined ? String(total) : '';
  } catch { /* leave 'unjudged' */ }
}
let params = '';
const manifestPath = join(dest, 'run-manifest.json');
if (existsSync(manifestPath)) {
  try {
    const c = JSON.parse(readFileSync(manifestPath, 'utf8')).config ?? {};
    params = `passes=${c.extractionPasses ?? '?'} sweep=${c.passBSweep ?? '?'} prompt=${c.extractPromptEnv ?? 'none'} k=${c.k ?? '?'} ` +
      `extract=${c.models?.extractionProvider ?? '?'}/${c.models?.extraction ?? '?'} git=${c.gitState?.sha ?? '?'}${c.gitState?.srcDirty ? '+DIRTY' : ''}`;
  } catch { /* omit */ }
}
const ledger = join(destRoot, 'LEDGER.md');
if (!existsSync(ledger)) {
  writeFileSync(ledger, '# LoCoMo run ledger\n\nOne row per archived run — newest last. Full provenance in each folder.\n\n| date | name | score | n | params |\n|---|---|---|---|---|\n');
}
const today = new Date().toISOString().slice(0, 10);
appendFileSync(ledger, `| ${today} | [${name}](${name}/) | ${score} | ${n} | ${params} |\n`);

console.log(`archived ${copied.length} files -> ${dest}`);
console.log(`ledger row appended -> ${ledger}`);
