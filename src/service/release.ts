/**
 * release.ts — immutable release-dir materialization (FEAT-438 slice 1).
 *
 * Root-fixes the 2026-07-07 8h stale-dist outage: the daemon was served
 * straight out of the mutable checkout, so a `git pull` + partial `bun run
 * build` (or a build that raced a schtasks keepalive restart) could leave a
 * half-updated `dist/` being served indefinitely with no signal that
 * anything was wrong.
 *
 * `materializeRelease()` instead builds a self-contained, versioned release
 * directory:
 *
 *   %LOCALAPPDATA%\Astramem\releases\<pkgversion>+<gitsha>\
 *     dist/            (copied from the checkout's build output)
 *     package.json     (copied)
 *     bun.lock         (copied — makes the install below deterministic)
 *     node_modules/     (bun install --production --frozen-lockfile, run
 *                         INSIDE this dir so native modules like the
 *                         SQLCipher better-sqlite3 fork get platform-correct
 *                         prebuilds instead of a hand-computed prod subset of
 *                         the checkout's mixed node_modules)
 *     release.json     (manifest: id, pkgversion, gitsha, createdAt, nodeVersion)
 *
 * Materialization happens in a temp sibling dir (`releases/.tmp-<uuid>`) and
 * is ONLY renamed to the final `releases/<id>` path after a boot-verify gate
 * passes:
 *
 *   node <tmp>/dist/cli/index.js --version
 *
 * `--version` is used deliberately — it exits before `migrate()` opens the
 * SQLite DB (src/storage/migrate.ts), so a schema-ahead LIVE database can
 * never fail materialization of an otherwise-correct build. That coupling
 * (stale dist vs. migrated DB) was the actual mechanism of the incident.
 *
 * Any failure along the way (copy, install, boot-verify) quarantines the
 * partial dir (renamed to `*.failed`, or deleted if the rename itself
 * fails) and throws with the captured step output inlined into the message
 * — no silent failures, per the incident's other lesson (the crash that
 * produced no log at all).
 *
 * This module does NOT repoint `current.json` / the shim — that is
 * SLICE-417. It only produces a verified, on-disk release ready to be
 * pointed at.
 */
import {
  existsSync,
  mkdirSync,
  cpSync,
  copyFileSync,
  readFileSync,
  writeFileSync,
  renameSync,
  rmSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, isAbsolute } from 'node:path';
import { defaultDataDir } from '../config/datadir.js';

export interface MaterializeReleaseOptions {
  /** Root of the built checkout (must contain dist/, package.json, lockfile).
   *  Defaults to the repo root inferred from this module's own location. */
  checkoutDir?: string;
  /** Directory releases are materialized under. Defaults to
   *  `<defaultDataDir()>/releases` (i.e. %LOCALAPPDATA%\Astramem\releases). */
  releasesRoot?: string;
  /** Node binary used for the boot-verify probe. Defaults to
   *  `process.execPath` — matches install-flow.ts's shim pointer, which uses
   *  the same value as the daemon's own launch binary. */
  nodeBin?: string;
  /** Lockfile filename to copy + pass to `--frozen-lockfile`. Defaults to
   *  'bun.lock' (this repo's lockfile; overridable for tests/fixtures). */
  lockfileName?: string;
}

export interface ReleaseManifest {
  /** `${pkgversion}+${gitsha}` — also the final directory's basename. */
  id: string;
  pkgversion: string;
  gitsha: string;
  /** ISO-8601 timestamp of materialization. */
  createdAt: string;
  /** `process.version` of the machine that ran materialization. */
  nodeVersion: string;
}

export interface MaterializeReleaseResult {
  releaseDir: string;
  manifest: ReleaseManifest;
}

interface CapturedRun {
  status: number;
  stdout: string;
  stderr: string;
}

/** Repo root inferred from this file's own location: src/service/release.ts
 *  (or dist/service/release.js post-build) is two levels below the repo
 *  root — same convention as PKG_VERSION's lookup in cli/index.ts. */
function defaultCheckoutDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', '..');
}

/** Default root releases are materialized under / read from:
 *  `<defaultDataDir()>/releases` (i.e. %LOCALAPPDATA%\Astramem\releases).
 *  Single-sourced here so materializeRelease/listReleases/pruneReleases and
 *  callers (reinstall.ts, doctor) never drift on the path. */
export function defaultReleasesRoot(): string {
  return join(defaultDataDir(), 'releases');
}

/**
 * Given a shim pointer's `entryJs` (e.g.
 * `<releasesRoot>\1.2.3+abcdef\dist\cli\index.js`), extract the release id
 * (`1.2.3+abcdef`) if it lives under `releasesRoot` — else `null` (e.g. a
 * `--dev`-pinned pointer at the mutable checkout's `dist/`, which is not
 * under releasesRoot at all). Used by `reinstall --rollback` (AC-3) and the
 * doctor pointer check (AC-4) to identify "the release currently pointed
 * at" without assuming the pointer is release-pinned.
 */
export function releaseIdFromEntryJs(entryJs: string, releasesRoot: string = defaultReleasesRoot()): string | null {
  const rel = relative(releasesRoot, entryJs);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
  const [id] = rel.split(/[\\/]/);
  return id || null;
}

function runCaptured(cmd: string, args: string[], cwd: string): CapturedRun {
  const res = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  const stderrParts = [res.stderr ?? ''];
  if (res.error) stderrParts.push(res.error.message);
  return {
    status: res.status ?? 1,
    stdout: res.stdout ?? '',
    stderr: stderrParts.filter(Boolean).join('\n'),
  };
}

/** Best-effort; tolerates a missing/non-git checkout so materialization
 *  still works (labeled 'nogit') rather than hard-failing. */
function resolveGitSha(checkoutDir: string): string {
  const res = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: checkoutDir, encoding: 'utf8' });
  if (res.status === 0) {
    const sha = (res.stdout ?? '').trim();
    if (sha) return sha;
  }
  return 'nogit';
}

/** Any step failure lands here: the partial dir must never be left looking
 *  like a valid release (AC-3). Prefer a `.failed`-suffixed rename (keeps
 *  the evidence for debugging); fall back to outright deletion if the
 *  rename itself fails for any reason. */
function quarantine(tmpDir: string): void {
  if (!existsSync(tmpDir)) return;
  const failedDir = `${tmpDir}.failed`;
  try {
    if (existsSync(failedDir)) rmSync(failedDir, { recursive: true, force: true });
    renameSync(tmpDir, failedDir);
  } catch {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup; nothing more we can do */
    }
  }
}

