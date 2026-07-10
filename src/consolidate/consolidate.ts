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
 *    until they do (strategy Pass 6 A4) — UNLESS `autoAcceptThreshold`
 *    (FEAT-442, `consolidation.autoAcceptThreshold` config, default null =
 *    OFF) is set and similarity clears that bar too, in which case the
 *    proposal is created then immediately accepted via the same code path a
 *    human accept uses, with an `auto_accepted` provenance marker on the
 *    resulting supersede event. Reversible via
 *    `MemoryEventRepo.unsupersede()` / `POST /memory/:id/unsupersede` — see
 *    that method's doc comment for exact semantics (un-hides the loser; the
 *    winner is untouched).
 *
 * v1 is deterministic: similarity is cosine over the stored embeddings, no
 * LLM call for merge/propose decisions. The second-order abstraction pass
 * (ADR-004 stage 9b) is still v1.x. Contradiction detection (stage 9c) is
 * FEAT-456 SLICE-1: an opt-in (default off) judge call inserted ahead of
 * the propose-tier guard below — see the "FEAT-456" comments in this file
 * and `src/consolidate/contradiction-judge.ts`. Propose-only like the rest
 * of this module: a confident 'contradicts' verdict writes a
 * `kind='contradiction'` proposal row, never an auto-action.
 *
 * Winner selection: higher usefulness score wins (ADR-010), then higher
 * importance, then the newer atom. (Contradiction proposals use a
 * different rule — newer atom always wins — see `runConsolidation`'s
 * FEAT-456 branch.)
 */

import { randomUUID } from 'node:crypto';
import type { DB } from '../storage/db.js';
import type { Config } from '../config/config.js';
import type { LLMProvider } from '../contracts/llm.js';
import { MemoryEventRepo, type SupersedeProvenance } from '../storage/memory-events.js';
import { usefulnessScores } from '../storage/usefulness.js';
import { ProposalRepo } from './proposals.js';
import { judgeContradiction, type JudgeVerdict } from './contradiction-judge.js';

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
  /**
   * FEAT-442 autonomous consolidation: cosine similarity at/above which a
   * propose-tier pair (proposeThreshold <= similarity < mergeThreshold) is
   * accepted immediately — via the exact same path a human accept uses
   * (ProposalRepo.accept, i.e. proposal row created THEN resolved, so the
   * audit trail is identical to a manual accept plus a provenance marker)
   * — instead of sitting in the manual queue. Reversible via
   * `MemoryEventRepo.unsupersede()`.
   *
   * Must satisfy `proposeThreshold <= autoAcceptThreshold <= 1`; an
   * out-of-range value disables auto-accept for THIS run only (logged via
   * `log`, never fatal — matches this config layer's "never block a run on
   * a bad value" pattern, e.g. `applyFusionGovernance`).
   *
   * Default `null`/`undefined` = OFF. With no value set, behavior is
   * byte-identical to pre-FEAT-442 propose/accept: every propose-tier pair
   * becomes (and stays) a pending `consolidation_proposals` row until a
   * human resolves it.
   */
  autoAcceptThreshold?: number | null;
  /**
   * FEAT-456 SLICE-1: contradiction-detection config for this run. Mirrors
   * `Config['consolidation']['contradictionDetection']` exactly (the job
   * handler and REST route forward the running config's value verbatim).
   * Omitted, or `mode: 'off'` (the default), is BYTE-IDENTICAL to
   * pre-FEAT-456 output — the judge is never called.
   */
  contradictionDetection?: Config['consolidation']['contradictionDetection'];
  /**
   * LLMProvider for the contradiction judge — reuses
   * `ProviderSet.llm.extraction` (design §1.3, no new provider role).
   * Required only when `contradictionDetection.mode !== 'off'`; a missing
   * provider with mode on disables judging for THIS run only (logged,
   * non-fatal — matches this file's "never block a run on a bad/missing
   * capability" governance pattern, see `resolveAutoAcceptThreshold`).
   */
  judgeProvider?: LLMProvider;
  /** Injectable logger seam for tests; defaults to `console.warn`. */
  log?: (message: string) => void;
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
  /**
   * FEAT-442: propose-tier pairs accepted immediately this run because
   * their similarity met `autoAcceptThreshold` — distinct from `merged`
   * (mergeThreshold/containment auto-merges, which never create a proposal
   * row at all) and from `proposed` (still pending). Each entry's
   * `proposalId` is the now-`accepted` `consolidation_proposals` row —
   * findable via `GET /consolidation/proposals?status=accepted` — and
   * reversible via `POST /memory/:id/unsupersede` on `loser`.
   */
  autoAccepted: Array<{ winner: string; loser: string; similarity: number; proposalId: string }>;
  /**
   * FEAT-456 `mode: 'dry-run'`: judge-eligible pairs the judge labeled
   * 'contradicts' at >= `minConfidence`, previewed but NOT written — the
   * safe-rollout mode. Always `[]` when `mode !== 'dry-run'`.
   */
  contradictionsPreviewed: Array<{ winner: string; loser: string; similarity: number; verdict: JudgeVerdict }>;
  /**
   * FEAT-456 `mode: 'enabled'`: `kind='contradiction'` proposals actually
   * inserted this run. `winner` = the newer atom (`created_at` max),
   * `loser` = the older atom — directional, opposite of the merge tier's
   * usefulness-based pick (§2.2: the new atom is the presumptive
   * correction). Always `[]` when `mode !== 'enabled'`.
   */
  contradictionsProposed: Array<{ winner: string; loser: string; similarity: number; proposalId: string }>;
  /**
   * True when `maxPerRun` judge calls were exhausted before the scan
   * finished — lets a report distinguish "no contradictions found" from
   * "ran out of budget before finishing" (§1.5). Remaining judge-eligible
   * pairs fall through to the existing merge-tier classification unchanged.
   */
  contradictionCapReached: boolean;
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
 *
 * `provenance` (FEAT-442) is forwarded to `MemoryEventRepo.supersede()`
 * untouched — see that method and {@link SupersedeProvenance}. Omitted by
 * every pre-existing caller (containment auto-merge, human
 * `ProposalRepo.accept`), so their payload shape is unchanged.
 */
