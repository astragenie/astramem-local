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
 *     migrations/      (copied — serve boot's migrate() reads these at release root)
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
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
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
  /** `${pkgversion}+${gitsha}` — also the final directory's basename. NOT a
   *  reliable content identity on its own: `gitsha` is only as fresh as the
   *  last commit, so an uncommitted change (a bumped SCHEMA_VERSION, a new
   *  migration file, ...) leaves `id` unchanged even though the build output
   *  has changed. `contentHash` below is the actual identity check — see
   *  computeContentHash. */
  id: string;
  pkgversion: string;
  gitsha: string;
  /** ISO-8601 timestamp of materialization. */
  createdAt: string;
  /** `process.version` of the machine that ran materialization. */
  nodeVersion: string;
  /** sha256 over dist/ + migrations/ + package.json + the lockfile (see
   *  computeContentHash). This — not `id` — is what materializeRelease's
   *  reuse-vs-rebuild decision below trusts: two materializations can share
   *  an `id` (same pkgversion+gitsha) while genuinely differing in content
   *  whenever the checkout was dirty at build time (the 2026-07-13
   *  stale-release-dir incident: an uncommitted migration + SCHEMA_VERSION
   *  bump kept shipping the old build because the id never moved). Optional
   *  on read because release.json files materialized before this field
   *  existed won't have it — see the reuse check, which treats a missing
   *  hash as "cannot prove this is safe to reuse" rather than trusting it. */
  contentHash?: string;
}

