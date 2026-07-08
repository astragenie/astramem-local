/**
 * Read-only queries powering the "why" provenance receipt and "session
 * digest" surfaces. Shared between the HTTP routes (server/routes/why.ts,
 * server/routes/digest.ts) and the MCP tools (mcp/server.ts: why_memory,
 * session_digest) so the two transports never drift on shape or query
 * shaping. Extracted here so tests can exercise them independently of
 * either transport layer.
 */

import type { DB } from '../../storage/db.js';
import { MemoryRepo } from '../../storage/memories.js';
import { MemoryEventRepo } from '../../storage/memory-events.js';
import type { MemoryEvent } from '../../storage/memory-events.js';

// ---------------------------------------------------------------------------
// why_memory / GET /memory/:id/why
// ---------------------------------------------------------------------------

export interface SessionBlock {
  id: string;
  repo: string | null;
  branch: string | null;
  agent: string | null;
  started_at: number;
}

export interface WhyReceipt {
  id: string;
  type: string;
  text: string;
  importance: number;
  confidence: number;
  evidence: unknown;
  session: SessionBlock | null;
  transcript_ref: unknown;
  created_at: number;
  history: MemoryEvent[];
}

/**
 * Builds the provenance receipt for a memory atom: the atom itself, its
 * source session block (if any), and its lifecycle history. Returns null
 * when the memory does not exist — callers shape the not-found response
 * for their own transport (HTTP 404 vs MCP isError).
 */
export function buildWhyReceipt(db: DB, id: string): WhyReceipt | null {
  const memory = new MemoryRepo(db).get(id);
  if (!memory) return null;

  let session: SessionBlock | null = null;
  if (memory.session_id) {
    session = (db
      .prepare('SELECT id, repo, branch, agent, started_at FROM sessions WHERE id = ?')
      .get(memory.session_id) as SessionBlock | undefined) ?? null;
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

// ---------------------------------------------------------------------------
// session_digest / GET /sessions/:id/digest
// ---------------------------------------------------------------------------

export interface DigestMemRow {
  id: string;
  type: string;
  text: string;
}

export interface SessionDigest {
  session_id: string;
  status: 'pending' | 'ready' | 'partial';
  poison_jobs: number;
  counts: Record<string, number>;
  memories: DigestMemRow[];
}

/**
 * Builds the "what I learned this session" digest for a session id.
 * Derived at read time from memories(session_id); no stored digest state.
 * status=pending while a distill job for this session is queued/running.
 * status=partial when no job is active but at least one distill job for
 * this session permanently failed (state='poison', retries exhausted) —
 * that session's content was never extracted into memories, so 'ready'
 * would be a silent under-count (see scripts/eval/longmemeval/README.md,
 * "Known daemon-side gap: poison distill jobs report as ready"). Additive
 * `poison_jobs` count accompanies it; both fields are additive relative to
 * the pre-existing {pending, ready} x counts/memories shape so existing
 * consumers reading status/counts/memories are unaffected.
 * Does not verify the session itself exists — callers that need a 404/isError
 * on an unknown session id check that separately (HTTP route does; the MCP
 * tool does too for an explicit session_id — FEAT-417a harmonization — and
 * otherwise defaults to the latest session, which is always guaranteed to
 * exist since it was just read from the table).
 */
export function buildSessionDigest(db: DB, sessionId: string): SessionDigest {
  // A distill job for this session still queued or running → pending.
  // json_extract (SQLite JSON1, bundled with better-sqlite3) — exact match,
  // immune to LIKE-wildcard injection and payload key reordering.
  const activeJob = db.prepare(`
    SELECT id FROM jobs
    WHERE kind = 'distill' AND state IN ('pending', 'running')
      AND json_extract(payload_json, '$.session_id') = ?
    LIMIT 1
  `).get(sessionId);

  const poisonJobs = (db.prepare(`
    SELECT COUNT(*) AS n FROM jobs
    WHERE kind = 'distill' AND state = 'poison'
      AND json_extract(payload_json, '$.session_id') = ?
  `).get(sessionId) as { n: number }).n;

  const rows = db.prepare(
    'SELECT id, type, text FROM memories WHERE session_id = ? ORDER BY created_at ASC'
  ).all(sessionId) as DigestMemRow[];

  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.type] = (counts[r.type] ?? 0) + 1;

  const status: SessionDigest['status'] = activeJob
    ? 'pending'
    : poisonJobs > 0
      ? 'partial'
      : 'ready';

  return {
    session_id: sessionId,
    status,
    poison_jobs: poisonJobs,
    counts,
    memories: rows,
  };
}