export function mergeAsSupersede(
  db: DB, winnerId: string, loserId: string, provenance?: SupersedeProvenance,
): void {
  const events = new MemoryEventRepo(db);
  const tx = db.transaction(() => {
    events.supersede(loserId, winnerId, provenance);
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

/**
 * FEAT-442: resolve+validate the configured autoAcceptThreshold against the
 * proposeThreshold in effect for THIS run. Never fatal — an out-of-range
 * value disables auto-accept for the run (logged) rather than throwing, so
 * a bad config value can't block a scheduled consolidation pass.
 */
function resolveAutoAcceptThreshold(
  raw: number | null | undefined,
  proposeThreshold: number,
  log: (message: string) => void,
): number | null {
  if (raw === null || raw === undefined) return null;
  if (raw < proposeThreshold || raw > 1) {
    log(
      `[consolidate] autoAcceptThreshold=${raw} is invalid (must be >= proposeThreshold=` +
      `${proposeThreshold} and <= 1) — auto-accept disabled for this run.`,
    );
    return null;
  }
  return raw;
}

interface ResolvedContradictionDetection {
  mode: 'dry-run' | 'enabled';
  minSimilarity: number;
  minConfidence: number;
  maxPerRun: number;
  judgeProvider: LLMProvider;
}

/**
 * FEAT-456: resolve+validate `contradictionDetection` against the
 * `mergeThreshold` in effect for THIS run, mirroring
 * `resolveAutoAcceptThreshold`'s "never fatal, disable for this run and
 * log" shape exactly (§1.5). Returns `null` (contradiction detection off
 * for this run) when: mode is `'off'`/unset, `minSimilarity` is out of
 * `[0, mergeThreshold)`, `minConfidence` is out of `[0, 1]`, or no
 * `judgeProvider` was supplied despite mode being on.
 */
function resolveContradictionDetection(
  raw: ConsolidateOpts['contradictionDetection'],
  judgeProvider: LLMProvider | undefined,
  mergeThreshold: number,
  log: (message: string) => void,
): ResolvedContradictionDetection | null {
  if (!raw || raw.mode === 'off') return null;
  if (raw.minSimilarity < 0 || raw.minSimilarity >= mergeThreshold) {
    log(
      `[consolidate] contradictionDetection.minSimilarity=${raw.minSimilarity} is invalid (must be in ` +
      `[0, mergeThreshold=${mergeThreshold})) — contradiction detection disabled for this run.`,
    );
    return null;
  }
  if (raw.minConfidence < 0 || raw.minConfidence > 1) {
    log(
      `[consolidate] contradictionDetection.minConfidence=${raw.minConfidence} is invalid (must be in ` +
      '[0, 1]) — contradiction detection disabled for this run.',
    );
    return null;
  }
  if (!judgeProvider) {
    log(
      `[consolidate] contradictionDetection.mode=${JSON.stringify(raw.mode)} but no judgeProvider was ` +
      'supplied — contradiction detection disabled for this run.',
    );
    return null;
  }
  return {
    mode: raw.mode, minSimilarity: raw.minSimilarity, minConfidence: raw.minConfidence,
    maxPerRun: raw.maxPerRun, judgeProvider,
  };
}

const EXCERPT_MAX_CHARS = 280;

function excerpt(text: string): string {
  return text.length > EXCERPT_MAX_CHARS ? `${text.slice(0, EXCERPT_MAX_CHARS)}...` : text;
}

/**
 * FEAT-456: insert a `kind='contradiction'` proposal row. Reuses the exact
 * `INSERT ... SELECT ... WHERE NOT EXISTS (...)` dedup guard the merge
 * insert uses (§2.3) — `idx_consolidation_pair_pending` has no `kind`
 * predicate, so this is a no-op (returns null) when a pending proposal of
 * EITHER kind already exists for the unordered pair. Excerpts are captured
 * here, at judge time, not re-derived at read time (§2.1).
 */
function insertContradictionProposal(
  db: DB, winnerId: string, loserId: string, winnerText: string, loserText: string,
  similarity: number, verdict: JudgeVerdict,
): string | null {
  const proposalId = randomUUID();
  const metadata = {
    verdict: 'contradicts' as const,
    confidence: verdict.confidence,
    winner_excerpt: excerpt(winnerText),
    loser_excerpt: excerpt(loserText),
  };
  const inserted = db.prepare(`
    INSERT INTO consolidation_proposals (id, kind, winner_id, loser_id, similarity, status, created_at, metadata_json)
    SELECT ?, 'contradiction', ?, ?, ?, 'pending', ?, ?
    WHERE NOT EXISTS (
      SELECT 1 FROM consolidation_proposals
      WHERE status = 'pending'
        AND MIN(winner_id, loser_id) = MIN(?, ?)
        AND MAX(winner_id, loser_id) = MAX(?, ?)
    )
  `).run(
    proposalId, winnerId, loserId, similarity, Date.now(), JSON.stringify(metadata),
    winnerId, loserId, winnerId, loserId,
  );
  return inserted.changes > 0 ? proposalId : null;
}

export async function runConsolidation(db: DB, opts: ConsolidateOpts = {}): Promise<ConsolidateSummary> {
  // 0.92 default (was 0.95): live corpus showed the 0.92–0.95 band is
  // reliably same-fact paraphrases, while 0.90–0.92 still contains
  // distinct facts (e.g. two different env-var names at sim 0.91) —
  // do not lower further without re-auditing pending proposals.
  const mergeThreshold = opts.mergeThreshold ?? 0.92;
  const proposeThreshold = opts.proposeThreshold ?? 0.85;
  const maxGroupSize = opts.maxGroupSize ?? 500;
  const autoMergeContained = opts.autoMergeContained ?? true;
  const log = opts.log ?? ((message: string) => console.warn(message));
  const autoAcceptThreshold = resolveAutoAcceptThreshold(opts.autoAcceptThreshold, proposeThreshold, log);
  const contradictionDetection = resolveContradictionDetection(
    opts.contradictionDetection, opts.judgeProvider, mergeThreshold, log,
  );
  let judgeCallsThisRun = 0;

  const summary: ConsolidateSummary = {
    groupsScanned: 0, groupsSkipped: [], merged: [], proposed: [],
    autoAcceptedProposals: [], staleRejectedProposals: [], autoAccepted: [],
    contradictionsPreviewed: [], contradictionsProposed: [], contradictionCapReached: false,
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
  const proposalRepo = new ProposalRepo(db);

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

        // FEAT-456: contradiction judge. Sits AHEAD of the proposeThreshold
        // guard below so it can also see the lower [minSimilarity,
        // proposeThreshold) band the merge tier never looks at — two
        // contradicting facts about the same entity can sit well below the
        // near-duplicate paraphrase threshold (§1.2). Never judges a pair
        // sim >= mergeThreshold owns — that tier already treats it as
        // certain enough to auto-supersede.
        if (contradictionDetection && sim >= contradictionDetection.minSimilarity && sim < mergeThreshold) {
          if (judgeCallsThisRun >= contradictionDetection.maxPerRun) {
            // Cap exhausted — degrade gracefully: fall through to today's
            // merge-tier classification unchanged (§1.5).
            summary.contradictionCapReached = true;
          } else {
            judgeCallsThisRun++;
            const verdict = await judgeContradiction(contradictionDetection.judgeProvider, a, b, { log });
            if (verdict.verdict === 'contradicts' && verdict.confidence >= contradictionDetection.minConfidence) {
              // Directional: newer atom is the presumptive correction (§2.2)
              // — opposite of the merge tier's usefulness-based pick.
              const [newer, older] = a.created_at >= b.created_at ? [a, b] : [b, a];
              if (contradictionDetection.mode === 'dry-run') {
                summary.contradictionsPreviewed.push({ winner: newer.id, loser: older.id, similarity: sim, verdict });
              } else {
                const proposalId = insertContradictionProposal(
                  db, newer.id, older.id, newer.text, older.text, sim, verdict,
                );
                if (proposalId) {
                  summary.contradictionsProposed.push({ winner: newer.id, loser: older.id, similarity: sim, proposalId });
                }
              }
              continue; // pair fully handled either way
            }
            if (verdict.verdict === 'unrelated') continue; // judge overrides: not actually a candidate
            // 'agrees' | 'refines' | (unconfident 'contradicts') — fall
            // through unchanged into the existing merge-tier logic below.
          }
        }

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
          const proposalId = randomUUID();
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
            proposalId, winner.id, loser.id, sim, Date.now(),
            winner.id, loser.id, winner.id, loser.id,
          );
          if (inserted.changes > 0) {
            // FEAT-442: proposal-tier pair that clears the auto-accept bar —
            // resolve it the same instant via the human-accept code path
            // (proposal row created THEN accepted, same audit trail as a
            // manual accept) instead of leaving it pending.
            if (autoAcceptThreshold !== null && sim >= autoAcceptThreshold) {
              proposalRepo.accept(proposalId, { autoAccepted: true, threshold: autoAcceptThreshold, similarity: sim });
              invalidatedThisRun.add(loser.id);
              summary.autoAccepted.push({ winner: winner.id, loser: loser.id, similarity: sim, proposalId });
            } else {
              summary.proposed.push({ winner: winner.id, loser: loser.id, similarity: sim });
            }
          }
        }
      }
    }
  }

  return summary;
}
