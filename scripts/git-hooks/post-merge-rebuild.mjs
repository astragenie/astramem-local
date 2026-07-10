/**
 * post-merge-rebuild.mjs — FEAT-439 AC-1/AC-3/AC-4 rebuild-trigger logic.
 *
 * Invoked by the thin `scripts/git-hooks/post-merge` git hook. Kept as an
 * importable ESM module (rather than inlined directly in the hook file) so
 * its pure detection logic (`touchesWatchedPaths`) is unit-testable without
 * a real git repo or an actual `bun install`/`bun run build` — see
 * tests/scripts/post-merge-rebuild.test.ts. Never executed directly (no
 * shebang needed): `post-merge` statically imports it, and the test loads
 * it via a runtime `import()` — Vite/Vitest's SSR module runner evaluates
 * dynamically-imported modules with `node:vm`, which (unlike Node's own
 * module loader) does not strip a leading `#!` shebang line and throws
 * `SyntaxError: Invalid or unexpected token` on it.
 *
 * Enable once per checkout:
 *   git config core.hooksPath scripts/git-hooks
 *
 * git invokes `post-merge` exactly once per `git merge` / `git pull`
 * operation — never once per commit — so a batch of N commits touching
 * `migrations/` or `src/storage/` in one pull naturally triggers exactly one
 * rebuild (AC-4) with no extra bookkeeping needed for the common case. A
 * same-HEAD marker file (`.git/astramem-post-merge-last-rebuilt-sha`) is
 * kept anyway as a defensive de-dup in case the hook fires twice for an
 * unchanged HEAD (e.g. a no-op `git pull`, or a second manual invocation).
 *
 * Detects whether the merge touched `migrations/` or `src/storage/` — the
 * two trees that can leave the served binary schema-stale (2026-07-07
 * stale-dist incident). If so, runs `bun install && bun run build &&
 * node dist/cli/index.js reinstall` from the repo root (the exact upgrade
 * flow CLAUDE.md documents for humans, now automated).
 *
 * MUST NOT block or fail the merge (AC-3): every failure path here is
 * caught, reported loudly to stderr (never silently swallowed), and
 * `main()` always resolves without throwing. The previously-served release
 * keeps serving on failure — this script never touches current.json / the
 * shim directly; that is entirely `reinstall`'s job, and `reinstall` itself
 * only repoints after its own boot-verify passes (src/service/release.ts).
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Dirs whose changes can leave the served binary schema-stale (FEAT-439). */
export const WATCHED_PREFIXES = ['migrations/', 'src/storage/'];

/** Pure predicate — exported for unit tests (AC-1/AC-4 detection logic). */
export function touchesWatchedPaths(files, prefixes = WATCHED_PREFIXES) {
  return files.some(f => prefixes.some(p => f.startsWith(p)));
}

// Generous ceiling so a hung `bun install`/`bun run build` (stalled registry,
// interactive prompt, etc.) can't block `git pull` forever — this hook runs
// synchronously inside the user's merge/pull, so an unbounded spawnSync here
// would hang their shell indefinitely. 10 minutes comfortably covers a cold
// `bun install` + full build on a slow machine while still guaranteeing the
// hook eventually returns control to git.
const SPAWN_TIMEOUT_MS = 10 * 60 * 1000;

function run(cmd, args, cwd) {
  // No `shell: true` — matches src/service/release.ts's runCaptured(), which
  // already spawns 'bun'/node the same way on Windows without it (Node
  // resolves the PATH-installed 'bun'/'git' binary directly). Avoids the
  // Node DEP0190 warning that comes with combining shell:true and an args
  // array (unescaped argument concatenation).
  const res = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: SPAWN_TIMEOUT_MS });
  return {
    status: res.status ?? 1,
    stdout: res.stdout ?? '',
    stderr: (res.stderr ?? '') + (res.error ? '\n' + res.error.message : ''),
  };
}

function currentHeadSha(repoRoot) {
  const res = run('git', ['rev-parse', 'HEAD'], repoRoot);
  return res.status === 0 ? res.stdout.trim() : null;
}

/**
 * Files touched between ORIG_HEAD (the pre-merge tip git records for every
 * merge/pull) and HEAD, or null if the range can't be resolved (e.g. no
 * merge/pull has ever run in this checkout yet) — callers must treat null as
 * "skip detection", never as "no files changed".
 */
function changedFiles(repoRoot) {
  const origHead = run('git', ['rev-parse', 'ORIG_HEAD'], repoRoot);
  if (origHead.status !== 0) return null;
  const diff = run('git', ['diff', '--name-only', origHead.stdout.trim(), 'HEAD'], repoRoot);
  if (diff.status !== 0) return null;
  return diff.stdout.split('\n').filter(Boolean);
}

function loudFail(step, result) {
  process.stderr.write(
    `\n[astramem post-merge] REBUILD FAILED at step "${step}" (exit ${result.status}) — ` +
      `merge is NOT reverted; the previously-served release keeps serving.\n` +
      `Run manually: bun install && bun run build && node dist/cli/index.js reinstall\n` +
      `--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}\n`,
  );
}

/**
 * Entry point. `repoRoot` defaults to two dirs up from this file
 * (scripts/git-hooks/ -> repo root); overridable for tests. Always resolves
 * (never throws) — every failure is reported via stderr and swallowed, per
 * AC-3's non-blocking-safe contract.
 */
export function main(repoRoot = join(__dirname, '..', '..')) {
  try {
    const markerPath = join(repoRoot, '.git', 'astramem-post-merge-last-rebuilt-sha');
    const head = currentHeadSha(repoRoot);
    if (!head) {
      process.stderr.write('[astramem post-merge] could not resolve HEAD — skipping migration-currency check.\n');
      return;
    }

    let marker = null;
    try {
      if (existsSync(markerPath)) marker = readFileSync(markerPath, 'utf8').trim();
    } catch {
      /* best-effort — a marker read failure just means we might rebuild redundantly */
    }
    if (marker === head) return; // AC-4 defensive de-dup: already handled this exact HEAD

    const files = changedFiles(repoRoot);
    if (files === null) {
      process.stderr.write('[astramem post-merge] could not resolve ORIG_HEAD..HEAD — skipping migration-currency check.\n');
      return;
    }
    if (!touchesWatchedPaths(files)) return; // nothing schema-relevant landed — no-op, no side effects

    process.stderr.write('[astramem post-merge] migrations/ or src/storage/ changed — rebuilding + reinstalling...\n');

    const install = run('bun', ['install'], repoRoot);
    if (install.status !== 0) return loudFail('bun install', install);

    const build = run('bun', ['run', 'build'], repoRoot);
    if (build.status !== 0) return loudFail('bun run build', build);

    const reinstall = run('node', [join(repoRoot, 'dist', 'cli', 'index.js'), 'reinstall'], repoRoot);
    if (reinstall.status !== 0) return loudFail('reinstall', reinstall);

    try {
      writeFileSync(markerPath, head, 'utf8');
    } catch {
      /* best-effort — worst case is a redundant rebuild next time, never a crash */
    }
    process.stderr.write(`[astramem post-merge] rebuild + reinstall complete for ${head}.\n`);
  } catch (err) {
    process.stderr.write(`[astramem post-merge] unexpected error (non-fatal, merge unaffected): ${err && err.stack ? err.stack : err}\n`);
  }
}
