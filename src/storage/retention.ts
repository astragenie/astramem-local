/**
 * Tiered disk-artifact retention (FEAT-493).
 *
 * Boundary (arch-review 2026-07-14): this module owns the DISK-ARTIFACT axis
 * ONLY. It NEVER touches `memories` rows — that axis is
 * `src/storage/archival.ts` (FEAT-404)'s exclusive domain (non-destructive
 * valid_to+archived flag, age + trailing-usefulness policy). Do not entangle
 * the two. Distilled memories and transcripts are never deleted by this
 * module, in ANY mode/tier — see `scopedKinds` below for why 'all' still
 * only ever reaches `<dataDir>/artifacts/<kind>/` files, never a DB row.
 *
 * NOT a DB-backed registry — deliberately. `artifacts` (job_id, kind,
 * content_path, created_at), the day-one table that looked like the obvious
 * home for this, was DROPPED in migrations/040-drop-dead-tables.sql (zero
 * writers ever, confirmed by grep + a live-DB COUNT(*), IRREVERSIBLE — see
 * that migration's own doc comment). Do not resurrect it. Instead this scans
 * a plain directory layout on disk: `<dataDir>/artifacts/<kind>/<file>` —
 * each immediate subdirectory name IS the `kind` bucket. Nothing writes into
 * this directory yet either (no producer exists in this repo today), so a
 * scan against a real install legitimately finds the directory absent and
 * returns zero candidates — expected, not a bug.
 *
 * Deletion (this slice — un-clamped from the #317 scaffolding): `'off'` is a
 * hard no-op (no filesystem access at all). `'dry-run'` scans and reports
 * only — never deletes. `'enabled'` scans, then unlinks every candidate file,
 * one at a time, tolerating a per-file unlink failure without aborting the
 * rest of the pass (same "never block a background pass on one bad path"
 * posture the rest of this pipeline uses — see cleanup.ts's vec-index
 * sweep). `config.ts`'s `applyRetentionGovernance` no longer downgrades
 * `'enabled'` to `'dry-run'` — see that function's doc comment for the
 * removed clamp.
 *
 * `config.retention.heavyArtifact` (size threshold + type list) is
 * deliberately config-driven rather than a hardcoded kind list, precisely so
 * a future producer (L1-1 / audio ingest / FEAT-489, consent-ADR gated, not
 * yet dispatched) can register real kinds (as subdirectory names under
 * `<dataDir>/artifacts/`) and finalize the predicate against its actual
 * output sizes without reworking this module's shape. TBD: pick real
 * `heavyArtifact.types` once that lands — `types` ships empty until then, so
 * every scan legitimately finds zero candidates on a fresh install.
 *
 * Wired onto the cleanup job's cadence (src/pipeline/handlers/cleanup.ts,
 * alongside `runArchivalPass` / `pruneIngestIdempotency`) using
 * `config.retention.tier` as the active dial. Sweep results are persisted to
 * a small JSON stats file (`writeSweepStats`/`readSweepStats` below) — a
 * plain file, not a DB table, for the same "don't resurrect the dropped
 * `artifacts` table" reason the candidate scan itself is filesystem-only.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import type { Config } from '../config/config.js';

export type RetentionMode = Config['retention']['mode'];
export type RetentionTier = 'media' | 'lean' | 'all';

export interface RetentionCandidate {
  kind: string;
  path: string;
  sizeBytes: number;
  mtimeMs: number;
}

export interface RetentionScanResult {
  tier: RetentionTier;
  mode: RetentionMode;
  /** Files that clear age + kind + size — what a dry-run pass reports, and
   * what an 'enabled' pass attempts to delete (see `RetentionSweepResult`
   * for the actual delete outcome: `deleted` may be a subset of this list
   * if any individual unlink failed). */
  candidates: RetentionCandidate[];
  totalBytes: number;
  byKind: Record<string, { count: number; bytes: number }>;
  scannedAt: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Default artifacts root: `<dataDir>/artifacts`. Override via
 * `retention.artifactsDir` (test seam / non-default layouts). */
export function defaultArtifactsDir(dataDir: string): string {
  return join(dataDir, 'artifacts');
}

