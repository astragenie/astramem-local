// P0.2 (2026-07-20 retrieval overhaul plan, Wave 0): escapeFtsQuery()
// (src/search/search.ts) used to turn EVERY token — including stopwords
// like "when"/"did"/"the" — into its own quoted phrase, joined by bare
// whitespace. FTS5 implicit-ANDs adjacent phrases, so a natural-language
// question needed literally every one of its words (stopwords included)
// present verbatim in the target row to match at all — the FTS leg (40% of
// the default fusion weight, `alpha`) returned zero candidates for most real
// questions. This file proves the fix: stopwords/interrogatives are dropped,
// survivors are OR'd (any one genuine content term is enough to match), and
// user-supplied quoted phrases are preserved verbatim.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { openDb, type DB } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { MemoryRepo } from '../../src/storage/memories.js';
import { search, makeFakeVec } from '../../src/search/search.js';
import type { EmbedProvider } from '../../src/contracts/index.js';

const SEARCH_WEIGHTS = { alpha: 0.4, beta: 0.4, gamma: 0.1, delta: 0.1 };

function setupDb(): DB {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

function seed(db: DB, text: string, hash: string): string {
  return new MemoryRepo(db).insert({
    type: 'fact', text, normalized_text: text.toLowerCase(),
    repo: 'r1', project: null, branch: null, agent: null,
    session_id: null, hash, source_hash: null,
  });
}

function buildMockEmbed(): EmbedProvider {
  return {
    name: 'ollama', model: 'mock', dim: 1024,
    embed: async (texts: string[]) => texts.map(t => makeFakeVec(t)),
    health: async () => ({ ok: true, model: 'mock', dim: 1024 }),
  };
}

/** Captures every FTS5 MATCH statement's bound query param, in call order —
 *  same pattern as tests/search/query-prefix.test.ts's captureFtsMatchParams. */
function captureFtsMatchParams(db: DB): string[] {
  const captured: string[] = [];
  const originalPrepare = db.prepare.bind(db);
  vi.spyOn(db, 'prepare').mockImplementation(((sql: string) => {
    const stmt = originalPrepare(sql);
    if (sql.includes('memories_fts')) {
      const originalAll = stmt.all.bind(stmt);
      stmt.all = ((...args: unknown[]) => {
        captured.push(String(args[0]));
        return originalAll(...(args as []));
      }) as typeof stmt.all;
    }
    return stmt;
  }) as typeof db.prepare);
  return captured;
}

describe('P0.2: analyzed FTS lexical query — MATCH string construction', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('drops interrogatives/stopwords and OR-joins the surviving content terms', async () => {
    const db = setupDb();
    seed(db, 'unrelated fixture row so FTS5 has something to query against', 'aq-1');
    const captured = captureFtsMatchParams(db);

    await search('When did Caroline go to the support group?', {}, 10, {
      db, embed: buildMockEmbed(), weights: SEARCH_WEIGHTS, mode: 'keyword',
    });

    expect(captured).toHaveLength(1);
    // "when"/"did"/"to"/"the" are stopped; "caroline"/"go"/"support"/"group"
    // survive, OR'd together, punctuation-stripped and lowercased.
    expect(captured[0]).toBe('"caroline" OR "go" OR "support" OR "group"');
  });

  it('preserves a user-supplied quoted phrase as one unit, not stopword-filtered or split', async () => {
    const db = setupDb();
    seed(db, 'unrelated fixture row', 'aq-2');
    const captured = captureFtsMatchParams(db);

    await search('what is the "support group" schedule', {}, 10, {
      db, embed: buildMockEmbed(), weights: SEARCH_WEIGHTS, mode: 'keyword',
    });

    expect(captured).toHaveLength(1);
    // "what"/"is"/"the" dropped; the quoted phrase kept whole (including its
    // own stopword "group" — quoting is explicit user intent); "schedule" survives.
    expect(captured[0]).toBe('"support group" OR "schedule"');
  });

  it('a single exact term (e.g. an error code) still matches unchanged — FEAT-480 AC-5 shape preserved', async () => {
    const db = setupDb();
    seed(db, 'unrelated fixture row', 'aq-3');
    const captured = captureFtsMatchParams(db);

    await search('7777', {}, 10, { db, embed: buildMockEmbed(), weights: SEARCH_WEIGHTS, mode: 'keyword' });

    expect(captured).toHaveLength(1);
    expect(captured[0]).toBe('"7777"');
  });

  it('an all-stopword query falls back to the legacy all-tokens query instead of an empty/invalid MATCH string', async () => {
    const db = setupDb();
    seed(db, 'unrelated fixture row', 'aq-4');
    const captured = captureFtsMatchParams(db);

    await search('what is this', {}, 10, { db, embed: buildMockEmbed(), weights: SEARCH_WEIGHTS, mode: 'keyword' });

    expect(captured).toHaveLength(1);
    expect(captured[0]).toBe('"what" "is" "this"');
  });

  it('a hyphenated token stays syntax-safe (still quoted, no bare "-" reaches FTS5)', async () => {
    const db = setupDb();
    seed(db, 'we use sqlite-vec for vector storage', 'aq-5');
    const captured = captureFtsMatchParams(db);

    const res = await search('what is sqlite-vec', {}, 10, {
      db, embed: buildMockEmbed(), weights: SEARCH_WEIGHTS, mode: 'keyword',
    });

    expect(captured).toHaveLength(1);
    expect(captured[0]).toBe('"sqlite-vec"');
    // Must not throw fts5 syntax error near "-" — a non-empty successful
    // result (or at minimum a clean empty array) proves the query executed.
    expect(Array.isArray(res)).toBe(true);
  });
});

describe('P0.2: a LoCoMo-style natural-language question now surfaces non-zero FTS candidates (regression fixture: the old AND-query returned zero)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("'When did Caroline go to the support group?' matches a memory that does NOT contain every query word verbatim", async () => {
    const db = setupDb();
    // This row deliberately does NOT contain "when", "did", "to", or "the"
    // as a literal token near "support group" — under the pre-P0.2 all-
    // tokens-ANDed query, this candidate (and the FTS leg entirely) would
    // never surface. It DOES contain "caroline", "support", and "group".
    const targetId = seed(
      db,
      'Caroline started attending a support group every Tuesday evening in 2023',
      'aq-locomo-1',
    );
    // Decoy row sharing none of the survivors, to prove this isn't a
    // vacuous single-row match.
    seed(db, 'completely unrelated topic about sourdough starter maintenance', 'aq-locomo-2');

    const hits = await search('When did Caroline go to the support group?', {}, 10, {
      db, embed: buildMockEmbed(), weights: SEARCH_WEIGHTS, mode: 'keyword',
    });

    expect(hits.length).toBeGreaterThan(0);
    expect(hits.map(h => h.id)).toContain(targetId);
    expect(hits[0]!.source).toBe('fts');
  });
});
