/**
 * runTagHygieneBackfill — FEAT-403 core (DB-only, CLI-independent so it's
 * directly unit-testable without spawning the daemon).
 *
 * Candidate selection (`WHERE repo blank OR project blank`) is what makes
 * this idempotent by construction (AC-3): a fully-tagged row is never
 * selected on a re-run, so re-running on a fully-tagged corpus is always a
 * pure no-op scan with zero mutation.
 *
 * Tier-1 (session cwd/project_id) and tier-2 (prompt-assisted, confidence-
 * gated) are applied per-row; tier-2 only runs when tier-1 found nothing at
 * all for that row (never mixes a tier-1 partial fill with a tier-2 guess in
 * the same row — keeps the mis-tag blast radius per row to one tier).
 *
 * Mutations run outside a single wrapping transaction, one UPDATE per
 * applied row: tier-2 calls an LLM per candidate (async), and better-sqlite3
 * transactions must be synchronous. This is also a deliberately resumable
 * shape (durability principle) — if the process is interrupted mid-run, a
 * re-run picks up exactly where it left off via the same WHERE clause.
 */

import type { DB } from '../storage/db.js';
import { deriveRepoFromCwd } from './derive-repo.js';
import { deriveProject } from '../pipeline/derive-project.js';
import type { Tier2InferFn, TagCandidatePair } from './tier2-infer.js';

export interface BackfillOptions {
  dryRun: boolean;
  limit?: number;
  tier2Enabled: boolean;
  /** Minimum tier-2 confidence required to apply an inferred tag (AC-4). */
  confidenceThreshold: number;
}

export interface BackfillCandidate {
  id: string;
  currentRepo: string | null;
  currentProject: string | null;
  proposedRepo: string | null;
  proposedProject: string | null;
  /** null when the memory was left untagged (no signal, or tier-2 confidence too low). */
  tier: 1 | 2 | null;
  /** Only set when tier-2 ran for this row. */
  confidence?: number;
  applied: boolean;
}

export interface BackfillResult {
  scanned: number;
  tier1Applied: number;
  tier2Applied: number;
  leftUntagged: number;
  dryRun: boolean;
  candidates: BackfillCandidate[];
}

interface MemoryRow {
  id: string;
  text: string;
  repo: string | null;
  project: string | null;
  session_id: string | null;
}

interface SessionRow {
  repo: string | null;
  project: string | null;
  cwd: string | null;
}

function isBlank(v: string | null | undefined): boolean {
  return v === null || v === undefined || v.trim() === '';
}

export async function runTagHygieneBackfill(
  db: DB,
  opts: BackfillOptions,
  tier2Infer?: Tier2InferFn,
): Promise<BackfillResult> {
  const limitClause = opts.limit !== undefined ? ` LIMIT ${Math.max(1, opts.limit)}` : '';
  const rows = db.prepare(`
    SELECT id, text, repo, project, session_id FROM memories
    WHERE (repo IS NULL OR TRIM(repo) = '') OR (project IS NULL OR TRIM(project) = '')
    ORDER BY created_at ASC${limitClause}
  `).all() as MemoryRow[];

  const sessionStmt = db.prepare('SELECT repo, project, cwd FROM sessions WHERE id = ?');
  const updateStmt = db.prepare('UPDATE memories SET repo = ?, project = ?, updated_at = ? WHERE id = ?');

  // Known (repo, project) vocabulary from the already-tagged corpus — grounds
  // tier-2 inference so it can only choose among names actually seen
  // elsewhere, never invent one (see tier2-infer.ts). Queried once per run.
  const knownPairs: TagCandidatePair[] = opts.tier2Enabled && tier2Infer
    ? (db.prepare(`
        SELECT DISTINCT repo, project FROM memories
        WHERE repo IS NOT NULL AND TRIM(repo) != '' AND project IS NOT NULL AND TRIM(project) != ''
      `).all() as TagCandidatePair[])
    : [];

  const candidates: BackfillCandidate[] = [];
  let tier1Applied = 0;
  let tier2Applied = 0;
  let leftUntagged = 0;

  for (const row of rows) {
    let proposedRepo = isBlank(row.repo) ? null : row.repo;
    let proposedProject = isBlank(row.project) ? null : row.project;
    let tier: 1 | 2 | null = null;
    let confidence: number | undefined;

    // ---- Tier 1: session metadata (repo, or project_id, or cwd) ----
    if (row.session_id) {
      const session = sessionStmt.get(row.session_id) as SessionRow | undefined;
      if (session) {
        const sessionRepo = session.repo ?? deriveRepoFromCwd(session.cwd);
        // FEAT-423: fall back to cwd-basename/repo when the session carries
        // no explicit project (mirrors the write-side derivation applied at
        // ingest time in src/pipeline/handlers/distill*.ts).
        const sessionProject = session.project ?? deriveProject(session.cwd, sessionRepo);
        let changed = false;
        if (isBlank(proposedRepo) && !isBlank(sessionRepo)) { proposedRepo = sessionRepo; changed = true; }
        if (isBlank(proposedProject) && !isBlank(sessionProject)) { proposedProject = sessionProject; changed = true; }
        if (changed) tier = 1;
      }
    }

    // ---- Tier 2: prompt-assisted inference — only when tier-1 found nothing ----
    if (tier === null && opts.tier2Enabled && tier2Infer && (isBlank(proposedRepo) || isBlank(proposedProject))) {
      const inferred = await tier2Infer(row.text, knownPairs);
      confidence = inferred.confidence;
      if (inferred.confidence >= opts.confidenceThreshold) {
        if (isBlank(proposedRepo) && !isBlank(inferred.repo)) proposedRepo = inferred.repo;
        if (isBlank(proposedProject) && !isBlank(inferred.project)) proposedProject = inferred.project;
        if (!isBlank(proposedRepo) || !isBlank(proposedProject)) tier = 2;
      }
    }

    const willApply = tier !== null && (proposedRepo !== row.repo || proposedProject !== row.project);

    if (willApply) {
      if (!opts.dryRun) {
        updateStmt.run(proposedRepo, proposedProject, Date.now(), row.id);
      }
      if (tier === 1) tier1Applied++;
      else if (tier === 2) tier2Applied++;
    } else {
      leftUntagged++;
    }

    candidates.push({
      id: row.id,
      currentRepo: row.repo,
      currentProject: row.project,
      proposedRepo,
      proposedProject,
      tier: willApply ? tier : null,
      confidence,
      applied: willApply && !opts.dryRun,
    });
  }

  return {
    scanned: rows.length,
    tier1Applied,
    tier2Applied,
    leftUntagged,
    dryRun: opts.dryRun,
    candidates,
  };
}
