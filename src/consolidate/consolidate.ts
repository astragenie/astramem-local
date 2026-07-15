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
import type { VectorStore } from '../contracts/index.js';
import { SqliteVecStore } from '../vector/sqlite-vec.js';
import { MemoryEventRepo, type SupersedeProvenance, type CorrectionSource } from '../storage/memory-events.js';
import { usefulnessScores } from '../storage/usefulness.js';
import { ProposalRepo } from './proposals.js';
import { judgeContradiction, type JudgeVerdict } from './contradiction-judge.js';
import { recordConsolidationJudgeRun } from '../storage/consolidation-judge-log.js';
import { getConsolidationCursor, setConsolidationCursor } from '../storage/consolidation-cursor.js';
import { recordConsolidationRun } from '../storage/consolidation-run-log.js';

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
  /**
   * ADR-019 Tier 1 (issue #347): the pairwise scan below (`for`/`for` over
   * each (repo, type) group) yields to the event loop every N pairs via
   * `await new Promise(r => setImmediate(r))` — a real cooperative yield,
   * not a timer-family no-op. Without this, a large group (up to
   * `maxGroupSize`, default 500 → C(500,2) = 124,750 pairs) runs as one
   * uninterrupted synchronous JS stack across every group, starving the
   * HTTP/MCP event loop for the whole scan and hanging `/recall` and
   * `/memory/:id/used` — the confirmed mechanism behind issue #347 (see
   * ADR-019). Default 200 pairs; tune down if a single group's per-pair
   * cost (embedding compare + SQLite writes) is unusually heavy, up if
   * `setImmediate` overhead becomes measurable at very small groups.
   */
  yieldEveryNPairs?: number;
  /**
   * Test-only observability hook: called once per cooperative yield (see
   * `yieldEveryNPairs`). Lets tests assert the yield actually fires without
   * timing the event loop. Never set in production.
   */
  onYield?: () => void;
  /**
   * P2.1 stabilization: candidate-pair selection strategy — mirrors
   * `Config['consolidation']['candidateSelection']` exactly (see that
   * field's doc comment for the full mechanism/rationale). Default
   * `'full'` is BYTE-IDENTICAL to pre-P2.1 behavior. An invalid value
   * falls back to `'full'` for THIS run only (logged, never fatal — same
   * pattern as `resolveAutoAcceptThreshold`).
   */
  candidateSelection?: 'full' | 'knn';
  /** Neighbors queried per atom in `'knn'` mode. Default 30. Ignored in
   *  `'full'` mode. An invalid value falls back to the default for THIS
   *  run only (logged, never fatal). */
  knnK?: number;
  /**
   * Ceiling on total candidate pairs processed THIS run, with a persisted
   * resumable cursor — mirrors
   * `Config['consolidation']['maxCandidatePairsPerRun']` exactly (see that
   * field's doc comment). Default `null` = off (unbounded, byte-identical
   * to pre-P2.1 behavior). An invalid value falls back to `null` for THIS
   * run only (logged, never fatal).
   */
  maxCandidatePairsPerRun?: number | null;
  /**
   * Injectable `VectorStore` for the `'knn'` path — defaults to a fresh
   * `SqliteVecStore(db)` when omitted. Callers with an already-wired
   * instance (e.g. `ExtendedHandlerCtx.vecStore`) should pass it through
   * rather than let this call allocate a second one against the same
   * connection. Ignored in `'full'` mode. `SqliteVecStore.search()`
   * doesn't validate its own constructor `dim` against the query vector
   * (only `upsert()` does), so no embedding dimension needs threading
   * here.
   */
  vectorStore?: VectorStore;
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
  /**
   * FEAT-482: true when `contradictionDetection.maxWallClockMs` elapsed
   * before the scan finished — a SEPARATE guard from `contradictionCapReached`
   * because a slow/rate-limited judge provider can blow the wall-clock
   * budget long before `maxPerRun` calls are made (maxPerRun bounds call
   * COUNT, not duration). Same fall-through as the count cap: remaining
   * judge-eligible pairs fall through to the existing merge-tier
   * classification unchanged.
   */
  contradictionWallClockCapReached: boolean;
  /**
   * FEAT-482: total judge calls actually dispatched this run — 0 whenever
   * contradiction detection was off/disabled for the run. Since dollars
   * cannot bound this judge (see contradiction-judge.ts's doc comment —
   * every shipped provider reports `usage.usd: 0`), call count and wall-
   * clock time are the only real cost signals; this field plus
   * `judgeSweepElapsedMs` are what `recordConsolidationJudgeRun`
   * (src/storage/consolidation-judge-log.ts) persists for `doctor` to
   * surface, and what tells an operator who later points extraction at a
   * genuinely metered provider what actually happened.
   */
  judgeCallsExecuted: number;
  /**
   * FEAT-482: wall-clock milliseconds spent in the judge sweep this run
   * (0 when contradiction detection was off/disabled). Measured from the
   * same `judgeSweepStartedAt` the `maxWallClockMs` cap checks against.
   */
  judgeSweepElapsedMs: number;
  /**
   * FEAT-499 stage 1: of `judgeCallsExecuted` REAL judge dispatches this
   * run, how many had a pair cosine similarity in
   * [NEAR_MERGE_THRESHOLD_MIN, mergeThreshold) — see that constant's doc
   * comment. Always 0 when contradiction detection was off/disabled. Purely
   * observational (no behavior change); this is the evidence a future
   * stage-2 short-circuit would be gated on.
   */
  judgeCallsNearThreshold: number;
}

