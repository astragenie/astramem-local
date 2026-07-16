// issue #352B (Ask B gap 2, wave plan W1-D): properly-superseded atoms are
// already hard-hidden by validityFilterClause. The narrower gap is atoms
// that are CORRECTED but not yet superseded — a `kind='contradiction'`
// consolidation proposal exists (the judge detected a contradiction) but no
// supersede edge has been created, so the loser atom still surfaces in
// ordinary recall. These tests pin `correction_pending`, the marker search()
// surfaces for exactly that gap, and its independence from `search.theta`
// (the governed 8th fusion weight, shipped at 0 — see fuse.ts/config.ts).

import { describe, it, expect } from 'vitest';
import { openDb, type DB } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { MemoryRepo } from '../../src/storage/memories.js';
import { search, makeFakeVec } from '../../src/search/search.js';
import type { EmbedProvider } from '../../src/contracts/index.js';
import { defaultConfig } from '../../src/config/config.js';

const fakeEmbed: EmbedProvider = {
  name: 'ollama' as const,
  model: 'fake',
  dim: 1024 as const,
  embed: async (texts: string[]) => texts.map(t => makeFakeVec(t)),
  health: async () => ({ ok: true, model: 'fake', dim: 1024 as const }),
};

function seed(db: DB, text: string, hash: string): string {
  return new MemoryRepo(db).insert({
    type: 'fact', text, normalized_text: text.toLowerCase(),
    repo: 'r1', project: null, branch: null, agent: null,
    session_id: null, hash, source_hash: null,
  });
}

function insertPendingContradiction(db: DB, winnerId: string, loserId: string, confidence = 0.9): string {
  const id = `contra-${loserId}`;
  db.prepare(`
    INSERT INTO consolidation_proposals (id, kind, winner_id, loser_id, similarity, status, created_at, metadata_json)
    VALUES (?, 'contradiction', ?, ?, ?, 'pending', ?, ?)
  `).run(
    id, winnerId, loserId, 0.7, Date.now(),
    JSON.stringify({ verdict: 'contradicts', confidence, winner_excerpt: 'w', loser_excerpt: 'l' }),
  );
  return id;
}

