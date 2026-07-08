/**
 * Agent Profile (read-time synthesized per-agent profile) — "what has agent
 * X learned". Answers: given `memories.agent`, what lessons has this agent
 * banked, what decisions has it made recently, and where has it previously
 * been wrong?
 *
 * Shared between GET /agents/:agent/profile (server/routes/agents.ts) and the
 * MCP agent_profile tool (mcp/server.ts) so both transports stay in sync —
 * same pattern as buildWhyReceipt/buildSessionDigest in provenance.ts.
 *
 * Scope: ACTIVE memories only (valid_to IS NULL AND archived = 0 — the same
 * "currently valid" predicate queryEntityLinkage/archival.ts use) for
 * top_lessons, recent_decisions, and the type-count rollup. `corrections` is
 * necessarily an exception: it surfaces memories THIS agent previously wrote
 * that later turned out wrong (invalidated/superseded), so it queries the
 * memory_events log directly and is not restricted to currently-active rows.
 *
 * Ranking: top_lessons reuses usefulnessScores() (src/storage/usefulness.ts)
 * — the exact ADR-010 Laplace-smoothed (used+1)/(used+corrected+2) signal the
 * fusion epsilon component consumes in src/search/fuse.ts — then breaks ties
 * by importance. This is deliberately the same formula, not a reinvented one:
 * two components computing "usefulness" differently would silently drift.
 */

import type { DB } from '../../storage/db.js';
import { MemoryRepo } from '../../storage/memories.js';
import { usefulnessScores } from '../../storage/usefulness.js';

export interface AgentProfileLesson {
  id: string;
  text: string;
  importance: number;
  usefulness: number;
  created_at: number;
}

export interface AgentProfileDecision {
  id: string;
  text: string;
  importance: number;
  created_at: number;
}

export type CorrectionActionLabel = 'invalidated' | 'superseded';

export interface AgentProfileCorrection {
  id: string;
  type: string;
  text: string;
  action: CorrectionActionLabel;
  reason: string | null;
  superseded_by: string | null;
  /** Text of the memory that replaced this one, when linkable (null if the
   *  successor was itself since deleted, or this correction is an invalidate
   *  with no successor). */
  superseding_text: string | null;
  corrected_at: number;
}

export interface AgentProfile {
  agent: string;
  /** Active-memory counts grouped by memories.type. */
  counts: Record<string, number>;
  /** Sum of `counts` — active memories for this agent. */
  total: number;
  /** Earliest created_at across ALL memories for this agent (active or not). */
  first_seen: number | null;
  /** Latest created_at across ALL memories for this agent (active or not). */
  last_active: number | null;
  top_lessons: AgentProfileLesson[];
  recent_decisions: AgentProfileDecision[];
  corrections: AgentProfileCorrection[];
}

const ACTIVE_CLAUSE = 'agent = ? AND valid_to IS NULL AND archived = 0';

interface ActiveLessonRow {
  id: string;
  text: string;
  importance: number;
  created_at: number;
}

interface ActiveDecisionRow {
  id: string;
  text: string;
  importance: number;
  created_at: number;
}

interface CorrectionRow {
  event_type: 'invalidate' | 'supersede';
  payload_json: string | null;
  event_created_at: number;
  memory_id: string;
  memory_type: string;
  memory_text: string;
  superseded_by: string | null;
}

const TOP_LESSONS_CAP = 10;
const RECENT_DECISIONS_CAP = 5;
const CORRECTIONS_CAP = 5;

function queryCountsByType(db: DB, agent: string): Record<string, number> {
  const rows = db.prepare(`
    SELECT type, COUNT(*) AS count
    FROM memories
    WHERE ${ACTIVE_CLAUSE}
    GROUP BY type
  `).all(agent) as Array<{ type: string; count: number }>;

  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.type] = r.count;
  return counts;
}

function queryFirstLastSeen(db: DB, agent: string): { first_seen: number | null; last_active: number | null } {
  const row = db.prepare(`
    SELECT MIN(created_at) AS first_seen, MAX(created_at) AS last_active
    FROM memories
    WHERE agent = ?
  `).get(agent) as { first_seen: number | null; last_active: number | null };
  return row;
}

