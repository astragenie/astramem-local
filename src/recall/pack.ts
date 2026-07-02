/**
 * Memory-pack selection (KF-B) — the "injection judgment" v1.
 * Heuristic, no ML: score = typeWeight · recency · importance,
 * take top-N under a token budget, render grouped Markdown.
 * Recency half-life 30 days mirrors search freshness decay.
 */

import type { DB } from '../storage/db.js';

export interface PackOptions {
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

  // Atom v3 (ADR-001): invalidated memories (valid_to set) are excluded from
  // the injected pack — a superseded/dead memory must not surface in recall.
  const rows = db.prepare(`
    SELECT id, type, text, importance, created_at
    FROM memories
    WHERE repo = ? AND valid_to IS NULL
    ORDER BY created_at DESC
    LIMIT ?
  `).all(opts.repo, CANDIDATE_LIMIT) as Row[];

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
