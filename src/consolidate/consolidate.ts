/**
 * Consolidation — formation pipeline stage 9 (ADR-004, Wave 4b).
 *
 * Periodic offline pass over accumulated atoms, per (repo, type) group:
 *
 *  - similarity >= mergeThreshold  → auto merge-as-supersede. Non-destructive
 *    by construction (architecture-review W4): the loser is superseded by the
 *    winner via the event log, and the winner's derived_from gains the
 *    loser's id — bitemporal history keeps the original readable forever.
 *  - proposeThreshold <= similarity < mergeThreshold → propose-only row in
 *    consolidation_proposals; the user confirms via REST. Nothing changes
 *    until they do (strategy Pass 6 A4).
 *
 * v1 is deterministic: similarity is cosine over the stored embeddings, no
 * LLM call. The second-order abstraction + contradiction detection passes
 * (ADR-004 stage 9 b/c) are v1.x — they will reuse the same proposal queue.
 *
 * Winner selection: higher usefulness score wins (ADR-010), then higher
 * importance, then the newer atom.
 */

import { randomUUID } from 'node:crypto';
import type { DB } from '../storage/db.js';
import { MemoryEventRepo } from '../storage/memory-events.js';
import { usefulnessScores } from '../storage/usefulness.js';
import { ProposalRepo } from './proposals.js';

export interface ConsolidateOpts {
  /** Cosine similarity at/above which a pair auto-merges. */
  mergeThreshold?: number;
  /** Cosine similarity at/above which a pair becomes a proposal. */
  proposeThreshold?: number;
  /** Groups larger than this are skipped (O(n²) guard) and reported. */
  maxGroupSize?: number;
  /**
   * Auto-merge pairs whose normalized text is equal or a strict subset of
   * the other's, instead of queueing a manual proposal ("Port 7777 is the
   * default" vs "port 7777 is the default."). The containing (superset)
   * text always wins so no active information is lost — the shorter
   * variant survives in bitemporal history like any supersede. Also
   * auto-accepts EXISTING pending proposals whose loser text is contained
   * in the winner's. Default true.
   */
  autoMergeContained?: boolean;
}

export interface ConsolidateSummary {
  groupsScanned: number;
  groupsSkipped: Array<{ repo: string | null; type: string; size: number }>;
  merged: Array<{ winner: string; loser: string; similarity: number; reason?: 'similarity' | 'contained' }>;
  proposed: Array<{ winner: string; loser: string; similarity: number }>;
  /** Pending proposal ids auto-accepted by the containment sweep. */
  autoAcceptedProposals: string[];
  /** Pending proposal ids auto-rejected as stale (an atom no longer valid). */
  staleRejectedProposals: string[];
}

interface AtomRow {
  id: string;
  rowid: number;
  repo: string | null;
  type: string;
  text: string;
  importance: number;
  created_at: number;
  derived_from: string | null;
}

/**
 * Normalization for the containment rule: lowercase, strip backticks/quotes
 * and punctuation, collapse whitespace. Deliberately aggressive — it only
 * gates WHICH near-duplicates skip the manual queue, never what merging does.
 */
