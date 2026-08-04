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
 *
 * P0-3 (2026-08-04): the destination used to be `docs/eval-runs` resolved
 * relative to `process.cwd()`. Run this from inside a throwaway git
 * worktree (which is exactly where eval sandboxes live) and the archive
 * lands in THAT worktree's own copy of docs/eval-runs/ — real bytes on
 * disk, but never committed, so deleting the worktree erases them
 * silently. This repo already lost two headline LoCoMo numbers this way:
 * the 0.5549 dual-pass number cited in src/config/config.ts:1780-1789 as
 * the justification for shipping extractionPasses:2, and the 0.6002
 * conv-1 champion recorded in docs/eval-runs/README.md as "run dir
 * deleted". Fixed by resolving the destination to the PRIMARY checkout via
 * `git rev-parse --git-common-dir` (shared across every worktree of one
 * repo) instead of cwd — see resolveMainWorktreeRoot() below. If that
 * resolution fails, this script refuses to archive anything and exits
 * non-zero rather than silently writing to (and reporting success for) a
 * path that might not survive — loud failure is this repo's convention
 * (ADR-015's rate canary, auto-merge.yml's fail-loud preflight) precisely
 * because a quiet skip once hid a real problem for weeks.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, readdirSync, statSync, appendFileSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { execSync } from 'node:child_process';

/**
 * Resolve the root of the PRIMARY (non-worktree) checkout, so archived
 * evidence survives deletion of whatever worktree this script happens to be
 * invoked from. `git rev-parse --path-format=absolute --git-common-dir`
 * returns the one shared `.git` dir for every worktree of a repo: from the
 * primary checkout that's `<root>/.git` (parent = the checkout root); from
 * a linked worktree it's STILL `<root>/.git` of the primary checkout
 * (parent = that same primary root, not the worktree). Same formula
 * either way — no special-casing needed between the two.
 */
export function resolveMainWorktreeRoot(cwd: string = process.cwd()): string {
  let commonDir: string;
  try {
    commonDir = execSync('git rev-parse --path-format=absolute --git-common-dir', { cwd, encoding: 'utf8' }).trim();
  } catch (err) {
    throw new Error(`could not resolve the primary git checkout from ${cwd} (git rev-parse --git-common-dir failed: ${(err as Error).message})`);
  }
  if (!commonDir) {
    throw new Error(`git rev-parse --git-common-dir returned nothing for ${cwd}`);
  }
  return dirname(commonDir);
}

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

let mainRoot: string;
try {
  mainRoot = resolveMainWorktreeRoot();
} catch (err) {
  console.error(`archive-run: ${(err as Error).message}`);
  console.error('Refusing to archive — a lost archive path is exactly how this repo lost two headline LoCoMo numbers already (see docs/eval-runs/README.md).');
  process.exit(1);
}

const destRoot = join(mainRoot, 'docs', 'eval-runs');
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

// dest/ledger are joined off mainRoot, which resolveMainWorktreeRoot()
// returns absolute (git rev-parse --path-format=absolute) — so these are
// already durable, worktree-independent paths, not cwd-relative ones. A
// score line printed without this path next to it is how this got lost
// the first two times (see file header) — always print both together.
console.log(`score: ${score}${n ? ` (n=${n})` : ''}`);
console.log(`archived ${copied.length} files -> ${dest}`);
console.log(`ledger row appended -> ${ledger}`);