// Exported (not just for internal use) so buildFullPairs/buildKnnCandidatePairs
// below can be unit-tested directly against hand-built fixtures.
export interface AtomRow {
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
 * All C(n,2) pairs in a group, in the exact i<j nested-loop order the
 * pre-P2.1 scan always used — `'full'` mode's default (no
 * `maxCandidatePairsPerRun` ceiling) output stays byte-identical to
 * pre-P2.1 behavior. Exported for the knn-vs-full recall-parity test.
 */
export function buildFullPairs(group: readonly AtomRow[]): Array<[AtomRow, AtomRow]> {
  const pairs: Array<[AtomRow, AtomRow]> = [];
  for (let i = 0; i < group.length; i++) {
    for (let j = i + 1; j < group.length; j++) {
      pairs.push([group[i] as AtomRow, group[j] as AtomRow]);
    }
  }
  return pairs;
}

/**
 * P2.1: per-atom top-`k` nearest-neighbor query via the existing
 * `VectorStore.search()` abstraction — same infra `/recall` uses, no new
 * dependency. `Config['consolidation']['candidateSelection']`'s doc
 * comment explains why this is a JS post-filter rather than a same-query
 * metadata filter: sqlite-vec's adapter throws on a non-empty `VecFilter`
 * today (`src/vector/sqlite-vec.ts`'s `search()` — "VecFilter not yet
 * implemented"), so hits are filtered down to the current (repo,type)
 * group's own atom ids here instead. Symmetric pairs are deduplicated via
 * a canonical min/max-id key (same pair-identity convention
 * `insertContradictionProposal`'s `MIN(winner_id,loser_id)`/
 * `MAX(winner_id,loser_id)` SQL guard already uses — just an in-memory Set
 * instead of a DB `WHERE NOT EXISTS`). O(n^2) -> O(n*k).
 *
 * Cooperative-yields during the search phase too (ADR-019 Tier 1,
 * `yieldEveryNPairs` reused as the cadence) — each `vectorStore.search()`
 * call runs a synchronous better-sqlite3 MATCH query under the hood, so
 * without a periodic `setImmediate` yield here a large group's
 * CANDIDATE-GENERATION phase (not just its later pair-processing phase)
 * could itself become one long uninterrupted stretch.
 */
