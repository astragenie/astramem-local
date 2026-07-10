/**
 * User Profile (read-time synthesized daemon-wide profile) — FEAT-451 slice 1.
 * Answers: "what does this daemon's owner keep coming back to" — rolled up
 * from the existing 7 local atom kinds, zero schema change (design doc §1,
 * `docs/specs/FEAT-451-profile-design.md`).
 *
 * v1 rollup mapping (source type -> profile section), per the design doc:
 *   fact     -> standing_facts
 *   note     -> preferences   (extract.ts's own type-priority doc calls note
 *                               out for "opinions, preferences, or style
 *                               remarks" — the closest existing semantic match)
 *   lesson   -> recurring_lessons
 *   decision -> recent_decisions
 *   memory_entities (kind IN actor/tech/product/tool) -> known_entities
 *
 * Shared between GET /profile (server/routes/profile.ts) and the MCP
 * user_profile tool (mcp/server.ts) so both transports stay in sync — same
 * pattern as buildAgentProfile/buildSessionDigest.
 *
 * Scope: ACTIVE memories only (valid_to IS NULL AND archived = 0, the same
 * "currently valid" predicate every other read surface uses), no `agent`
 * filter — this profile is daemon-wide, not per-agent. Defaults to
 * scope='private' per ADR-009; an explicit `scope` of 'team'/'org'/'all'
 * widens the filter (design doc §3 — no per-caller authz exists to check
 * beyond the single global Bearer, so this is the caller's own choice, not a
 * privilege escalation).
 *
 * Live-computed, no cache, no persisted document (design doc §2) — every
 * call is a fresh SQL read, so there is no staleness window and no rebuild
 * step to keep in sync.
 *
 * Ranking: the three scored sections (standing_facts/preferences/
 * recurring_lessons) reuse usefulnessScores() (src/storage/usefulness.ts,
 * ADR-010 Laplace-smoothed (used+1)/(used+corrected+2)) — the same formula
 * agent-profile.ts's top_lessons and the fusion epsilon component use, not a
 * reinvented one. Sort key is `usefulness DESC, importance DESC, id ASC` —
 * the trailing `id ASC` is a total tie-break required for ADR-005 eval-gate
 * determinism (design doc §5): ties are common on freshly-distilled atoms
 * that still sit at the neutral 0.5 usefulness default. recent_decisions and
 * known_entities carry their own deterministic tie-breaks for the same
 * reason (created_at/id and mention_count/name respectively) even though the
 * design doc only calls out the three scored sections by name — a partial
 * order anywhere in the response would still make AC-6 flaky.
 */

import type { DB } from '../../storage/db.js';
import { usefulnessScores } from '../../storage/usefulness.js';
import { childLogger } from '../../log/logger.js';

export type ProfileScope = 'private' | 'team' | 'org' | 'all';

const VALID_PROFILE_SCOPES: readonly ProfileScope[] = ['private', 'team', 'org', 'all'];

export function isValidProfileScope(value: string): value is ProfileScope {
  return (VALID_PROFILE_SCOPES as readonly string[]).includes(value);
}

export interface ProfileScoredItem {
  id: string;
  text: string;
  importance: number;
  usefulness: number;
  evidence: string | null;
  created_at: number;
}

export interface ProfileDecisionItem {
  id: string;
  text: string;
  importance: number;
  created_at: number;
}

export interface ProfileEntity {
  name: string;
  kind: string;
  mention_count: number;
}

export interface UserProfile {
  scope: ProfileScope;
  generated_at: number;
  standing_facts: ProfileScoredItem[];
  preferences: ProfileScoredItem[];
  recurring_lessons: ProfileScoredItem[];
  recent_decisions: ProfileDecisionItem[];
  known_entities: ProfileEntity[];
  /** Active-memory counts for the four source types this profile rolls up. */
  counts: Record<string, number>;
  /** Sum of `counts`. */
  total: number;
}

/** "Currently valid" predicate, optionally qualified with a table alias (for
 *  the known_entities join, where `memories` is aliased `m`). */
function activeClause(alias?: string): string {
  const p = alias ? `${alias}.` : '';
  return `${p}valid_to IS NULL AND ${p}archived = 0`;
}

const SOURCE_TYPES = ['fact', 'note', 'lesson', 'decision'] as const;
// design doc §1 known_entities source-kind filter — "grounding context",
// deliberately narrower than the full extract.ts entity-kind vocabulary
// (actor|team|org|project|product|workitem|decision|tech|tool|concept|event|other).
const KNOWN_ENTITY_KINDS = ['actor', 'tech', 'product', 'tool'] as const;

const SECTION_CAP = 10;
const RECENT_DECISIONS_CAP = 5;
const KNOWN_ENTITIES_CAP = 10;

interface ScoredRow {
  id: string;
  text: string;
  importance: number;
  evidence: string | null;
  created_at: number;
}

/** `AND [alias.]scope = ?` for a concrete scope, or no filter at all for 'all'. */
function scopeClause(scope: ProfileScope, alias?: string): { clause: string; params: string[] } {
  if (scope === 'all') return { clause: '', params: [] };
  const p = alias ? `${alias}.` : '';
  return { clause: `AND ${p}scope = ?`, params: [scope] };
}