function setupDb(): DB {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

describe('search() correction_pending marker (issue #352B)', () => {
  it('flags only the loser side of an OPEN pending contradiction proposal', async () => {
    const db = setupDb();
    const winnerId = seed(db, 'the default port is now 8888', 'h-winner');
    const loserId = seed(db, 'the default port is 7777', 'h-loser');
    const unrelatedId = seed(db, 'default port unrelated note', 'h-unrelated');
    const proposalId = insertPendingContradiction(db, winnerId, loserId, 0.83);

    const hits = await search('default port', {}, 10, {
      db, embed: fakeEmbed, weights: defaultConfig().search,
    });

    const winnerHit = hits.find(h => h.id === winnerId);
    const loserHit = hits.find(h => h.id === loserId);
    const unrelatedHit = hits.find(h => h.id === unrelatedId);

    expect(loserHit?.correction_pending).toEqual({
      proposal_id: proposalId, winner_id: winnerId, confidence: 0.83,
    });
    expect(winnerHit?.correction_pending).toBeUndefined();
    expect(unrelatedHit?.correction_pending).toBeUndefined();
  });

  it('is populated at the shipped default theta=0 — the marker does not depend on the fusion weight', async () => {
    const db = setupDb();
    const winnerId = seed(db, 'meeting starts at 9am sharp', 'h-w2');
    const loserId = seed(db, 'meeting starts at 10am sharp', 'h-l2');
    insertPendingContradiction(db, winnerId, loserId);

    expect(defaultConfig().search.theta).toBe(0);
    const hits = await search('meeting starts sharp', {}, 10, {
      db, embed: fakeEmbed, weights: defaultConfig().search,
    });
    expect(hits.find(h => h.id === loserId)?.correction_pending).toBeDefined();
  });

  it('a RESOLVED (accepted) contradiction proposal no longer flags the loser — only an OPEN one does', async () => {
    const db = setupDb();
    const winnerId = seed(db, 'release cadence is weekly now', 'h-w3');
    const loserId = seed(db, 'release cadence is monthly now', 'h-l3');
    const proposalId = insertPendingContradiction(db, winnerId, loserId);
    db.prepare(`UPDATE consolidation_proposals SET status = 'accepted', resolved_at = ? WHERE id = ?`)
      .run(Date.now(), proposalId);

    const hits = await search('release cadence now', {}, 10, {
      db, embed: fakeEmbed, weights: defaultConfig().search,
    });
    expect(hits.find(h => h.id === loserId)?.correction_pending).toBeUndefined();
  });

  it('a pending MERGE proposal (kind != contradiction) never flags either side', async () => {
    const db = setupDb();
    const winnerId = seed(db, 'timeout value is thirty seconds', 'h-w5');
    const loserId = seed(db, 'timeout value is thirty secs', 'h-l5');
    db.prepare(`
      INSERT INTO consolidation_proposals (id, kind, winner_id, loser_id, similarity, status, created_at)
      VALUES ('merge-5', 'merge', ?, ?, ?, 'pending', ?)
    `).run(winnerId, loserId, 0.95, Date.now());

    const hits = await search('timeout value', {}, 10, {
      db, embed: fakeEmbed, weights: defaultConfig().search,
    });
    expect(hits.find(h => h.id === loserId)?.correction_pending).toBeUndefined();
    expect(hits.find(h => h.id === winnerId)?.correction_pending).toBeUndefined();
  });

  it('theta>0 surfaces a correction_freshness explanation signal; theta=0 (default) never does', async () => {
    const db = setupDb();
    const winnerId = seed(db, 'staging url changed to v2', 'h-w6');
    const loserId = seed(db, 'staging url changed to v1', 'h-l6');
    insertPendingContradiction(db, winnerId, loserId);

    const defaultHits = await search('staging url changed', {}, 10, {
      db, embed: fakeEmbed, weights: defaultConfig().search,
    });
    const loserAtDefault = defaultHits.find(h => h.id === loserId);
    expect(loserAtDefault?.correction_pending).toBeDefined();
    expect(loserAtDefault?.explanation.signals.correction_freshness).toBeUndefined();

    const boostedHits = await search('staging url changed', {}, 10, {
      db, embed: fakeEmbed, weights: { ...defaultConfig().search, theta: 0.3 },
    });
    const loserBoosted = boostedHits.find(h => h.id === loserId);
    const winnerBoosted = boostedHits.find(h => h.id === winnerId);
    // Flagged loser gets uncontestedBonus 0 -> raw 0 in the signal.
    expect(loserBoosted?.explanation.signals.correction_freshness?.raw).toBe(0);
    // Unflagged winner defaults to uncontestedBonus 1 -> raw 1 in the signal.
    expect(winnerBoosted?.explanation.signals.correction_freshness?.raw).toBe(1);
  });

  // Review finding 4 (PR #378): the NULL/malformed metadata_json fallback to
  // confidence 0 was implemented (correctionSignalForCandidates's try/catch
  // and the `if (row.metadata_json)` guard) but untested until now.
  it('falls back to confidence:0 when metadata_json is NULL or malformed JSON, without dropping the marker', async () => {
    const db = setupDb();
    const winnerId = seed(db, 'cache ttl is now sixty seconds', 'h-w7');
    const nullMetaLoserId = seed(db, 'cache ttl is thirty seconds', 'h-l7');
    const malformedMetaLoserId = seed(db, 'cache ttl is fifteen seconds', 'h-l8');

    db.prepare(`
      INSERT INTO consolidation_proposals (id, kind, winner_id, loser_id, similarity, status, created_at, metadata_json)
      VALUES ('contra-null-meta', 'contradiction', ?, ?, ?, 'pending', ?, NULL)
    `).run(winnerId, nullMetaLoserId, 0.7, Date.now());
    db.prepare(`
      INSERT INTO consolidation_proposals (id, kind, winner_id, loser_id, similarity, status, created_at, metadata_json)
      VALUES ('contra-bad-meta', 'contradiction', ?, ?, ?, 'pending', ?, ?)
    `).run(winnerId, malformedMetaLoserId, 0.7, Date.now(), '{not valid json');

    const hits = await search('cache ttl seconds', {}, 10, {
      db, embed: fakeEmbed, weights: defaultConfig().search,
    });

    const nullMetaHit = hits.find(h => h.id === nullMetaLoserId);
    const malformedMetaHit = hits.find(h => h.id === malformedMetaLoserId);
    expect(nullMetaHit?.correction_pending).toEqual({
      proposal_id: 'contra-null-meta', winner_id: winnerId, confidence: 0,
    });
    expect(malformedMetaHit?.correction_pending).toEqual({
      proposal_id: 'contra-bad-meta', winner_id: winnerId, confidence: 0,
    });
  });
});

// Review finding 1 (PR #378): correctionSignalForCandidates() ran unindexed
// against consolidation_proposals on EVERY search()/recall() call — the only
// pre-existing index (migration 008's partial UNIQUE dedup guard) doesn't
// cover (kind, status, loser_id). migrations/051 adds a purpose-built
// partial index; this pins that the query planner actually rides it rather
// than full-scanning the table.
describe('consolidation_proposals loser-id lookup uses the migration-051 partial index', () => {
  it('EXPLAIN QUERY PLAN reports idx_consolidation_proposals_pending_contradiction_loser, not a full scan', () => {
    const db = setupDb();
    // Query text copied verbatim from correctionSignalForCandidates
    // (src/search/search.ts) — SQLite's partial-index matching requires the
    // query's WHERE clause to syntactically match the index's own WHERE
    // clause (same lesson as migration 045's doc comment).
    const plan = db.prepare(`
      EXPLAIN QUERY PLAN
      SELECT id, winner_id, loser_id, metadata_json FROM consolidation_proposals
      WHERE kind = 'contradiction' AND status = 'pending' AND loser_id IN (?, ?)
    `).all('a', 'b') as Array<{ detail: string }>;
    expect(plan.some(p => p.detail.includes('idx_consolidation_proposals_pending_contradiction_loser'))).toBe(true);
    expect(plan.some(p => /SCAN consolidation_proposals\b/.test(p.detail))).toBe(false);
  });
});
