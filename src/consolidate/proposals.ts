/**
 * Consolidation proposal queue (ADR-004 stage 9, propose-only flow).
 * The consolidation job writes pending rows; the user resolves them here.
 * Accepting a merge proposal executes the same non-destructive
 * merge-as-supersede path the auto-merges use.
 */

import type { DB } from '../storage/db.js';
import type { SupersedeProvenance } from '../storage/memory-events.js';
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
   */
  list(status?: ConsolidationProposal['status'], kind?: ConsolidationProposal['kind']): ConsolidationProposal[] {
    const clauses: string[] = [];
    const params: string[] = [];
    if (status) { clauses.push('status = ?'); params.push(status); }
    if (kind) { clauses.push('kind = ?'); params.push(kind); }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
    return this.db.prepare(
      `SELECT * FROM consolidation_proposals${where} ORDER BY created_at ASC`,
    ).all(...params) as ConsolidationProposal[];
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
   */
  accept(id: string, provenance?: SupersedeProvenance): ConsolidationProposal {
    const tx = this.db.transaction((): ConsolidationProposal => {
      const p = this.mustBePending(id);
      mergeAsSupersede(this.db, p.winner_id, p.loser_id, provenance);
      return this.resolve(p.id, 'accepted');
    });
    return tx();
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
