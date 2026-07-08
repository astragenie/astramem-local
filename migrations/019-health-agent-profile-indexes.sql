-- 019: two independent index-only fixes from the 2026-07-08 perf baseline
-- (docs/perf/2026-07-08-baseline.md, candidates #2 and #3). Both are pure
-- additive indexes -- no column changes, no behavior change.

-- Fix A (#2): GET /health does an unindexed full scan of memory_events on
-- every call via usefulnessRate() (src/storage/usefulness.ts:168), which
-- runs two `SELECT COUNT(DISTINCT atom_id) ... WHERE event_type='usefulness'
-- AND json_extract(payload_json,'$.family') = <'recall_served'|'recall_used'>
-- AND created_at >= ?` queries. The only existing memory_events index is
-- (atom_id, seq) (migrations 007, 013) -- it doesn't cover event_type or
-- created_at, and a json_extract() predicate can't ride a plain B-tree index
-- regardless. Measured 21ms -> 1179ms p50 from 1k -> 100k rows (genuinely
-- O(N), since memory_events grows ~1:1 with memories created).
--
-- Same technique as migration 018 (partial expression index): 'family' is
-- fixed per query (never a bound parameter), so a partial index keyed on the
-- exact family literal lets SQLite prove the query's WHERE clause implies
-- the index's own WHERE clause and pick it up as a range scan on created_at.
-- (created_at, atom_id) makes each index covering for the
-- COUNT(DISTINCT atom_id) ... created_at >= ? shape -- no memory_events
-- table lookups needed, just an index-only scan restricted to the matching
-- family. One index per family (rather than a single index keyed on the
-- family value) because 'family' only ever appears as a literal-equality
-- predicate at every real call site (health.ts, dashboard.ts, doctor
-- checks.ts all call usefulnessRate() with no `surface` option) -- there is
-- no query that needs to range over families, so a materialized column
-- would add write-path cost for no read-path benefit here.
CREATE INDEX idx_memory_events_usefulness_served ON memory_events(created_at, atom_id)
  WHERE event_type = 'usefulness' AND json_extract(payload_json, '$.family') = 'recall_served';

CREATE INDEX idx_memory_events_usefulness_used ON memory_events(created_at, atom_id)
  WHERE event_type = 'usefulness' AND json_extract(payload_json, '$.family') = 'recall_used';

-- Fix B (#3): GET /agents/:agent/profile -- missing index on memories.agent.
-- buildAgentProfile() (src/server/queries/agent-profile.ts) issues 4+
-- separate `WHERE agent = ?` queries against memories (existence probe,
-- per-type counts, first/last-seen, top-lessons, recent-decisions), and
-- memories only has indexes on (repo, type, created_at) and (session_id) --
-- none on agent. Measured 2.97ms (1k) -> 8.98ms (10k) -> 236.94ms (100k, a
-- ~26x cliff for the same 10x data growth the earlier step handled at ~3x).
--
-- Column order mirrors the ACTIVE_CLAUSE ('agent = ? AND valid_to IS NULL
-- AND archived = 0') + type equality + created_at ordering that
-- queryCountsByType/queryTopLessons/queryRecentDecisions all share: agent,
-- valid_to, archived as the equality prefix, then type (equality for
-- lessons/decisions, GROUP BY for counts), then created_at DESC to serve
-- queryRecentDecisions's ORDER BY without a separate sort. queryFirstLastSeen
-- (MIN/MAX(created_at) WHERE agent = ?, no valid_to/archived filter) and the
-- existence probe (SELECT 1 WHERE agent = ? LIMIT 1) still benefit from the
-- same index via its agent-prefix alone -- an index range-scan restricted to
-- one agent's rows instead of a full table scan.
CREATE INDEX idx_memories_agent ON memories(agent, valid_to, archived, type, created_at DESC);
