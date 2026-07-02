/**
 * Consolidation proposal queue (ADR-004 stage 9, propose-only flow).
 * The consolidation job writes pending rows; the user resolves them here.
 * Accepting a merge proposal executes the same non-destructive
 * merge-as-supersede path the auto-merges use.
 */

import type { DB } from '../storage/db.js';
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

  list(status?: ConsolidationProposal['status']): ConsolidationProposal[] {
    if (status) {
      return this.db.prepare(
        'SELECT * FROM consolidation_proposals WHERE status = ? ORDER BY created_at ASC',
      ).all(status) as ConsolidationProposal[];
    }
    return this.db.prepare(
      'SELECT * FROM consolidation_proposals ORDER BY created_at ASC',
    ).all() as ConsolidationProposal[];
  }

  get(id: string): ConsolidationProposal | null {
    const row = this.db.prepare('SELECT * FROM consolidation_proposals WHERE id = ?')
      .get(id) as ConsolidationProposal | undefined;
    return row ?? null;
  }

  /** Accept: execute the merge, mark accepted — one transaction. */
  accept(id: string): ConsolidationProposal {
    const tx = this.db.transaction((): ConsolidationProposal => {
      const p = this.mustBePending(id);
      mergeAsSupersede(this.db, p.winner_id, p.loser_id);
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
