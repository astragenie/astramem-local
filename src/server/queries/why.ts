/**
 * Shared provenance-receipt query (FEAT-417a) — the single source of truth
 * for both GET /memory/:id/why and the why_memory MCP tool. Previously each
 * surface reimplemented this lookup independently with no test forcing
 * agreement; extracting it here means the route and the MCP tool are
 * structurally incapable of drifting apart.
 *
 * Returns null when the memory does not exist — callers translate that into
 * their own not-found idiom (HTTP 404 vs MCP isError).
 */

import type { DB } from '../../storage/db.js';
import { MemoryRepo } from '../../storage/memories.js';
import { MemoryEventRepo } from '../../storage/memory-events.js';
import type { MemoryEvent } from '../../storage/memory-events.js';
import type { MemoryType } from '../../contracts/index.js';

export interface WhySessionBlock {
  id: string;
  repo: string | null;
  branch: string | null;
  agent: string | null;
  started_at: number;
}

export interface WhyReceipt {
  id: string;
  type: MemoryType;
  text: string;
  importance: number;
  confidence: number;
  evidence: string | null;
  session: WhySessionBlock | null;
  transcript_ref: string | null;
  created_at: number;
  history: MemoryEvent[];
}

export function getWhyReceipt(db: DB, id: string): WhyReceipt | null {
  const memory = new MemoryRepo(db).get(id);
  if (!memory) return null;

  let session: WhySessionBlock | null = null;
  if (memory.session_id) {
    session = (db
      .prepare('SELECT id, repo, branch, agent, started_at FROM sessions WHERE id = ?')
      .get(memory.session_id) as WhySessionBlock | undefined) ?? null;
  }

  return {
    id: memory.id,
    type: memory.type,
    text: memory.text,
    importance: memory.importance,
    confidence: memory.confidence,
    evidence: memory.evidence,
    session,
    transcript_ref: memory.source_hash,
    created_at: memory.created_at,
    history: new MemoryEventRepo(db).listForAtom(id),
  };
}