export async function buildKnnCandidatePairs(
  group: readonly AtomRow[],
  vecs: ReadonlyMap<string, Float32Array>,
  vectorStore: VectorStore,
  k: number,
  opts: { yieldEveryNPairs?: number; onYield?: () => void } = {},
): Promise<Array<[AtomRow, AtomRow]>> {
  const groupIds = new Set(group.map(a => a.id));
  const byId = new Map(group.map(a => [a.id, a]));
  const seenPairKeys = new Set<string>();
  const pairs: Array<[AtomRow, AtomRow]> = [];
  const yieldEvery = opts.yieldEveryNPairs ?? 200;
  let sinceYield = 0;

  for (const a of group) {
    sinceYield++;
    if (sinceYield >= yieldEvery) {
      sinceYield = 0;
      await new Promise<void>(resolve => setImmediate(resolve));
      opts.onYield?.();
    }

    const va = vecs.get(a.id);
    if (!va) continue;
    const hits = await vectorStore.search(va, k);
    for (const hit of hits) {
      if (hit.id === a.id) continue;
      if (!groupIds.has(hit.id)) continue; // post-filter to this (repo,type) group
      const b = byId.get(hit.id);
      if (!b) continue;
      const key = a.id < b.id ? `${a.id} ${b.id}` : `${b.id} ${a.id}`;
      if (seenPairKeys.has(key)) continue;
      seenPairKeys.add(key);
      pairs.push(a.id < b.id ? [a, b] : [b, a]);
    }
  }
  return pairs;
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
 *
 * `correctionSource` (issue #190) is REQUIRED, deliberately with no default —
 * every call site in this module is either fully automatic (containment tier,
 * mergeThreshold tier: always `'consolidation_auto'`) or routes through
 * `ProposalRepo.accept`, which itself decides `'consolidation_auto'` vs
 * `'external'` based on whether a human resolved the proposal (see
 * `proposals.ts`). Forcing every caller to say which, rather than defaulting,
 * is exactly what a silently-wrong default would have re-created here.
 */
export function mergeAsSupersede(
  db: DB, winnerId: string, loserId: string,
  provenance: SupersedeProvenance | undefined, correctionSource: CorrectionSource,
): void {
  const events = new MemoryEventRepo(db);
  const tx = db.transaction(() => {
    events.supersede(loserId, winnerId, provenance, correctionSource);
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
        // issue #190: this sweep runs unattended inside runConsolidation with
        // no human in the loop — 'consolidation_auto', same as the two direct
        // merge tiers above.
        repo.accept(r.id, undefined, { correctionSource: 'consolidation_auto' });
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

const DEFAULT_KNN_K = 30;

/** P2.1: never-fatal per-run validation for the three new candidate-
 *  selection opts — same "log + fall back to the documented default"
 *  posture as `resolveAutoAcceptThreshold` above and
 *  `applyCandidateSelectionGovernance` (src/config/config.ts), which this
 *  mirrors for callers that build `ConsolidateOpts` directly rather than
 *  going through `loadConfig`. */
function resolveCandidateSelection(
  raw: ConsolidateOpts['candidateSelection'],
  log: (message: string) => void,
): 'full' | 'knn' {
  if (raw === undefined) return 'full';
  if (raw !== 'full' && raw !== 'knn') {
    log(`[consolidate] candidateSelection=${JSON.stringify(raw)} is invalid (must be 'full' or 'knn') — falling back to 'full' for this run.`);
    return 'full';
  }
  return raw;
}

function resolveKnnK(raw: number | undefined, log: (message: string) => void): number {
  if (raw === undefined) return DEFAULT_KNN_K;
  if (!Number.isInteger(raw) || raw < 1) {
    log(`[consolidate] knnK=${raw} is invalid (must be a positive integer) — falling back to ${DEFAULT_KNN_K} for this run.`);
    return DEFAULT_KNN_K;
  }
  return raw;
}

function resolveMaxCandidatePairsPerRun(
  raw: number | null | undefined,
  log: (message: string) => void,
): number | null {
  if (raw === null || raw === undefined) return null;
  if (!Number.isInteger(raw) || raw < 1) {
    log(`[consolidate] maxCandidatePairsPerRun=${raw} is invalid (must be a positive integer or null) — ceiling disabled for this run.`);
    return null;
  }
  return raw;
}

interface ResolvedContradictionDetection {
  mode: 'dry-run' | 'enabled';
  minSimilarity: number;
  minConfidence: number;
  maxPerRun: number;
  maxWallClockMs: number;
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
 *
 * FEAT-482: deliberately does NOT gate on a dollar budget — see
 * contradiction-judge.ts's doc comment for why a BudgetTracker dependency
 * was tried and reverted here (both shipped providers report `usd: 0`, so a
 * dollar cap can never trip). `maxPerRun`/`maxWallClockMs` below are the
 * real caps.
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
    maxPerRun: raw.maxPerRun, maxWallClockMs: raw.maxWallClockMs, judgeProvider,
  };
}

/**
 * FEAT-499 stage 1 (instrument-first, competitive-teardown steal #2, Mnemon
 * internal/search/diff.go, Apache-2.0). The judge is already gated to pairs
 * in [minSimilarity, mergeThreshold) — see `resolveContradictionDetection`
 * above. Mnemon's insight is that cosine similarity ABOVE this band's own
 * 0.90 boundary is almost always the same fact restated, not a genuine
 * contradiction candidate, and could in principle skip the judge entirely
 * via a cheap deterministic short-circuit. This constant marks that
 * boundary for INSTRUMENTATION only — counting how many real judge calls
 * fall in [NEAR_MERGE_THRESHOLD_MIN, mergeThreshold) — so a stage-2 filter
 * (only added later, gated on this measurement showing >= 20% of calls in
 * that band) has real evidence instead of a guess. No skip/filter exists
 * yet; this never changes which pairs get judged.
 */
export const NEAR_MERGE_THRESHOLD_MIN = 0.90;

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
  // Kill-switch (2026-07-15): even a requeued/orphaned consolidate job must
  // no-op when disabled — the boot-enqueue gate in serve.ts alone can't cover
  // a job already sitting in the queue. Returns an empty summary; the job
  // completes cleanly with no scan and no event-loop-freezing setup.
  if (process.env['ASTRA_SKIP_CONSOLIDATE'] === '1') {
    (opts.log ?? ((m: string) => console.warn(m)))(
      `${new Date().toISOString()} [consolidate] skipped — ASTRA_SKIP_CONSOLIDATE=1`,
    );
    return {
      groupsScanned: 0, groupsSkipped: [], merged: [], proposed: [],
      autoAcceptedProposals: [], staleRejectedProposals: [], autoAccepted: [],
      contradictionsPreviewed: [], contradictionsProposed: [], contradictionCapReached: false,
      contradictionWallClockCapReached: false, judgeCallsExecuted: 0, judgeSweepElapsedMs: 0,
      judgeCallsNearThreshold: 0,
    };
  }
  // 0.92 default (was 0.95): live corpus showed the 0.92–0.95 band is
  // reliably same-fact paraphrases, while 0.90–0.92 still contains
  // distinct facts (e.g. two different env-var names at sim 0.91) —
  // do not lower further without re-auditing pending proposals.
  const mergeThreshold = opts.mergeThreshold ?? 0.92;
  const proposeThreshold = opts.proposeThreshold ?? 0.85;
  const maxGroupSize = opts.maxGroupSize ?? 500;
  const autoMergeContained = opts.autoMergeContained ?? true;
  const log = opts.log ?? ((message: string) => console.warn(message));
  // ADR-019 Tier 1 (issue #347): cooperative-yield interval — see
  // ConsolidateOpts.yieldEveryNPairs doc comment.
  const yieldEveryNPairs = opts.yieldEveryNPairs ?? 200;
  const onYield = opts.onYield;
  let pairsScannedSinceYield = 0;
  const autoAcceptThreshold = resolveAutoAcceptThreshold(opts.autoAcceptThreshold, proposeThreshold, log);
  const contradictionDetection = resolveContradictionDetection(
    opts.contradictionDetection, opts.judgeProvider, mergeThreshold, log,
  );
  // P2.1 stabilization — see ConsolidateOpts doc comments above.
  const candidateSelection = resolveCandidateSelection(opts.candidateSelection, log);
  const knnK = resolveKnnK(opts.knnK, log);
  const maxCandidatePairsPerRun = resolveMaxCandidatePairsPerRun(opts.maxCandidatePairsPerRun, log);
  let judgeCallsThisRun = 0;
  let judgeErrorsThisRun = 0;
  let judgeCallsNearThresholdThisRun = 0;
  const judgeSweepStartedAt = Date.now();

  const summary: ConsolidateSummary = {
    groupsScanned: 0, groupsSkipped: [], merged: [], proposed: [],
    autoAcceptedProposals: [], staleRejectedProposals: [], autoAccepted: [],
    contradictionsPreviewed: [], contradictionsProposed: [], contradictionCapReached: false,
    contradictionWallClockCapReached: false, judgeCallsExecuted: 0, judgeSweepElapsedMs: 0,
    judgeCallsNearThreshold: 0,
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

  // ─── P2.1: shared per-pair classification (identical for 'full'/'knn') ──
  // Defined as a closure so both candidate-generation strategies below run
  // the EXACT SAME similarity/containment/judge logic the pre-P2.1 nested
  // loop always ran, unchanged — only the SOURCE of `[a, b]` pairs differs.
  async function processPair(a: AtomRow, b: AtomRow, vecs: ReadonlyMap<string, Float32Array>): Promise<void> {
    // ADR-019 Tier 1 (issue #347): yield to the event loop every
    // yieldEveryNPairs pairs, counted regardless of early `return`s below —
    // this bounds the longest uninterrupted synchronous stretch to
    // ~yieldEveryNPairs iterations no matter which pairs get skipped,
    // instead of only bounding "fully processed" pairs.
    pairsScannedSinceYield++;
    if (pairsScannedSinceYield >= yieldEveryNPairs) {
      pairsScannedSinceYield = 0;
      await new Promise<void>(resolve => setImmediate(resolve));
      onYield?.();
    }

    if (invalidatedThisRun.has(a.id) || invalidatedThisRun.has(b.id)) return;
    const va = vecs.get(a.id), vb = vecs.get(b.id);
    if (!va || !vb) return;
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
      } else if (Date.now() - judgeSweepStartedAt >= contradictionDetection.maxWallClockMs) {
        // FEAT-482: wall-clock cap exhausted — same fall-through as the
        // count cap above. Guards against a slow/rate-limited judge
        // provider wedging the run indefinitely even though maxPerRun
        // hasn't been hit yet (the FEAT-482 incident: ~245 calls at
        // ~13/min against a throttled provider, not a count problem).
        summary.contradictionWallClockCapReached = true;
      } else {
        judgeCallsThisRun++;
        // FEAT-499 stage 1 (instrument-first): count real judge
        // dispatches whose pair similarity falls in the near-merge-
        // threshold band — a call skipped by either cap above never
        // reaches here, so this only ever counts calls that actually
        // hit the LLM.
        if (sim >= NEAR_MERGE_THRESHOLD_MIN) judgeCallsNearThresholdThisRun++;
        const verdict = await judgeContradiction(contradictionDetection.judgeProvider, a, b, {
          log,
          onFallback: () => { judgeErrorsThisRun++; },
        });
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
          return; // pair fully handled either way
        }
        if (verdict.verdict === 'unrelated') return; // judge overrides: not actually a candidate
        // 'agrees' | 'refines' | (unconfident 'contradicts') — fall
        // through unchanged into the existing merge-tier logic below.
      }
    }

    if (sim < proposeThreshold) return;

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
        // issue #190: this tier merges immediately with no proposal row
        // and no human step possible — always 'consolidation_auto'.
        mergeAsSupersede(db, winner.id, loser.id, undefined, 'consolidation_auto');
        invalidatedThisRun.add(loser.id);
        summary.merged.push({ winner: winner.id, loser: loser.id, similarity: sim, reason: 'contained' });
        return;
      }
    }

    if (sim >= mergeThreshold) {
      // issue #190: same reasoning as the containment tier above.
      mergeAsSupersede(db, winner.id, loser.id, undefined, 'consolidation_auto');
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
          // issue #190: also automatic, no human step — 'consolidation_auto'.
          proposalRepo.accept(
            proposalId, { autoAccepted: true, threshold: autoAcceptThreshold, similarity: sim },
            { correctionSource: 'consolidation_auto' },
          );
          invalidatedThisRun.add(loser.id);
          summary.autoAccepted.push({ winner: winner.id, loser: loser.id, similarity: sim, proposalId });
        } else {
          summary.proposed.push({ winner: winner.id, loser: loser.id, similarity: sim });
        }
      }
    }
  }

  // ─── P2.1: group ordering ─────────────────────────────────────────────
  // Default (no ceiling): iterate groups in the exact order they were
  // inserted into `groups` (repo, type, created_at scan order) — unchanged
  // from pre-P2.1 behavior, byte-identical output for 'full' mode with no
  // `maxCandidatePairsPerRun` set. Only when the ceiling is actually
  // configured do we switch to a deterministic, resumable ordering: a
  // naive Map-insertion-order truncation would always start from (and stop
  // at) the same groups every run, permanently starving whichever groups
  // sort last — the reviewer MEDIUM finding this whole mechanism exists to
  // close (20260715T1640Z review-stabilization-plan-architect-reviewer.md).
  interface GroupEntry { key: string; atoms: AtomRow[] }
  const allGroups: GroupEntry[] = [];
  for (const [key, groupAtoms] of groups) {
    if (groupAtoms.length < 2) continue;
    allGroups.push({ key, atoms: groupAtoms });
  }

  let groupOrder: GroupEntry[] = allGroups;
  const ceilingActive = maxCandidatePairsPerRun !== null;
  if (ceilingActive) {
    // `atoms` is already created_at ASC per group (SQL ORDER BY), so a
    // group's own first element is its oldest atom — sort groups by that.
    const sorted = [...allGroups].sort((x, y) => {
      const dx = (x.atoms[0] as AtomRow).created_at, dy = (y.atoms[0] as AtomRow).created_at;
      if (dx !== dy) return dx - dy;
      return x.key < y.key ? -1 : x.key > y.key ? 1 : 0;
    });
    const cursor = getConsolidationCursor(db);
    const cursorGroupKey = cursor?.groupKey ?? null;
    const startIdx = cursorGroupKey ? sorted.findIndex(g => g.key === cursorGroupKey) : -1;
    // Rotate so scanning resumes at the persisted cursor; a missing/stale
    // cursor (group merged away since, or never persisted) falls back to
    // the natural oldest-first order rather than skipping anything.
    groupOrder = startIdx > 0 ? [...sorted.slice(startIdx), ...sorted.slice(0, startIdx)] : sorted;
  }

  const vectorStore: VectorStore | undefined =
    candidateSelection === 'knn' ? (opts.vectorStore ?? new SqliteVecStore(db)) : undefined;

  let pairsProcessedThisRun = 0;
  let ceilingHitAtGroupIndex = -1;

  for (let gi = 0; gi < groupOrder.length; gi++) {
    const group = (groupOrder[gi] as GroupEntry).atoms;
    const first = group[0] as AtomRow;

    // 'full' mode keeps the binary skip (unchanged), now SURFACED — see
    // recordConsolidationRun below and the WARN log line (reviewer MEDIUM
    // finding this closes: groupsSkipped used to be computed and read
    // nowhere). 'knn' mode never skips: k-NN already bounds the per-atom
    // cost, so an oversized group is processed instead of dropped.
    if (candidateSelection === 'full' && group.length > maxGroupSize) {
      summary.groupsSkipped.push({ repo: first.repo, type: first.type, size: group.length });
      log(
        `[consolidate] WARN group skipped: repo=${first.repo ?? '(none)'} type=${first.type} ` +
        `size=${group.length} > maxGroupSize=${maxGroupSize} — this group gets ZERO consolidation ` +
        "coverage this run. Set consolidation.candidateSelection: 'knn' to process oversized groups " +
        'instead of dropping them.',
      );
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

    // Candidate-pair generation: O(n^2) nested loop for 'full' (unchanged
    // semantics, just now built as a list instead of inline), or the k-NN
    // reduced set for 'knn'. Yielding to the event loop periodically during
    // the SCAN below (both generation and processing) is what keeps the
    // daemon responsive on a large corpus — see ADR-019 Tier 1 / the
    // 2026-07-15 incident this loop's yield points already fixed for 'full'
    // mode; buildKnnCandidatePairs carries the equivalent yield for its own
    // generation phase.
    const pairs: Array<[AtomRow, AtomRow]> = candidateSelection === 'knn'
      ? await buildKnnCandidatePairs(group, vecs, vectorStore as VectorStore, knnK, { yieldEveryNPairs, onYield })
      : buildFullPairs(group);

    for (const [a, b] of pairs) {
      await processPair(a, b, vecs);
      pairsProcessedThisRun++;
    }

    if (ceilingActive && pairsProcessedThisRun >= (maxCandidatePairsPerRun as number)) {
      ceilingHitAtGroupIndex = gi;
      break;
    }
  }

  if (ceilingActive) {
    if (ceilingHitAtGroupIndex >= 0) {
      // Persist where to resume — the NEXT group in this run's rotated
      // order, or `null` (start from the natural oldest-first order) if we
      // stopped on the very last group.
      const nextKey = groupOrder[ceilingHitAtGroupIndex + 1]?.key ?? null;
      setConsolidationCursor(db, { groupKey: nextKey });
    } else {
      // Finished every group in groupOrder within budget this run — a full
      // sweep cycle completed; reset so the next run starts from the
      // natural oldest-first order again instead of drifting off a cursor
      // group that may no longer exist.
      setConsolidationCursor(db, { groupKey: null });
    }
  }

  // P2.1: run-summary telemetry (migration 050,
  // src/storage/consolidation-run-log.ts) — closes the reviewer MEDIUM
  // finding (20260715T1640Z): groupsSkipped used to be computed and read
  // nowhere. Written on every REAL run (ASTRA_SKIP_CONSOLIDATE already
  // short-circuits before this point with an empty summary and no DB
  // write, above).
  recordConsolidationRun(db, {
    candidateSelection,
    groupsScanned: summary.groupsScanned,
    groupsSkippedCount: summary.groupsSkipped.length,
    groupsSkippedAtoms: summary.groupsSkipped.reduce((sum, g) => sum + g.size, 0),
    mergedCount: summary.merged.length,
    proposedCount: summary.proposed.length,
  });

  // FEAT-482: judge cost is invisible to a dollar cap (see
  // contradiction-judge.ts's doc comment) — record what actually happened
  // instead, so `doctor` (checkConsolidationJudgeTelemetry) can surface it.
  // Only when contradiction detection was actually active this run; an
  // 'off'/disabled run has nothing to report and would just be zero-noise.
  if (contradictionDetection) {
    summary.judgeCallsExecuted = judgeCallsThisRun;
    summary.judgeSweepElapsedMs = Date.now() - judgeSweepStartedAt;
    summary.judgeCallsNearThreshold = judgeCallsNearThresholdThisRun;
    log(
      `[consolidate] judge sweep: mode=${contradictionDetection.mode} calls=${summary.judgeCallsExecuted} ` +
      `elapsedMs=${summary.judgeSweepElapsedMs} capReached=${summary.contradictionCapReached} ` +
      `wallClockCapReached=${summary.contradictionWallClockCapReached} errors=${judgeErrorsThisRun} ` +
      `nearThreshold=${summary.judgeCallsNearThreshold}/${summary.judgeCallsExecuted}`,
    );
    recordConsolidationJudgeRun(db, {
      mode: contradictionDetection.mode,
      judgeCalls: summary.judgeCallsExecuted,
      elapsedMs: summary.judgeSweepElapsedMs,
      capReached: summary.contradictionCapReached,
      wallClockCapReached: summary.contradictionWallClockCapReached,
      judgeErrors: judgeErrorsThisRun,
      judgeCallsNearThreshold: judgeCallsNearThresholdThisRun,
    });
  }

  return summary;
}