function queryTopLessons(db: DB, agent: string): AgentProfileLesson[] {
  const rows = db.prepare(`
    SELECT id, text, importance, created_at
    FROM memories
    WHERE ${ACTIVE_CLAUSE} AND type = 'lesson'
  `).all(agent) as ActiveLessonRow[];

  if (rows.length === 0) return [];

  const usefulness = usefulnessScores(db, rows.map(r => r.id));

  return rows
    .map(r => ({
      id: r.id,
      text: r.text,
      importance: r.importance,
      usefulness: usefulness.get(r.id) ?? 0.5,
      created_at: r.created_at,
    }))
    .sort((a, b) => b.usefulness - a.usefulness || b.importance - a.importance)
    .slice(0, TOP_LESSONS_CAP);
}

function queryRecentDecisions(db: DB, agent: string): AgentProfileDecision[] {
  return db.prepare(`
    SELECT id, text, importance, created_at
    FROM memories
    WHERE ${ACTIVE_CLAUSE} AND type = 'decision'
    ORDER BY created_at DESC
    LIMIT ?
  `).all(agent, RECENT_DECISIONS_CAP) as ActiveDecisionRow[];
}

// Perf note (migrations 019/020, 2026-07-08 baseline candidate #3): this
// query's join order is sensitive to which side has the cheaper index. The
// memories.agent covering index (019) alone made the planner prefer driving
// from memories (agent=?) and nested-loop-probing memory_events per
// candidate row via the pre-existing (atom_id, seq) index — cheap for an
// agent with few memories, but O(agent's memory count) regardless of how
// many corrections actually exist, which regressed this query at 100k scale
// (measured ~215ms for an agent with 20k memories and zero corrections).
// Migration 020 adds a partial index on memory_events(event_type,
// created_at DESC, atom_id) so the planner again prefers driving from
// memory_events (filtered by event_type first, already in ORDER BY order)
// and probing memories by PK per matching event — the direction that's
// cheap precisely when corrections are rare, which is the common case. Do
// not add further indexes on memories.agent without re-checking this query's
// EXPLAIN QUERY PLAN — the two indexes' relative attractiveness to the
// planner is exactly what keeps this fast.
function queryCorrections(db: DB, agent: string): AgentProfileCorrection[] {
  const rows = db.prepare(`
    SELECT
      e.event_type   AS event_type,
      e.payload_json AS payload_json,
      e.created_at   AS event_created_at,
      m.id           AS memory_id,
      m.type         AS memory_type,
      m.text         AS memory_text,
      m.superseded_by AS superseded_by
    FROM memory_events e
    JOIN memories m ON m.id = e.atom_id
    WHERE m.agent = ? AND e.event_type IN ('invalidate', 'supersede')
    ORDER BY e.created_at DESC
    LIMIT ?
  `).all(agent, CORRECTIONS_CAP) as CorrectionRow[];

  if (rows.length === 0) return [];

  const memRepo = new MemoryRepo(db);
  // Cache successor lookups — a single successor can supersede at most one
  // predecessor, but stay defensive against repeat ids in a small cap-5 set.
  const successorTextCache = new Map<string, string | null>();
  const successorText = (id: string): string | null => {
    if (!successorTextCache.has(id)) {
      successorTextCache.set(id, memRepo.get(id)?.text ?? null);
    }
    return successorTextCache.get(id) ?? null;
  };

  return rows.map(r => {
    const payload = r.payload_json ? (JSON.parse(r.payload_json) as Record<string, unknown>) : null;
    const action: CorrectionActionLabel = r.event_type === 'invalidate' ? 'invalidated' : 'superseded';
    const reason = action === 'invalidated' && typeof payload?.['reason'] === 'string' ? (payload['reason'] as string) : null;
    const supersededBy = r.superseded_by ?? null;

    return {
      id: r.memory_id,
      type: r.memory_type,
      text: r.memory_text,
      action,
      reason,
      superseded_by: supersededBy,
      superseding_text: supersededBy ? successorText(supersededBy) : null,
      corrected_at: r.event_created_at,
    };
  });
}

/**
 * Builds the agent profile for `agent`. Returns null when the agent has zero
 * memories at all (active or not) — callers shape the not-found response for
 * their own transport (HTTP 404 vs MCP isError), same convention as
 * buildWhyReceipt.
 */
export function buildAgentProfile(db: DB, agent: string): AgentProfile | null {
  const anyRow = db.prepare('SELECT 1 FROM memories WHERE agent = ? LIMIT 1').get(agent);
  if (!anyRow) return null;

  const counts = queryCountsByType(db, agent);
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
  const { first_seen, last_active } = queryFirstLastSeen(db, agent);

  return {
    agent,
    counts,
    total,
    first_seen,
    last_active,
    top_lessons: queryTopLessons(db, agent),
    recent_decisions: queryRecentDecisions(db, agent),
    corrections: queryCorrections(db, agent),
  };
}