/**
 * Which kind-subdirectories a tier reclaims. `media` reclaims only its own
 * configured kinds; `lean` reclaims `media`'s kinds PLUS its own extra kinds;
 * `all` reclaims every kind in `heavyArtifact.types` — see this module's doc
 * comment for why `all` does NOT mean "wipe memory rows too" despite the
 * FEAT-493 description's wording.
 */
function scopedKinds(retention: Config['retention'], tier: RetentionTier): Set<string> {
  const { heavyArtifact, tierScope } = retention;
  if (tier === 'all') return new Set(heavyArtifact.types);
  if (tier === 'lean') return new Set([...tierScope.media, ...tierScope.lean]);
  return new Set(tierScope.media);
}

/**
 * Path-containment guard (issue #408, ADR-015 loud-failure invariant).
 * `kind` is sourced from `heavyArtifact.types`/`tierScope.*` — hand-parsed
 * config.yaml scalars with no schema, so nothing upstream stops a `..`-bearing
 * value from reaching `join(root, kind)`. This is deletion code (`'enabled'`
 * mode unlinks every scanned candidate) — a traversal-shaped `kind` must never
 * let the scan (and therefore the delete) escape `<dataDir>/artifacts/` onto
 * arbitrary disk paths. Resolves the joined path and asserts it stays
 * strictly under the resolved artifacts root; refuses + loud-warns (returns
 * `null`, skipping that kind for this pass) rather than silently scanning or
 * deleting outside the sandbox.
 */
function resolveKindDir(root: string, kind: string): string | null {
  const resolvedRoot = resolve(root);
  const target = resolve(root, kind);
  if (!target.startsWith(resolvedRoot + sep)) {
    console.warn(
      `[retention-guard] refusing kind=${JSON.stringify(kind)} — resolves to "${target}", outside the ` +
      `artifacts root "${resolvedRoot}" (path-traversal guard, issue #408). Check retention.heavyArtifact.types ` +
      '/ retention.tierScope config for a `..`-bearing kind value.',
    );
    return null;
  }
  return target;
}

/**
 * Scans `<dataDir>/artifacts/<kind>/` (one directory per scoped kind) for
 * files older than `retention.ageThresholdDays` (by mtime) and at/above
 * `heavyArtifact.minSizeBytes`. Read-only — never deletes anything; this is
 * the shared scan every mode (including `enabled`, once wired) will use.
 *
 * Missing directories (the expected state today — no producer exists yet)
 * and unreadable entries are skipped rather than thrown, matching the "never
 * block a background pass on one bad path" posture the rest of this
 * pipeline uses (see cleanup.ts's vec-index sweep for the same shape).
 */
export function scanRetentionCandidates(
  dataDir: string,
  retention: Config['retention'],
  tier: RetentionTier,
  now: number = Date.now(),
): RetentionScanResult {
  const root = retention.artifactsDir ?? defaultArtifactsDir(dataDir);
  const cutoffMs = now - retention.ageThresholdDays * DAY_MS;
  const kinds = scopedKinds(retention, tier);

  const candidates: RetentionCandidate[] = [];
  const byKind: Record<string, { count: number; bytes: number }> = {};
  let totalBytes = 0;

  for (const kind of kinds) {
    const kindDir = resolveKindDir(root, kind);
    if (!kindDir) continue; // path-traversal guard refused this kind — see resolveKindDir
    if (!existsSync(kindDir)) continue;

    let entries: string[];
    try {
      entries = readdirSync(kindDir);
    } catch {
      continue; // unreadable directory — skip, don't block the rest of the scan
    }

    for (const name of entries) {
      const filePath = join(kindDir, name);
      let stat: ReturnType<typeof statSync>;
      try {
        stat = statSync(filePath);
      } catch {
        continue; // gone between readdir and stat — skip
      }
      if (!stat.isFile()) continue;
      if (stat.mtimeMs >= cutoffMs) continue;
      if (stat.size < retention.heavyArtifact.minSizeBytes) continue;

      candidates.push({ kind, path: filePath, sizeBytes: stat.size, mtimeMs: stat.mtimeMs });
      totalBytes += stat.size;
      const bucket = byKind[kind] ?? { count: 0, bytes: 0 };
      bucket.count += 1;
      bucket.bytes += stat.size;
      byKind[kind] = bucket;
    }
  }

  return { tier, mode: retention.mode, candidates, totalBytes, byKind, scannedAt: now };
}