function querySectionCounts(db: DB, scope: ProfileScope): Record<string, number> {
  const { clause, params } = scopeClause(scope);
  const placeholders = SOURCE_TYPES.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT type, COUNT(*) AS count
    FROM memories
    WHERE ${activeClause()} AND type IN (${placeholders}) ${clause}
    GROUP BY type
  `).all(...SOURCE_TYPES, ...params) as Array<{ type: string; count: number }>;

  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.type] = r.count;
  return counts;
}

/**
 * One of the three usefulness-ranked sections (standing_facts/preferences/
 * recurring_lessons) — same query + rank shape as agent-profile.ts's
 * queryTopLessons, generalized to any single source type and scope-filtered
 * instead of agent-filtered. Returns rowsRead (pre-cap row count) alongside
 * the capped items, for AC-5's atom_count_consumed observability field.
 */
function queryScoredSection(
  db: DB,
  type: (typeof SOURCE_TYPES)[number],
  scope: ProfileScope,
): { items: ProfileScoredItem[]; rowsRead: number } {
  const { clause, params } = scopeClause(scope);
  const rows = db.prepare(`
    SELECT id, text, importance, evidence, created_at
    FROM memories
    WHERE ${activeClause()} AND type = ? ${clause}
  `).all(type, ...params) as ScoredRow[];

  if (rows.length === 0) return { items: [], rowsRead: 0 };

  const usefulness = usefulnessScores(db, rows.map(r => r.id));

  const items = rows
    .map(r => ({
      id: r.id,
      text: r.text,
      importance: r.importance,
      usefulness: usefulness.get(r.id) ?? 0.5,
      evidence: r.evidence,
      created_at: r.created_at,
    }))
    .sort((a, b) =>
      b.usefulness - a.usefulness ||
      b.importance - a.importance ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    )
    .slice(0, SECTION_CAP);

  return { items, rowsRead: rows.length };
}

/**
 * recent_decisions — no usefulness scoring, newest-first, matches
 * agent-profile.ts's queryRecentDecisions shape exactly (design doc §2).
 * Fetches all matching rows (rather than SQL-side LIMIT) so rowsRead
 * reflects the pre-cap count for AC-5, same trade-off queryScoredSection
 * makes — cheap at this daemon's local scale.
 */
function queryRecentDecisions(
  db: DB,
  scope: ProfileScope,
): { items: ProfileDecisionItem[]; rowsRead: number } {
  const { clause, params } = scopeClause(scope);
  const rows = db.prepare(`
    SELECT id, text, importance, created_at
    FROM memories
    WHERE ${activeClause()} AND type = 'decision' ${clause}
  `).all(...params) as ProfileDecisionItem[];

  const items = rows
    .slice()
    .sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, RECENT_DECISIONS_CAP);

  return { items, rowsRead: rows.length };
}

/**
 * known_entities — grounding rollup over memory_entities for currently-active
 * memories, restricted to KNOWN_ENTITY_KINDS (design doc §1), ranked by
 * mention count.
 */
function queryKnownEntities(
  db: DB,
  scope: ProfileScope,
): { items: ProfileEntity[]; rowsRead: number } {
  const { clause, params } = scopeClause(scope, 'm');
  const kindPlaceholders = KNOWN_ENTITY_KINDS.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT e.name AS name, e.kind AS kind, COUNT(*) AS mention_count
    FROM memory_entities me
    JOIN entities e ON e.id = me.entity_id
    JOIN memories m ON m.id = me.memory_id
    WHERE ${activeClause('m')} AND e.kind IN (${kindPlaceholders}) ${clause}
    GROUP BY e.name, e.kind
  `).all(...KNOWN_ENTITY_KINDS, ...params) as ProfileEntity[];

  const items = rows
    .slice()
    .sort((a, b) => b.mention_count - a.mention_count || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .slice(0, KNOWN_ENTITIES_CAP);

  return { items, rowsRead: rows.length };
}

/**
 * Builds the daemon-wide user profile for `scope` (defaults to 'private',
 * ADR-009's own default). Pure SQL aggregation, no embedding/LLM call in the
 * read path (design doc §5/§6) — deterministic under the ADR-005 fake-embedder
 * eval harness by construction.
 */
export function buildUserProfile(db: DB, scope: ProfileScope = 'private'): UserProfile {
  const start = Date.now();

  const standingFacts = queryScoredSection(db, 'fact', scope);
  const preferences = queryScoredSection(db, 'note', scope);
  const recurringLessons = queryScoredSection(db, 'lesson', scope);
  const recentDecisions = queryRecentDecisions(db, scope);
  const knownEntities = queryKnownEntities(db, scope);
  const counts = querySectionCounts(db, scope);
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);

  const atomCountConsumed =
    standingFacts.rowsRead +
    preferences.rowsRead +
    recurringLessons.rowsRead +
    recentDecisions.rowsRead +
    knownEntities.rowsRead;

  const profile: UserProfile = {
    scope,
    generated_at: start,
    standing_facts: standingFacts.items,
    preferences: preferences.items,
    recurring_lessons: recurringLessons.items,
    recent_decisions: recentDecisions.items,
    known_entities: knownEntities.items,
    counts,
    total,
  };

  // AC-5 observability — build-cost only, no staleness metric (every read is
  // fresh by construction, see file header).
  childLogger({ component: 'user-profile' }).info(
    {
      duration_ms: Date.now() - start,
      atom_count_consumed: atomCountConsumed,
      scope,
      section_counts: {
        standing_facts: standingFacts.items.length,
        preferences: preferences.items.length,
        recurring_lessons: recurringLessons.items.length,
        recent_decisions: recentDecisions.items.length,
        known_entities: knownEntities.items.length,
      },
    },
    'user profile built',
  );

  return profile;
}
