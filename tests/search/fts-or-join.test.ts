// FEAT-480 — FTS5 OR-join regression coverage.
//
// escapeFtsQuery() used to AND-join every whitespace token into adjacent
// quoted phrases; FTS5 treats adjacent bare phrases as implicit AND, so a
// plain multi-word natural-language query required EVERY token present in
// one memory to match at all (measured 0/50 candidates on real queries).
// These tests pin the fix: OR-join over non-stopword tokens produces FTS
// candidates for a partial/multi-word match, and the all-stopword fallback
// still emits a valid (non-throwing) MATCH string.

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

function setupDb(): DB {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

describe('FTS5 OR-join (FEAT-480)', () => {
  it('a partial multi-word natural-language query yields FTS candidates (today: zero)', async () => {
    const db = setupDb();
    const id = seed(db, 'the deployment pipeline pushes artifacts to the staging bucket', 'or-1');
    // Only 2 of these 6+ query tokens ("deployment", "pipeline") actually
    // appear in the seeded memory — an AND-join over every token would never
    // match. The stopwords ("what", "is", "the", "for") must not be required.
    const hits = await search('what is the deployment pipeline for', {}, 10, {
      db, embed: fakeEmbed, weights: defaultConfig().search, mode: 'keyword', debug: true,
    });

    expect(hits).toHaveLength(1);
    const hit = hits[0]!;
    expect(hit.id).toBe(id);
    expect(['fts', 'both']).toContain(hit.source);
    expect(hit.bm25.raw).not.toBeNull();
  });

  it('an all-stopword query falls back to a valid MATCH instead of throwing', async () => {
    const db = setupDb();
    seed(db, 'unrelated memory content that should not match', 'or-2');

    // "what is this" is entirely stopwords once tokenized — escapeFtsQuery
    // must not emit an empty/invalid MATCH string here.
    await expect(
      search('what is this', {}, 10, {
        db, embed: fakeEmbed, weights: defaultConfig().search, mode: 'keyword', debug: true,
      })
    ).resolves.not.toThrow();

    const hits = await search('what is this', {}, 10, {
      db, embed: fakeEmbed, weights: defaultConfig().search, mode: 'keyword', debug: true,
    });
    // No memory contains this exact literal phrase-set — fallback is
    // AND-of-all-tokens, so zero candidates is the correct, non-throwing
    // result (not a crash, not a flood of every row in the corpus).
    expect(hits).toEqual([]);
  });

  it('a single-word query still produces a valid quoted MATCH (regression: no trailing " OR ")', async () => {
    const db = setupDb();
    const id = seed(db, 'sqlite-vec hybrid search fusion notes', 'or-3');

    const hits = await search('fusion', {}, 10, {
      db, embed: fakeEmbed, weights: defaultConfig().search, mode: 'keyword', debug: true,
    });

    expect(hits).toHaveLength(1);
    expect(hits[0]!.id).toBe(id);
  });

  it('operator-char sanitization still holds under OR-join: hyphen, embedded quote, leading dash', async () => {
    const db = setupDb();
    const id = seed(db, 'sqlite-vec compatibility notes a"b edge case -foo marker', 'or-4');

    // None of these tokens are stopwords, so all three feed the OR-join.
    // Before FEAT-480 these characters would throw a syntax error if not
    // quoted; the quoting behavior itself (only the join changed) must
    // still neutralize them.
    const hits = await search('cat-dog a"b -foo', {}, 10, {
      db, embed: fakeEmbed, weights: defaultConfig().search, mode: 'keyword', debug: true,
    });

    // "cat-dog" isn't present in the seeded text, but a"b and -foo are —
    // OR-join means this must return the row (and, critically, must not
    // throw an fts5 syntax error for any of the three tokens).
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits.some(h => h.id === id)).toBe(true);
  });
});