export function materializeRelease(opts: MaterializeReleaseOptions = {}): MaterializeReleaseResult {
  const checkoutDir = opts.checkoutDir ?? defaultCheckoutDir();
  const releasesRoot = opts.releasesRoot ?? defaultReleasesRoot();
  const nodeBin = opts.nodeBin ?? process.execPath;
  const lockfileName = opts.lockfileName ?? 'bun.lock';

  const distSrc = join(checkoutDir, 'dist');
  const pkgSrc = join(checkoutDir, 'package.json');
  const lockSrc = join(checkoutDir, lockfileName);

  // Pre-flight guards: an incomplete checkout never gets a tmp dir at all —
  // there is nothing to quarantine because nothing was created.
  if (!existsSync(distSrc)) {
    throw new Error(`materializeRelease: dist/ not found at ${distSrc} — run 'bun run build' first`);
  }
  if (!existsSync(pkgSrc)) {
    throw new Error(`materializeRelease: package.json not found at ${pkgSrc}`);
  }
  if (!existsSync(lockSrc)) {
    throw new Error(
      `materializeRelease: lockfile not found at ${lockSrc} (expected '${lockfileName}') — required for --frozen-lockfile`,
    );
  }

  mkdirSync(releasesRoot, { recursive: true });
  const tmpDir = join(releasesRoot, `.tmp-${randomUUID()}`);

  try {
    mkdirSync(tmpDir, { recursive: true });
    cpSync(distSrc, join(tmpDir, 'dist'), { recursive: true });
    copyFileSync(pkgSrc, join(tmpDir, 'package.json'));
    copyFileSync(lockSrc, join(tmpDir, lockfileName));

    const install = runCaptured('bun', ['install', '--production', '--frozen-lockfile'], tmpDir);
    if (install.status !== 0) {
      throw new Error(
        `materializeRelease: 'bun install --production --frozen-lockfile' failed (exit ${install.status}) in ${tmpDir}\n` +
          `--- stdout ---\n${install.stdout}\n--- stderr ---\n${install.stderr}`,
      );
    }

    let pkgversion: string;
    try {
      const parsed = JSON.parse(readFileSync(join(tmpDir, 'package.json'), 'utf8')) as { version?: unknown };
      if (typeof parsed.version !== 'string' || parsed.version.length === 0) {
        throw new Error('package.json has no string "version" field');
      }
      pkgversion = parsed.version;
    } catch (err) {
      throw new Error(`materializeRelease: could not read version from copied package.json: ${(err as Error).message}`);
    }

    const gitsha = resolveGitSha(checkoutDir);
    const manifest: ReleaseManifest = {
      id: `${pkgversion}+${gitsha}`,
      pkgversion,
      gitsha,
      createdAt: new Date().toISOString(),
      nodeVersion: process.version,
    };
    writeFileSync(join(tmpDir, 'release.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');

    // Boot-verify: MUST run with cwd outside the checkout, proving the
    // release dir resolves its own node_modules (incl. native modules) by
    // absolute path rather than falling back to anything checkout-relative.
    // `--version` exits before migrate()/DB open (src/storage/migrate.ts) —
    // see module header — so a schema-ahead live DB can't produce a false
    // failure here.
    const entryJs = join(tmpDir, 'dist', 'cli', 'index.js');
    const verify = runCaptured(nodeBin, [entryJs, '--version'], releasesRoot);
    const reported = verify.stdout.trim();
    if (verify.status !== 0 || reported !== pkgversion) {
      throw new Error(
        `materializeRelease: boot-verify failed for ${manifest.id} (exit ${verify.status}, reported "${reported}", expected "${pkgversion}")\n` +
          `--- stdout ---\n${verify.stdout}\n--- stderr ---\n${verify.stderr}`,
      );
    }

    const finalDir = join(releasesRoot, manifest.id);
    if (existsSync(finalDir)) {
      // Idempotent-reuse path (SLICE-417 AC-3 / SLICE-416 review MEDIUM):
      // this exact version+sha was already materialized by a prior run. Do
      // NOT trust that on-disk dir blindly — re-run the same boot-verify
      // probe against IT (not the fresh tmp build we just made) before
      // reusing it. A same-id dir that has since gone stale (partial
      // deletion, corrupted node_modules, manual tampering) must not be
      // silently repointed to.
      const existingEntryJs = join(finalDir, 'dist', 'cli', 'index.js');
      const reverify = existsSync(existingEntryJs)
        ? runCaptured(nodeBin, [existingEntryJs, '--version'], releasesRoot)
        : { status: 1, stdout: '', stderr: `entry missing: ${existingEntryJs}` };
      const reverifyReported = reverify.stdout.trim();
      if (reverify.status === 0 && reverifyReported === pkgversion) {
        // Existing dir re-verified healthy — discard the redundant
        // (but already boot-verified) tmp build and hand back the existing
        // manifest rather than double-writing.
        rmSync(tmpDir, { recursive: true, force: true });
        const existing = JSON.parse(readFileSync(join(finalDir, 'release.json'), 'utf8')) as ReleaseManifest;
        return { releaseDir: finalDir, manifest: existing };
      }
      // Existing dir failed re-verify — self-heal by promoting the fresh,
      // already-verified tmp build in its place rather than either trusting
      // a broken dir or erroring out on what should be a routine re-run.
      rmSync(finalDir, { recursive: true, force: true });
      renameSync(tmpDir, finalDir);
      return { releaseDir: finalDir, manifest };
    }

    renameSync(tmpDir, finalDir);
    return { releaseDir: finalDir, manifest };
  } catch (err) {
    quarantine(tmpDir);
    throw err;
  }
}

// ─── Retention / rollback support (FEAT-438 SLICE-418 AC-3) ─────────────────

export interface ReleaseListEntry {
  id: string;
  dir: string;
  createdAt: string;
}

export interface PruneReleasesResult {
  /** Release ids that were deleted. A delete that failed is still recorded
   *  here (soft-fail — see pruneReleases doc), annotated with the error so
   *  the caller can surface it without the run itself throwing. */
  pruned: string[];
  /** Release ids retained (newest `keep` + anything in `protectIds`). */
  kept: string[];
}

/**
 * List materialized releases under `releasesRoot`, NEWEST-first (by
 * `manifest.createdAt`, tie-broken by id descending for determinism).
 *
 * Skips anything that isn't a genuine, currently-valid release: in-progress
 * (`.tmp-*`) and quarantined (`*.failed`) dirs (materializeRelease's own
 * naming — see module header), non-directories, and any dir whose
 * `release.json` is missing or fails to parse. A corrupted/partial release
 * must never crash listing (retention and rollback both depend on this being
 * safe to call unconditionally) — it just becomes invisible to both, the
 * same "skip, don't throw" posture materializeRelease itself uses whenever it
 * discovers a stale on-disk artifact.
 */
export function listReleases(releasesRoot: string = defaultReleasesRoot()): ReleaseListEntry[] {
  if (!existsSync(releasesRoot)) return [];

  let names: string[];
  try {
    names = readdirSync(releasesRoot);
  } catch {
    return [];
  }

  const releases: ReleaseListEntry[] = [];
  for (const name of names) {
    if (name.startsWith('.tmp-') || name.endsWith('.failed')) continue;
    const dir = join(releasesRoot, name);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    const manifestPath = join(dir, 'release.json');
    if (!existsSync(manifestPath)) continue;
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Partial<ReleaseManifest>;
      if (typeof manifest.id !== 'string' || typeof manifest.createdAt !== 'string') continue;
      releases.push({ id: manifest.id, dir, createdAt: manifest.createdAt });
    } catch {
      continue;
    }
  }

  releases.sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt > b.createdAt ? -1 : 1;
    return a.id > b.id ? -1 : 1;
  });
  return releases;
}