export interface RetentionSweepResult extends RetentionScanResult {
  /** Candidates actually unlinked this pass. Always empty for `'off'` and
   * `'dry-run'` — only `'enabled'` ever populates this. */
  deleted: RetentionCandidate[];
  /** Sum of `deleted[].sizeBytes` — bytes actually reclaimed, as opposed to
   * `totalBytes` (bytes that WOULD be reclaimed, i.e. the dry-run number). */
  deletedBytes: number;
  /** Per-file unlink failures. Non-fatal — a bad path (permission denied,
   * gone between scan and unlink) never aborts the rest of the pass. */
  errors: Array<{ path: string; message: string }>;
}

/**
 * Retention pass entry point — mirrors `runArchivalPass`'s mode-dispatch
 * shape (src/storage/archival.ts). `'off'` is a hard no-op (matches
 * `runArchivalPass`'s `!config.archival.enabled` short-circuit — no
 * filesystem access at all). `'dry-run'` scans and reports only. `'enabled'`
 * scans, then unlinks every candidate, tolerating per-file failures (see
 * module doc comment).
 */
export function runRetentionPass(
  dataDir: string,
  retention: Config['retention'],
  tier: RetentionTier,
  now: number = Date.now(),
): RetentionSweepResult {
  if (retention.mode === 'off') {
    return { tier, mode: 'off', candidates: [], totalBytes: 0, byKind: {}, scannedAt: now, deleted: [], deletedBytes: 0, errors: [] };
  }

  const scan = scanRetentionCandidates(dataDir, retention, tier, now);

  if (retention.mode === 'dry-run') {
    return { ...scan, deleted: [], deletedBytes: 0, errors: [] };
  }

  // mode === 'enabled' — actually reclaim disk space.
  const deleted: RetentionCandidate[] = [];
  const errors: Array<{ path: string; message: string }> = [];
  let deletedBytes = 0;
  for (const candidate of scan.candidates) {
    try {
      unlinkSync(candidate.path);
      deleted.push(candidate);
      deletedBytes += candidate.sizeBytes;
    } catch (err) {
      errors.push({ path: candidate.path, message: err instanceof Error ? err.message : String(err) });
    }
  }

  return { ...scan, deleted, deletedBytes, errors };
}

// ─── Sweep-result persistence (doctor "last sweep" stat) ───────────────────

export interface RetentionSweepStats {
  tier: RetentionTier;
  mode: RetentionMode;
  scannedAt: number;
  candidateCount: number;
  totalBytes: number;
  deletedCount: number;
  deletedBytes: number;
  byKind: Record<string, { count: number; bytes: number }>;
  errorCount: number;
}

/** Default sweep-stats path: `<dataDir>/retention-last-sweep.json`. A plain
 * JSON file, not a DB table — same rationale as the candidate scan itself
 * (see module doc comment: don't resurrect the dropped `artifacts` table).
 * Override via the `path` param (test seam). */
export function defaultSweepStatsPath(dataDir: string): string {
  return join(dataDir, 'retention-last-sweep.json');
}

/** Best-effort — a stats-persistence failure (e.g. read-only disk) must
 * never fail the cleanup pass that just successfully reclaimed real disk
 * space, so this swallows and does not throw. */
export function writeSweepStats(
  dataDir: string,
  result: RetentionSweepResult,
  path: string = defaultSweepStatsPath(dataDir),
): void {
  const stats: RetentionSweepStats = {
    tier: result.tier,
    mode: result.mode,
    scannedAt: result.scannedAt,
    candidateCount: result.candidates.length,
    totalBytes: result.totalBytes,
    deletedCount: result.deleted.length,
    deletedBytes: result.deletedBytes,
    byKind: result.byKind,
    errorCount: result.errors.length,
  };
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(stats, null, 2));
  } catch {
    // best-effort — see doc comment above.
  }
}

/** Best-effort read of the last persisted sweep. Returns `null` when no
 * sweep has ever run (fresh install / retention still `'off'`) or the file
 * is missing/unreadable/corrupt — never throws. */
export function readSweepStats(
  dataDir: string,
  path: string = defaultSweepStatsPath(dataDir),
): RetentionSweepStats | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf8')) as RetentionSweepStats;
  } catch {
    return null;
  }
}
