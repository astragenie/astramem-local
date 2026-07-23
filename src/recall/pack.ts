/**
 * Memory-pack selection (KF-B) — the "injection judgment" v1.
 * Heuristic, no ML: score = typeWeight · recency · importance,
 * take top-N under a token budget, render grouped Markdown.
 * Recency half-life 30 days mirrors search freshness decay.
 */

import type { DB } from '../storage/db.js';

export interface PackOptions {
  /** UX-alias input (SessionStart hook only ever sends this) — merged into
   *  the `project` SQL filter, never queried as its own column. See
   *  selectPack's projectFilter comment for the repo/project precedence. */
  repo: string;
  project?: string | null;
  branch?: string | null;
  budgetTokens?: number;
  typeWeights?: Record<string, number>;
  now?: number;
}

export interface PackMemory {
  id: string;
  type: string;
  text: string;
  score: number;
}

export const DEFAULT_TYPE_WEIGHTS: Record<string, number> = {
  decision: 1.0,
  lesson: 0.9,
  fact: 0.7,
  command: 0.6,
  note: 0.4,
  todo: 0.4,
  event: 0.4,
};

export const DEFAULT_BUDGET_TOKENS = 1500;
const RECENCY_HALF_LIFE_DAYS = 30;
const CANDIDATE_LIMIT = 500;

/**
 * Rough token estimate: ~4 chars per token. Real tokenizers vary ±20% —
 * callers needing exact budgets should leave ~10% headroom. The default
 * 1500-token budget is deliberately conservative for this reason.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

interface Row { id: string; type: string; text: string; importance: number; created_at: number }

export function selectPack(db: DB, opts: PackOptions): PackMemory[] {
  const now = opts.now ?? Date.now();
  const budget = opts.budgetTokens ?? DEFAULT_BUDGET_TOKENS;
  const weights = opts.typeWeights ?? DEFAULT_TYPE_WEIGHTS;

  // atom@2 repo/project consolidation (plan 20260709): `project` is the
  // single canonical field memories are keyed on; `repo` (PackOptions.repo,
  // still required — the SessionStart hook only ever sends `repo`, see
  // src/cli/hook-install.ts) is a UX-alias input, never its own SQL column.
  // An explicit `project` wins; otherwise fall back to `repo`, matching the
  // same precedence src/pipeline/derive-project.ts uses at write time — for
  // ordinary (non-worktree) usage `memories.project` was written equal to
  // `repo`, so this is a same-rows swap. In a git worktree, `repo` (the
  // canonical repo name, explicit at ingest) and `project` (derived from
  // cwd basename when no explicit project was set) can diverge; filtering
  // on `project` here is the intended behavior change — worktree-scoped
  // memories now group with their worktree rather than bleeding across
  // every worktree of the same repo.
  const projectFilter = opts.project ?? opts.repo;

  // Atom v3 (ADR-001): invalidated memories (valid_to set) are excluded from
  // the injected pack — a superseded/dead memory must not surface in recall.
  const clauses = ['project = ?', 'valid_to IS NULL'];
  const params: Array<string | number> = [projectFilter];
  // opts.branch was previously declared but never wired here — a caller
  // requesting a branch got repo/project-wide results with no branch
  // scoping at all. Only filter when a branch is actually requested so
  // existing branch-agnostic callers (no branch passed) are unaffected.
  if (opts.branch != null) {
    clauses.push('branch = ?');
    params.push(opts.branch);
  }
  params.push(CANDIDATE_LIMIT);

  // `, id DESC` tiebreaker (migration 059): created_at collisions are routine
  // under batch/distill ingest, and without a deterministic second sort key
  // the 500-row CANDIDATE_LIMIT cutoff below can silently reshuffle across
  // runs. Matches idx_memories_project_valid_created's trailing columns
  // exactly, so this ORDER BY rides the index instead of forcing a temp
  // b-tree sort.
  const rows = db.prepare(`
    SELECT id, type, text, importance, created_at
    FROM memories
    WHERE ${clauses.join(' AND ')}
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `).all(...params) as Row[];

  const scored: PackMemory[] = rows.map(r => {
    const ageDays = (now - r.created_at) / (24 * 60 * 60 * 1000);
    const recency = Math.exp(-ageDays / RECENCY_HALF_LIFE_DAYS);
    const typeWeight = weights[r.type] ?? 0.4;
    return { id: r.id, type: r.type, text: r.text, score: typeWeight * recency * r.importance };
  });

  scored.sort((a, b) => b.score - a.score);

  const pack: PackMemory[] = [];
  let spent = 0;
  for (const m of scored) {
    const cost = estimateTokens(m.text);
    if (spent + cost > budget) {
      // Guarantee at least the single best memory even under a tiny budget
      if (pack.length === 0) pack.push(m);
      break;
    }
    pack.push(m);
    spent += cost;
  }
  return pack;
}

const TYPE_HEADINGS: Record<string, string> = {
  decision: 'Decisions',
  lesson: 'Lessons',
  fact: 'Facts',
  command: 'Commands',
  todo: 'Todos',
  note: 'Notes',
  event: 'Events',
};

/** Render the pack as compact Markdown grouped by type, memory ids inline. */
export function renderPack(memories: PackMemory[]): string {
  if (memories.length === 0) return '';
  const byType = new Map<string, PackMemory[]>();
  for (const m of memories) {
    const list = byType.get(m.type) ?? [];
    list.push(m);
    byType.set(m.type, list);
  }
  const sections: string[] = ['# Repo memory pack'];
  for (const [type, list] of byType) {
    sections.push(`\n## ${TYPE_HEADINGS[type] ?? type}`);
    // Collapse internal newlines — a multi-line text would break the Markdown list item
    for (const m of list) sections.push(`- ${m.text.replace(/\s+/g, ' ')} \`(${m.id})\``);
  }
  return sections.join('\n');
}
