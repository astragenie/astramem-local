/**
 * Consolidation proposal queue (ADR-004 stage 9, propose-only flow).
 * The consolidation job writes pending rows; the user resolves them here.
 * Accepting a merge proposal executes the same non-destructive
 * merge-as-supersede path the auto-merges use.
 */

import type { DB } from '../storage/db.js';
import type { SupersedeProvenance, CorrectionSource } from '../storage/memory-events.js';
import { mergeAsSupersede } from './consolidate.js';

export interface ConsolidationProposal {
  id: string;
  kind: 'merge' | 'contradiction';
  winner_id: string;
  loser_id: string;
  similarity: number;
  status: 'pending' | 'accepted' | 'rejected';
  created_at: number;
  resolved_at: number | null;
  /** FEAT-456 SLICE-1: additive nullable column (migration 022). `NULL`
   *  forever for `kind='merge'` rows. `kind='contradiction'` rows populate
   *  it with the judge's verdict/confidence + excerpts captured at judge
   *  time — see {@link ContradictionMetadata} and
   *  `parseContradictionMetadata`. */
  metadata_json: string | null;
}

/** Parsed shape of a `kind='contradiction'` row's `metadata_json`. */
export interface ContradictionMetadata {
  verdict: 'contradicts';
  confidence: number;
  /** Truncated (~280 chars) atom text, captured at judge time — reflects
   *  what the judge actually saw, not the atom's current (possibly
   *  since-superseded) text. */
  winner_excerpt: string;
  loser_excerpt: string;
}

/**
 * Typed accessor for callers (MCP, dashboard — slice 2) that want the
 * structured shape instead of raw JSON text. Returns `null` for `kind=
 * 'merge'` rows (metadata_json is NULL) or an unparsable value — never
 * throws, matches this module's "propose-only, never block a read" spirit.
 */
export function parseContradictionMetadata(p: ConsolidationProposal): ContradictionMetadata | null {
  if (!p.metadata_json) return null;
  try {
    return JSON.parse(p.metadata_json) as ContradictionMetadata;
  } catch {
    return null;
  }
}

/**
 * Confidence proxy shared by pagination and batch-resolve filtering (#372).
 * There is no dedicated `confidence` column — `kind='merge'` rows have no
 * `metadata_json` at all (always NULL, see {@link ConsolidationProposal}),
 * so the cosine `similarity` that produced the proposal stands in for it;
 * `kind='contradiction'` rows carry an actual judge confidence inside
 * `metadata_json` (see {@link parseContradictionMetadata}), falling back to
 * 0 if that JSON is missing or unparsable rather than throwing.
 */
export function proposalConfidence(p: ConsolidationProposal): number {
  if (p.kind === 'contradiction') return parseContradictionMetadata(p)?.confidence ?? 0;
  return p.similarity;
}

/** Optional filters for {@link ProposalRepo.list} — additive, all omittable
 *  (existing two-arg callers are unaffected). */
export interface ProposalListOptions {
  /** Max rows to return. Omitted = no limit (pre-existing behavior). */
  limit?: number;
  /** Rows to skip before applying `limit`. Default 0. */
  offset?: number;
  /** Only rows whose {@link proposalConfidence} is >= this value. */
  minConfidence?: number;
}

export class ProposalNotFoundError extends Error {
  constructor(id: string) {
    super(`consolidation proposal not found: ${id}`);
    this.name = 'ProposalNotFoundError';
  }
}

export class ProposalAlreadyResolvedError extends Error {
  constructor(id: string, status: string) {
    super(`consolidation proposal ${id} is already ${status}`);
    this.name = 'ProposalAlreadyResolvedError';
  }
}

export class ProposalRepo {
  constructor(private db: DB) {}

  /**
   * FEAT-456 SLICE-2: optional `kind` filter, additive alongside `status`.
   * Needed by §2.4's audit query (`?status=accepted&kind=contradiction`)
   * and by the MCP/dashboard surfacing work — trivial extra `WHERE`, no
   * new index (the table is small; both filters are already covered by
   * the existing `status`/`kind` columns).
   *
   * #372/#171: `opts.minConfidence`/`limit`/`offset` are additive on top of
   * that same precedent. `minConfidence` is not a SQL-filterable column
   * (see {@link proposalConfidence} — it requires a JSON parse for
   * `kind='contradiction'` rows), so this fetches the status/kind-filtered
   * set, filters by confidence, THEN slices for pagination — one JS pass
   * over a table documented small (hundreds, not millions, of rows), not a
   * second query shape to keep in sync with a SQL `WHERE`.
   */
  list(
    status?: ConsolidationProposal['status'],
    kind?: ConsolidationProposal['kind'],
    opts?: ProposalListOptions,
  ): ConsolidationProposal[] {
    const clauses: string[] = [];
    const params: string[] = [];
    if (status) { clauses.push('status = ?'); params.push(status); }
    if (kind) { clauses.push('kind = ?'); params.push(kind); }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
    let rows = this.db.prepare(
      `SELECT * FROM consolidation_proposals${where} ORDER BY created_at ASC`,
    ).all(...params) as ConsolidationProposal[];
    if (opts?.minConfidence !== undefined) {
      const floor = opts.minConfidence;
      rows = rows.filter(p => proposalConfidence(p) >= floor);
    }
    if (opts?.offset !== undefined || opts?.limit !== undefined) {
      const offset = opts?.offset ?? 0;
      rows = opts?.limit !== undefined ? rows.slice(offset, offset + opts.limit) : rows.slice(offset);
    }
    return rows;
  }