export interface MaterializeReleaseResult {
  releaseDir: string;
  manifest: ReleaseManifest;
  /** How `releaseDir` was produced:
   *  - 'fresh'   — no release with this id existed yet.
   *  - 'reused'  — a release with this id already existed, its entry
   *                boot-verified correctly, AND its contentHash matched the
   *                just-built tmp dir's — genuinely the same build, safe to
   *                reuse without rewriting anything.
   *  - 'rebuilt' — a release with this id already existed but was rejected
   *                (failed boot-verify, i.e. corruption; OR its contentHash
   *                didn't match — same id, different content, e.g. an
   *                uncommitted change). The fresh, already boot-verified tmp
   *                build was promoted in its place. See `rebuiltReason`. */
  outcome: 'fresh' | 'reused' | 'rebuilt';
  /** Populated only when outcome === 'rebuilt' — the evidence that made the
   *  existing dir untrustworthy. Callers (reinstall.ts) MUST surface this to
   *  the operator: a same-id rebuild is exactly the kind of event that used
   *  to be invisible (FEAT-486). */
  rebuiltReason?: string;
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

/** `git rev-parse`/`git config` are near-instant; a generous bound that
 *  still fails observably rather than hanging `reinstall` forever. */
const GIT_TIMEOUT_MS = 15_000;
/** `bun install --frozen-lockfile` legitimately runs for a while on a cold
 *  cache/network — this is I/O-bound, not the PowerShell cold-start class,
 *  so it gets minutes, not seconds. Still bounded: an unbounded spawnSync
 *  would hang `reinstall` forever with zero signal on a wedged registry. */
const BUN_INSTALL_TIMEOUT_MS = 5 * 60_000;
/** Boot-verify (`node dist/cli/index.js --version`) exits before migrate()
 *  — should be near-instant; matches the repo's other cold-start bound. */
const BOOT_VERIFY_TIMEOUT_MS = 15_000;
/** Probe (`<bun> --version`) to confirm a candidate bun path actually RUNS —
 *  catches the issue #305 case where `bun` on PATH is an npm shim (a bash
 *  script, not a native exe) that Node's spawnSync cannot execute (ENOENT). */
const BUN_PROBE_TIMEOUT_MS = 10_000;

/**
 * `--version` reports `"<version> (<entry-path>)"` since issue #308 (the
 * path suffix helps a human spot a PATH-shadowed stale install) — but a
 * fixture entry script or an older release's dist/ may still report the
 * bare version. Accept either: exact match, or version-followed-by-space
 * (the real CLI's shape). Never a bare `startsWith` on its own, which
 * would wrongly accept "1.2.30" as a match for expected "1.2.3".
 */
function versionMatches(reported: string, expected: string): boolean {
  return reported === expected || reported.startsWith(`${expected} `);
}

/** The install command materializeRelease should use, resolved at call time. */
interface InstallCommand {
  cmd: string;
  args: string[];
  /** npm on win32 is `npm.cmd` — spawnSync needs shell:true to resolve it. A
   *  resolved absolute bun path needs no shell. */
  shell: boolean;
  kind: 'bun' | 'npm';
}

/**
 * Confirm a candidate `bun` executable actually runs (`--version` exits 0).
 * Node's spawnSync CANNOT execute a non-native shim (the issue #305 ENOENT),
 * so a bare existsSync isn't enough — we probe. Returns the path if runnable.
 */
function bunRuns(bunPath: string): boolean {
  try {
    const res = spawnSync(bunPath, ['--version'], { encoding: 'utf8', timeout: BUN_PROBE_TIMEOUT_MS });
    return res.status === 0 && !res.error;
  } catch {
    return false;
  }
}

/**
 * Resolve the package-manager command for materializeRelease's production
 * install (issue #305). Prefers a RUNNABLE bun so `--frozen-lockfile` gives a
 * deterministic install off the copied `bun.lock`; falls back to
 * `npm install --omit=dev` when no bun on this box actually executes (a
 * common Windows state: `bun` on PATH is only an npm shim, or `~/.bun/bin`
 * isn't on the service's inherited PATH). Candidate order: `$BUN_INSTALL/bin`,
 * `~/.bun/bin`, then bare `bun` (PATH). npm has no frozen-lock equivalent here
 * (we copy bun.lock, not package-lock.json), so the fallback does a fresh
 * production resolve from package.json — noted at the call site.
 */
export function resolveInstallCommand(): InstallCommand {
  const exe = process.platform === 'win32' ? 'bun.exe' : 'bun';
  const candidates: string[] = [];
  if (process.env.BUN_INSTALL) candidates.push(join(process.env.BUN_INSTALL, 'bin', exe));
  candidates.push(join(homedir(), '.bun', 'bin', exe));

  for (const c of candidates) {
    if (existsSync(c) && bunRuns(c)) {
      return { cmd: c, args: ['install', '--production', '--frozen-lockfile'], shell: false, kind: 'bun' };
    }
  }
  // Bare `bun` on PATH — spawnSync resolves it; probe confirms it isn't a shim.
  if (bunRuns('bun')) {
    return { cmd: 'bun', args: ['install', '--production', '--frozen-lockfile'], shell: false, kind: 'bun' };
  }
  // No runnable bun anywhere — fall back to npm (shell:true so win32 resolves npm.cmd).
  return { cmd: 'npm', args: ['install', '--omit=dev'], shell: true, kind: 'npm' };
}

function runCaptured(cmd: string, args: string[], cwd: string, timeoutMs = GIT_TIMEOUT_MS, shell = false): CapturedRun {
  const res = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: timeoutMs, shell });
  const stderrParts = [res.stderr ?? ''];
  if (res.error) stderrParts.push(res.error.message);
  // Empirically verified on this runtime (Node on this box): spawnSync's
  // own timeout kill sets BOTH `res.error` (message contains 'ETIMEDOUT')
  // AND `res.signal` ('SIGTERM') together — never signal alone. An earlier
  // version of this branch checked `res.signal && !res.error`, which can
  // never fire on this runtime and was dead code (caught in review). The
  // raw `res.error.message` already says "...ETIMEDOUT", but it doesn't
  // name which of this file's several timeoutMs values was in effect —
  // this note adds that, matching git-hooks-activate.ts's `error && signal`
  // condition for the same shape.
  if (res.error && res.signal) {
    stderrParts.push(`[runCaptured] process received signal ${res.signal} (likely killed by the ${timeoutMs}ms timeout)`);
  }
  return {
    status: res.status ?? 1,
    stdout: res.stdout ?? '',
    stderr: stderrParts.filter(Boolean).join('\n'),
  };
}

/** Best-effort; tolerates a missing/non-git checkout so materialization
 *  still works (labeled 'nogit') rather than hard-failing. `res.error`
 *  (spawn failure, including a timeout) is logged distinctly from a clean
 *  non-git directory (non-zero exit, no res.error) — both currently fall
 *  back to 'nogit' for the release id (the content hash, not the sha, is
 *  materializeRelease's actual reuse-safety gate — see its own comment),
 *  but a timeout/missing-git-binary should not be silently indistinguishable
 *  from "this just isn't a git checkout" to anyone reading logs. */
function resolveGitSha(checkoutDir: string): string {
  const res = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: checkoutDir, encoding: 'utf8', timeout: GIT_TIMEOUT_MS });
  if (res.status === 0) {
    const sha = (res.stdout ?? '').trim();
    if (sha) return sha;
  }
  if (res.error) {
    console.warn(`[astramem-local] resolveGitSha: 'git rev-parse' did not complete cleanly (${res.error.message}) — labeling release 'nogit'`);
  }
  return 'nogit';
}

