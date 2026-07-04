/**
 * Shared session-digest query (FEAT-417a) — the single source of truth for
 * both GET /sessions/:id/digest and the session_digest MCP tool. Previously
 * each surface reimplemented this lookup independently: notably the MCP tool
 * did not verify an explicitly-passed session_id actually existed (it only
 * error'd when no sessions existed at all for the auto-resolve path), while
 * the REST route always 404s on an unknown session_id. Extracting one shared
 * function harmonizes that gap — both surfaces now agree that an unknown
 * explicit session_id is a not-found, not an empty-but-"ready" digest.
 *
 * Derived at read time from memories(session_id); no stored digest state.
 * status='pending' while a distill job for this session is queued/running.
 *
 * Returns null when the session does not exist — callers translate that into
 * their own not-found idiom (HTTP 404 vs MCP isError).
 */

import type { DB } from '../../storage/db.js';

export interface DigestMemRow {
  id: string;
  type: string;
  text: string;
}

export interface SessionDigest {
  session_id: string;
  status: 'pending' | 'ready';
  counts: Record<string, number>;
  memories: DigestMemRow[];
}

export function getSessionDigest(db: DB, sessionId: string): SessionDigest | null {
  const session = db.prepare('SELECT id FROM sessions WHERE id = ?').get(sessionId);
  if (!session) return null;

  // A distill job for this session still queued or running → pending.
  // json_extract (SQLite JSON1, bundled with better-sqlite3) — exact match,
  // immune to LIKE-wildcard injection and payload key reordering.
  const activeJob = db.prepare(`
    SELECT id FROM jobs
    WHERE kind = 'distill' AND state IN ('pending', 'running')
      AND json_extract(payload_json, '$.session_id') = ?
    LIMIT 1
  `).get(sessionId);

  const rows = db.prepare(
    'SELECT id, type, text FROM memories WHERE session_id = ? ORDER BY created_at ASC'
  ).all(sessionId) as DigestMemRow[];

  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.type] = (counts[r.type] ?? 0) + 1;

  return {
    session_id: sessionId,
    status: activeJob ? 'pending' : 'ready',
    counts,
    memories: rows,
  };
}

/** Most recently started session id, or null if no sessions are recorded. */
export function getLatestSessionId(db: DB): string | null {
  const latest = db
    .prepare('SELECT id FROM sessions ORDER BY started_at DESC LIMIT 1')
    .get() as { id: string } | undefined;
  return latest?.id ?? null;
}