export function normalizeForContainment(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`'"“”‘’]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * 'a-contains-b' | 'b-contains-a' | 'equal' | null. Guards trivially short
 * texts (a 3-char normalized string is contained in almost anything).
 */
export function containment(aText: string, bText: string): 'a-contains-b' | 'b-contains-a' | 'equal' | null {
  const a = normalizeForContainment(aText);
  const b = normalizeForContainment(bText);
  const MIN_LEN = 8;
  if (a.length < MIN_LEN || b.length < MIN_LEN) return null;
  if (a === b) return 'equal';
  if (a.includes(b)) return 'a-contains-b';
  if (b.includes(a)) return 'b-contains-a';
  return null;
}

/** Exported for reuse by the memory-health CLI's near-duplicate estimate
 *  (FEAT-444, deep/CLI-only metric) — same cosine-over-stored-embeddings
 *  math this module already uses for merge/propose decisions, no second
 *  implementation. */
export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as number, y = b[i] as number;
    dot += x * y; na += x * x; nb += y * y;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Merge-as-supersede: loser superseded by winner (event log + valid_to +
 * memory_corrected usefulness signal, all via MemoryEventRepo.supersede),
 * plus lineage — winner.derived_from gains the loser id. One transaction.
 */
export function mergeAsSupersede(db: DB, winnerId: string, loserId: string): void {
  const events = new MemoryEventRepo(db);
  const tx = db.transaction(() => {
    events.supersede(loserId, winnerId);
    const row = db.prepare('SELECT derived_from FROM memories WHERE id = ?')
      .get(winnerId) as { derived_from: string | null };
    const lineage = row.derived_from ? (JSON.parse(row.derived_from) as string[]) : [];
    if (!lineage.includes(loserId)) lineage.push(loserId);
    db.prepare('UPDATE memories SET derived_from = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(lineage), Date.now(), winnerId);
  });
  tx();
}

/**
 * Sweep pending proposals:
 *  - loser text contained in (or equal to) the winner's, both atoms still
 *    valid → accept (merge now; no active information is lost).
 *  - loser ALREADY superseded by the winner (e.g. a pair-scan containment
 *    merge or a prior run did the work) → mark accepted, no re-merge.
 *  - either atom no longer valid in any other way → mark rejected: the
 *    proposal is unactionable and would sit as dashboard noise forever.
 * Winner/loser roles in existing rows are NOT flipped; a live
 * winner-contained-in-loser row stays manual (the pair-scan handles it
 * superset-first on the same run).
 */
function sweepContainedProposals(db: DB): { accepted: string[]; staleRejected: string[] } {
  const accepted: string[] = [];
  const staleRejected: string[] = [];
  const rows = db.prepare(`
    SELECT p.id, w.text AS winner_text, l.text AS loser_text,
           w.valid_to AS winner_valid_to, l.valid_to AS loser_valid_to,
           l.superseded_by AS loser_superseded_by, p.winner_id
    FROM consolidation_proposals p
    JOIN memories w ON w.id = p.winner_id
    JOIN memories l ON l.id = p.loser_id
    WHERE p.status = 'pending'
  `).all() as Array<{
    id: string; winner_text: string; loser_text: string;
    winner_valid_to: number | null; loser_valid_to: number | null;
    loser_superseded_by: string | null; winner_id: string;
  }>;

  const repo = new ProposalRepo(db);
  const resolveRow = db.prepare(
    "UPDATE consolidation_proposals SET status = ?, resolved_at = ? WHERE id = ? AND status = 'pending'",
  );

  for (const r of rows) {
    if (r.loser_valid_to !== null || r.winner_valid_to !== null) {
      if (r.loser_superseded_by === r.winner_id) {
        // Work already done (pair-scan merged the same pair) — record it.
        resolveRow.run('accepted', Date.now(), r.id);
        accepted.push(r.id);
      } else {
        resolveRow.run('rejected', Date.now(), r.id);
        staleRejected.push(r.id);
      }
      continue;
    }
    const c = containment(r.winner_text, r.loser_text);
    if (c === 'equal' || c === 'a-contains-b') {
      try {
        repo.accept(r.id);
        accepted.push(r.id);
      } catch {
        // 409-style race (already resolved / memory gone) — leave for manual.
      }
    }
  }
  return { accepted, staleRejected };
}

export function runConsolidation(db: DB, opts: ConsolidateOpts = {}): ConsolidateSummary {
  // 0.92 default (was 0.95): live corpus showed the 0.92–0.95 band is
  // reliably same-fact paraphrases, while 0.90–0.92 still contains
  // distinct facts (e.g. two different env-var names at sim 0.91) —
  // do not lower further without re-auditing pending proposals.
  const mergeThreshold = opts.mergeThreshold ?? 0.92;
  const proposeThreshold = opts.proposeThreshold ?? 0.85;
  const maxGroupSize = opts.maxGroupSize ?? 500;
  const autoMergeContained = opts.autoMergeContained ?? true;

  const summary: ConsolidateSummary = {
    groupsScanned: 0, groupsSkipped: [], merged: [], proposed: [],
    autoAcceptedProposals: [], staleRejectedProposals: [],
  };

  if (autoMergeContained) {
    const swept = sweepContainedProposals(db);
    summary.autoAcceptedProposals = swept.accepted;
    summary.staleRejectedProposals = swept.staleRejected;
  }

  // Valid atoms only, embedded only (no vector row → nothing to compare).
  const atoms = db.prepare(`
    SELECT m.id, m.rowid, m.repo, m.type, m.text, m.importance, m.created_at, m.derived_from
    FROM memories m
    JOIN memories_vec v ON v.rowid = m.rowid
    WHERE m.valid_to IS NULL
    ORDER BY m.repo, m.type, m.created_at
  `).all() as AtomRow[];

  const groups = new Map<string, AtomRow[]>();
  for (const a of atoms) {
    const key = `${a.repo ?? ''} ${a.type}`;
    const g = groups.get(key) ?? [];
    g.push(a);
    groups.set(key, g);
  }

  const getEmbedding = db.prepare('SELECT embedding FROM memories_vec WHERE rowid = ?');
  const usefulness = usefulnessScores(db, atoms.map(a => a.id));
  const invalidatedThisRun = new Set<string>();

  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const first = group[0] as AtomRow;
    if (group.length > maxGroupSize) {
      summary.groupsSkipped.push({ repo: first.repo, type: first.type, size: group.length });
      continue;
    }
    summary.groupsScanned++;

    const vecs = new Map<string, Float32Array>();
    for (const a of group) {
      const row = getEmbedding.get(BigInt(a.rowid)) as { embedding: Buffer } | undefined;
      if (row) {
        vecs.set(a.id, new Float32Array(
          row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4,
        ));
      }
    }

    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i] as AtomRow, b = group[j] as AtomRow;
        if (invalidatedThisRun.has(a.id) || invalidatedThisRun.has(b.id)) continue;
        const va = vecs.get(a.id), vb = vecs.get(b.id);
        if (!va || !vb) continue;
        const sim = cosine(va, vb);
        if (sim < proposeThreshold) continue;

        // Winner: usefulness, then importance, then recency.
        const ua = usefulness.get(a.id) ?? 0.5, ub = usefulness.get(b.id) ?? 0.5;
        let winner = a, loser = b;
        if (ub > ua || (ub === ua && (b.importance > a.importance ||
            (b.importance === a.importance && b.created_at > a.created_at)))) {
          winner = b; loser = a;
        }

        // Containment rule: one text is the other's normalized subset →
        // auto-merge with the SUPERSET as winner (overrides the usefulness
        // pick — keeping the more informative text loses nothing; the
        // subset variant stays readable in bitemporal history).
        if (autoMergeContained) {
          const c = containment(a.text, b.text);
          if (c !== null) {
            if (c === 'a-contains-b') { winner = a; loser = b; }
            else if (c === 'b-contains-a') { winner = b; loser = a; }
            // 'equal' keeps the usefulness-based pick.
            mergeAsSupersede(db, winner.id, loser.id);
            invalidatedThisRun.add(loser.id);
            summary.merged.push({ winner: winner.id, loser: loser.id, similarity: sim, reason: 'contained' });
            continue;
          }
        }

        if (sim >= mergeThreshold) {
          mergeAsSupersede(db, winner.id, loser.id);
          invalidatedThisRun.add(loser.id);
          summary.merged.push({ winner: winner.id, loser: loser.id, similarity: sim });
        } else {
          const inserted = db.prepare(`
            INSERT INTO consolidation_proposals (id, kind, winner_id, loser_id, similarity, status, created_at)
            SELECT ?, 'merge', ?, ?, ?, 'pending', ?
            WHERE NOT EXISTS (
              SELECT 1 FROM consolidation_proposals
              WHERE status = 'pending'
                AND MIN(winner_id, loser_id) = MIN(?, ?)
                AND MAX(winner_id, loser_id) = MAX(?, ?)
            )
          `).run(
            randomUUID(), winner.id, loser.id, sim, Date.now(),
            winner.id, loser.id, winner.id, loser.id,
          );
          if (inserted.changes > 0) {
            summary.proposed.push({ winner: winner.id, loser: loser.id, similarity: sim });
          }
        }
      }
    }
  }

  return summary;
}