  /**
   * Total rows matching `status`/`kind`/`minConfidence` — the same filters
   * `list()` applies, minus the limit/offset slice. What a paginating
   * caller needs to render "page 2/31 of 768"; deliberately reuses `list()`
   * rather than a separate `COUNT(*)` query so the two can never disagree.
   */
  count(
    status?: ConsolidationProposal['status'],
    kind?: ConsolidationProposal['kind'],
    minConfidence?: number,
  ): number {
    return this.list(status, kind, minConfidence !== undefined ? { minConfidence } : undefined).length;
  }

  get(id: string): ConsolidationProposal | null {
    const row = this.db.prepare('SELECT * FROM consolidation_proposals WHERE id = ?')
      .get(id) as ConsolidationProposal | undefined;
    return row ?? null;
  }

  /**
   * Accept: execute the merge, mark accepted — one transaction.
   * `provenance` (FEAT-442) is forwarded to `mergeAsSupersede` untouched —
   * pass it only from the autonomous-consolidation auto-accept path;
   * omitted (the human-accept path — REST/CLI/MCP), the resulting
   * supersede event carries no `auto_accepted` marker, exactly as before.
   *
   * `opts.bulkAccepted` (FEAT-437 residual) marks the resulting supersede
   * event as resolved via the bulk `consolidate accept --all` CLI path
   * rather than a single manual accept — see {@link markBulkAccepted} for
   * why this is a separate, additive mechanism from `provenance`.
   *
   * `opts.correctionSource` (issue #190) defaults to `'external'` — this
   * method is called from THREE places: the two automatic consolidate.ts
   * sweeps (which explicitly pass `'consolidation_auto'`) and the human
   * REST/MCP/dashboard `resolve_consolidation_proposal` path (which passes
   * nothing at all). Defaulting to `'external'` here means a human accepting
   * a proposal is correctly counted as genuine feedback in
   * `feedbackLoopSummary()`, distinct from the two unattended sweeps.
   */
  accept(
    id: string, provenance?: SupersedeProvenance,
    opts?: { bulkAccepted?: boolean; correctionSource?: CorrectionSource },
  ): ConsolidationProposal {
    const tx = this.db.transaction((): ConsolidationProposal => {
      const p = this.mustBePending(id);
      mergeAsSupersede(this.db, p.winner_id, p.loser_id, provenance, opts?.correctionSource ?? 'external');
      if (opts?.bulkAccepted) this.markBulkAccepted(p.loser_id);
      return this.resolve(p.id, 'accepted');
    });
    return tx();
  }

  /**
   * FEAT-437 residual: patch a `bulk_accepted: true` marker onto the
   * `supersede` event `mergeAsSupersede` just appended for `loserId`, inside
   * the SAME transaction `accept()` wraps this call in. Deliberately does
   * NOT go through `MemoryEventRepo.supersede()`'s `provenance` param — that
   * type (`SupersedeProvenance`) and the payload fields it produces are
   * owned by src/storage/memory-events.ts (off-limits for this change, per
   * dispatch — another agent may be mid-edit there) and hardcode the
   * `auto_accepted`/`threshold`/`similarity` shape for FEAT-442's case
   * specifically. Patching the row here is observationally identical to
   * having constructed the payload with the marker before the row was ever
   * committed: no other connection can see the two-statement window
   * (better-sqlite3 transactions are synchronous/exclusive on one
   * connection), and no existing event consumer's semantics change —
   * `auto_accepted` and `bulk_accepted` are independent optional flags on
   * the same `supersede` payload, so a proposal resolved via `--all` is
   * distinguishable from both a lone manual accept (neither flag) and an
   * autonomous auto-accept (`auto_accepted` only).
   */
  private markBulkAccepted(loserId: string): void {
    const row = this.db.prepare(`
      SELECT seq, payload_json FROM memory_events
      WHERE atom_id = ? AND event_type = 'supersede'
      ORDER BY seq DESC LIMIT 1
    `).get(loserId) as { seq: number; payload_json: string | null } | undefined;
    if (!row) return; // defensive — mergeAsSupersede always appends exactly one of these first
    const payload = row.payload_json ? (JSON.parse(row.payload_json) as Record<string, unknown>) : {};
    payload.bulk_accepted = true;
    this.db.prepare('UPDATE memory_events SET payload_json = ? WHERE seq = ?')
      .run(JSON.stringify(payload), row.seq);
  }

  /** Reject: mark rejected, nothing else changes. */
  reject(id: string): ConsolidationProposal {
    const tx = this.db.transaction((): ConsolidationProposal => {
      const p = this.mustBePending(id);
      return this.resolve(p.id, 'rejected');
    });
    return tx();
  }

  private mustBePending(id: string): ConsolidationProposal {
    const p = this.get(id);
    if (!p) throw new ProposalNotFoundError(id);
    if (p.status !== 'pending') throw new ProposalAlreadyResolvedError(id, p.status);
    return p;
  }

  private resolve(id: string, status: 'accepted' | 'rejected'): ConsolidationProposal {
    this.db.prepare(
      'UPDATE consolidation_proposals SET status = ?, resolved_at = ? WHERE id = ?',
    ).run(status, Date.now(), id);
    return this.get(id) as ConsolidationProposal;
  }
}
