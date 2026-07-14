/**
 * Tiered disk-artifact retention — scaffolding (FEAT-493).
 *
 * Boundary (arch-review 2026-07-14): this module owns the DISK-ARTIFACT axis
 * ONLY. It NEVER touches `memories` rows — that axis is
 * `src/storage/archival.ts` (FEAT-404)'s exclusive domain (non-destructive
 * valid_to+archived flag, age + trailing-usefulness policy). Do not entangle
 * the two.
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
 * Scaffolding scope (this slice): mode enum + dry-run reporting only.
 * `runRetentionPass` never deletes a file — `'dry-run'` and `'enabled'` both
 * just scan and report (config.ts's `applyRetentionGovernance` additionally
 * downgrades `'enabled'` to `'dry-run'` at load time, loudly, until a
 * follow-up slice wires real deletion behind it). "Reports what WOULD be
 * reclaimed, purges nothing" is the whole deliverable here.
 *
 * `config.retention.heavyArtifact` (size threshold + type list) is
 * deliberately config-driven rather than a hardcoded kind list, precisely so
 * a future producer (L1-1 / audio ingest / FEAT-489, consent-ADR gated, not
 * yet dispatched) can register real kinds (as subdirectory names under
 * `<dataDir>/artifacts/`) and finalize the predicate against its actual
 * output sizes without reworking this scaffolding's shape. TBD: pick real
 * `heavyArtifact.types` once that lands.
 *
 * This module is NOT yet wired onto the cleanup job's cadence
 * (src/pipeline/handlers/cleanup.ts, the way `runArchivalPass` and
 * `pruneIngestIdempotency` are) — that wiring, plus real deletion, is
 * explicitly out of scope for this scaffolding slice.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
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
   * what an 'enabled' pass would delete once that path is wired. */
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
    const kindDir = join(root, kind);
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

/**
 * Retention pass entry point — mirrors `runArchivalPass`'s mode-dispatch
 * shape (src/storage/archival.ts). `'off'` is a hard no-op (matches
 * `runArchivalPass`'s `!config.archival.enabled` short-circuit — no
 * filesystem access at all). `'dry-run'` and `'enabled'` both currently
 * scan-and-report only; NEITHER deletes a file in this slice (see module doc
 * comment) — kept as one dispatch point so the follow-up that adds real
 * deletion only has to touch this one function.
 */
export function runRetentionPass(
  dataDir: string,
  retention: Config['retention'],
  tier: RetentionTier,
  now: number = Date.now(),
): RetentionScanResult {
  if (retention.mode === 'off') {
    return { tier, mode: 'off', candidates: [], totalBytes: 0, byKind: {}, scannedAt: now };
  }
  return scanRetentionCandidates(dataDir, retention, tier, now);
}