/**
 * Prune old releases, keeping the newest `keep` (default 2) PLUS any id
 * listed in `protectIds` — the caller MUST pass the currently-pointed-at
 * release's id there even if it's older than the retention window, so a
 * repoint never leaves current.json pointing at a directory this function
 * just deleted (the exact bug class AC-3 exists to prevent).
 *
 * Deletion is best-effort per directory: a failed `rmSync` is recorded in
 * the returned `pruned` list (annotated with the error) rather than thrown —
 * retention is a soft cleanup step, never something that should abort a
 * reinstall that otherwise succeeded.
 */
export function pruneReleases(
  releasesRoot: string = defaultReleasesRoot(),
  keep = 2,
  protectIds: string[] = [],
): PruneReleasesResult {
  const releases = listReleases(releasesRoot); // newest-first
  const protectSet = new Set(protectIds);
  const kept: string[] = [];
  const toPrune: ReleaseListEntry[] = [];

  releases.forEach((r, i) => {
    if (i < keep || protectSet.has(r.id)) {
      kept.push(r.id);
    } else {
      toPrune.push(r);
    }
  });

  const pruned: string[] = [];
  for (const r of toPrune) {
    try {
      rmSync(r.dir, { recursive: true, force: true });
      pruned.push(r.id);
    } catch (err) {
      pruned.push(`${r.id} (delete failed: ${(err as Error).message})`);
    }
  }

  return { pruned, kept };
}