/**
 * Deterministic sha256 over the files that actually determine a release's
 * behavior: `dist/` + `migrations/` (recursively) + `package.json` + the
 * lockfile, all relative to `dir`. Deliberately excludes `node_modules/` —
 * it's derived from package.json + the lockfile via
 * `bun install --frozen-lockfile`, so hashing it too would be redundant and
 * far slower for no extra signal.
 *
 * This is the actual identity check materializeRelease's reuse decision
 * relies on. `id` (`${pkgversion}+${gitsha}`) is a human-readable label, not
 * a content identity: `pkgversion` only moves at release commits and
 * `gitsha` only moves at commits, so a checkout with uncommitted changes
 * (source edits, a new migration file, a SCHEMA_VERSION bump) computes the
 * exact same `id` as it did before those changes — the 2026-07-13 incident.
 * Hashing the files that ship is what tells the two builds apart even when
 * their id collides.
 */
function computeContentHash(dir: string, lockfileName: string): string {
  const hash = createHash('sha256');
  const files: string[] = [];

  function walk(relDir: string): void {
    const abs = join(dir, relDir);
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(rel);
      else if (entry.isFile()) files.push(rel);
    }
  }

  for (const top of ['dist', 'migrations']) {
    if (existsSync(join(dir, top))) walk(top);
  }
  files.push('package.json');
  if (existsSync(join(dir, lockfileName))) files.push(lockfileName);

  files.sort();
  for (const rel of files) {
    hash.update(rel);
    hash.update('\0');
    hash.update(readFileSync(join(dir, rel)));
    hash.update('\0');
  }
  return hash.digest('hex');
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
  const migrationsSrc = join(checkoutDir, 'migrations');

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
  // migrations/ MUST ship in the release: serve boot runs migrate()
  // (src/storage/migrate.ts resolves <releaseRoot>/migrations), which
  // readdirSync's this dir and crashes the daemon on boot if it is absent.
  // The `--version` boot-verify below exits before migrate() runs, so it
  // cannot catch this — hence the explicit pre-flight guard + copy.
  if (!existsSync(migrationsSrc)) {
    throw new Error(`materializeRelease: migrations/ not found at ${migrationsSrc} — serve boot's migrate() would crash without it`);
  }

  mkdirSync(releasesRoot, { recursive: true });
  const tmpDir = join(releasesRoot, `.tmp-${randomUUID()}`);

  try {
    mkdirSync(tmpDir, { recursive: true });
    cpSync(distSrc, join(tmpDir, 'dist'), { recursive: true });
    cpSync(migrationsSrc, join(tmpDir, 'migrations'), { recursive: true });
    copyFileSync(pkgSrc, join(tmpDir, 'package.json'));
    copyFileSync(lockSrc, join(tmpDir, lockfileName));

    // Issue #305: resolve a RUNNABLE package manager rather than blindly
    // shelling out to `bun` — on Windows `bun` on PATH is frequently an npm
    // shim (not a native exe) that spawnSync cannot execute → ENOENT → reinstall
    // never touches the service. Prefer a verified bun (deterministic
    // --frozen-lockfile off the copied bun.lock); fall back to npm.
    const pm = resolveInstallCommand();
    if (pm.kind === 'npm') {
      // eslint-disable-next-line no-console
      console.warn(
        `materializeRelease: no runnable bun found (checked $BUN_INSTALL, ~/.bun/bin, PATH) — ` +
          `falling back to 'npm install --omit=dev'. This does a fresh production resolve from ` +
          `package.json rather than a frozen install off bun.lock.`,
      );
    }
    const install = runCaptured(pm.cmd, pm.args, tmpDir, BUN_INSTALL_TIMEOUT_MS, pm.shell);
    if (install.status !== 0) {
      throw new Error(
        `materializeRelease: '${pm.kind === 'bun' ? 'bun install --production --frozen-lockfile' : 'npm install --omit=dev'}' ` +
          `failed (exit ${install.status}) in ${tmpDir}\n` +
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
    // Computed from the files already copied into tmpDir (dist/migrations/
    // package.json/lockfile) — independent of id, and the actual signal the
    // reuse-vs-rebuild decision below trusts. See computeContentHash header.
    const contentHash = computeContentHash(tmpDir, lockfileName);
    const manifest: ReleaseManifest = {
      id: `${pkgversion}+${gitsha}`,
      pkgversion,
      gitsha,
      createdAt: new Date().toISOString(),
      nodeVersion: process.version,
      contentHash,
    };
    writeFileSync(join(tmpDir, 'release.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');

    // Boot-verify: MUST run with cwd outside the checkout, proving the
    // release dir resolves its own node_modules (incl. native modules) by
    // absolute path rather than falling back to anything checkout-relative.
    // `--version` exits before migrate()/DB open (src/storage/migrate.ts) —
    // see module header — so a schema-ahead live DB can't produce a false
    // failure here.
    const entryJs = join(tmpDir, 'dist', 'cli', 'index.js');
    const verify = runCaptured(nodeBin, [entryJs, '--version'], releasesRoot, BOOT_VERIFY_TIMEOUT_MS);
    const reported = verify.stdout.trim();
    if (verify.status !== 0 || !versionMatches(reported, pkgversion)) {
      throw new Error(
        `materializeRelease: boot-verify failed for ${manifest.id} (exit ${verify.status}, reported "${reported}", expected "${pkgversion}")\n` +
          `--- stdout ---\n${verify.stdout}\n--- stderr ---\n${verify.stderr}`,
      );
    }

    const finalDir = join(releasesRoot, manifest.id);
    if (existsSync(finalDir)) {
      // Idempotent-reuse path (SLICE-417 AC-3 / SLICE-416 review MEDIUM,
      // hardened FEAT-486 after the 2026-07-13 incident). A dir already
      // exists at this id — but id (`${pkgversion}+${gitsha}`) is NOT proof
      // the two builds are the same: an uncommitted change (source edit, a
      // new migration file, a SCHEMA_VERSION bump) moves neither pkgversion
      // nor gitsha, so `reinstall` after such a change used to silently
      // discard the fresh, correct tmp build we just made and re-serve the
      // stale existing dir instead — while reporting success. Two
      // independent gates must both pass before we trust the existing dir:
      //   1. boot-verify (as before) — catches corruption/partial deletion.
      //   2. contentHash match — catches "id collided but content didn't",
      //      the actual shape of the incident. A missing contentHash (a
      //      release materialized before this field existed) counts as a
      //      gate failure, not a pass: we cannot prove it's safe, so we
      //      rebuild rather than assume.
      const existingEntryJs = join(finalDir, 'dist', 'cli', 'index.js');
      const reverify = existsSync(existingEntryJs)
        ? runCaptured(nodeBin, [existingEntryJs, '--version'], releasesRoot, BOOT_VERIFY_TIMEOUT_MS)
        : { status: 1, stdout: '', stderr: `entry missing: ${existingEntryJs}` };
      const reverifyReported = reverify.stdout.trim();
      const bootOk = reverify.status === 0 && versionMatches(reverifyReported, pkgversion);

      let existing: ReleaseManifest | null = null;
      try {
        existing = JSON.parse(readFileSync(join(finalDir, 'release.json'), 'utf8')) as ReleaseManifest;
      } catch {
        existing = null;
      }
      const contentMatches = bootOk && existing != null && existing.contentHash === contentHash;

      if (contentMatches) {
        // Existing dir re-verified healthy AND genuinely identical content —
        // discard the redundant (but already boot-verified) tmp build and
        // hand back the existing manifest rather than double-writing.
        rmSync(tmpDir, { recursive: true, force: true });
        return { releaseDir: finalDir, manifest: existing!, outcome: 'reused' };
      }

      // Existing dir is untrustworthy — either boot-verify failed
      // (corruption) or its content doesn't match what we'd build right now
      // despite the unchanged id (stale reuse — the incident class this
      // exists to close). Self-heal by promoting the fresh, already-verified
      // tmp build in its place. LOUD by construction: the caller gets
      // outcome:'rebuilt' + rebuiltReason and MUST surface it (reinstall.ts
      // logs it in the materialize-release step detail).
      const rebuiltReason = !bootOk
        ? `existing release dir failed boot-verify (exit ${reverify.status}, reported "${reverifyReported}", expected "${pkgversion}") — likely corrupted or partially deleted`
        : `existing release dir's contentHash (${existing?.contentHash ?? '<none recorded>'}) does not match the freshly built contentHash (${contentHash}) despite sharing id ${manifest.id} — the checkout had uncommitted changes when this id was last materialized (2026-07-13 stale-release-dir incident class)`;
      rmSync(finalDir, { recursive: true, force: true });
      renameSync(tmpDir, finalDir);
      return { releaseDir: finalDir, manifest, outcome: 'rebuilt', rebuiltReason };
    }

    renameSync(tmpDir, finalDir);
    return { releaseDir: finalDir, manifest, outcome: 'fresh' };
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
