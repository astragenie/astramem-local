// FEAT-480 — FTS5 AND-first, OR-fallback regression coverage.
//
// History: the original AND-join bug meant a plain multi-word
// natural-language query required EVERY token present in one memory to
// match at all (measured 0/50 candidates on real queries). A pure OR-join
// fix recovered that recall (MRR 0.548->0.650) but a real-store A/B showed
// it REGRESSED literal-keyword precision (MRR 0.950->0.800) and raised
// junk-in-top-5 (+6pp) — OR was diluting precise all-tokens-match rows with
// weak single-token ones even when the AND form already had good hits.
//
// The shipped strategy (buildFtsAnd / buildFtsOr in src/search/search.ts,
// gated in gatherCandidates): run AND first; only escalate to the
// stopword-stripped, cap-12 OR form when AND returns ZERO candidates. These
// tests pin: (1) AND-hit queries never see OR dilution, (2) AND-miss
// queries still recover via OR, (3) the all-stopword/operator-char/cap
// edge cases from the original fix still hold.

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

describe('FTS5 AND-first, OR-fallback (FEAT-480)', () => {
  it('AC: a literal all-tokens-present query is answered by the AND pass and is NOT diluted by weaker OR-only matches', async () => {
    const db = setupDb();
    const precise = seed(db, 'sqlite-vec hybrid search fusion notes', 'and-1');
    // Contains only ONE of the three query tokens — would surface under a
    // pure OR-join, but must NOT appear here because the AND pass already
    // found a hit and the OR fallback must never run.
    const weak = seed(db, 'fusion reactor design notes', 'and-2');

    const hits = await search('hybrid search fusion', {}, 10, {
      db, embed: fakeEmbed, weights: defaultConfig().search, mode: 'keyword', debug: true,
    });

    expect(hits).toHaveLength(1);
    expect(hits[0]!.id).toBe(precise);
    expect(hits.some(h => h.id === weak)).toBe(false);
  });

  it('AC: a plain multi-word natural-language query with NO all-tokens match still recovers via the OR fallback', async () => {
    const db = setupDb();
    const id = seed(db, 'the deployment pipeline pushes artifacts to the staging bucket', 'or-1');
    // Only 2 of these 6 query tokens ("deployment", "pipeline") appear in
    // the seeded memory — the AND pass draws a blank (no memory has ALL of
    // what/is/the/deployment/pipeline/for), so this must fall through to OR.
    const hits = await search('what is the deployment pipeline for', {}, 10, {
      db, embed: fakeEmbed, weights: defaultConfig().search, mode: 'keyword', debug: true,
    });

    expect(hits).toHaveLength(1);
    const hit = hits[0]!;
    expect(hit.id).toBe(id);
    expect(['fts', 'both']).toContain(hit.source);
    expect(hit.bm25.raw).not.toBeNull();
  });

  it('an all-stopword query falls back to a valid MATCH instead of throwing (AND and OR fallback coincide)', async () => {
    const db = setupDb();
    seed(db, 'unrelated memory content that should not match', 'or-2');

    // "what is this" is entirely stopwords once tokenized — buildFtsOr's
    // own fallback makes it identical to buildFtsAnd's output, so the
    // AND-miss -> OR-escalation path must still not throw or double-flood.
    await expect(
      search('what is this', {}, 10, {
        db, embed: fakeEmbed, weights: defaultConfig().search, mode: 'keyword', debug: true,
      })
    ).resolves.not.toThrow();

    const hits = await search('what is this', {}, 10, {
      db, embed: fakeEmbed, weights: defaultConfig().search, mode: 'keyword', debug: true,
    });
    // No memory contains this exact literal token-set — zero candidates is
    // the correct, non-throwing result (not a crash, not a flood).
    expect(hits).toEqual([]);
  });

  it('a single-word query is answered directly by the AND pass (no fallback needed, no trailing " OR ")', async () => {
    const db = setupDb();
    const id = seed(db, 'sqlite-vec hybrid search fusion notes', 'or-3');

    const hits = await search('fusion', {}, 10, {
      db, embed: fakeEmbed, weights: defaultConfig().search, mode: 'keyword', debug: true,
    });

    expect(hits).toHaveLength(1);
    expect(hits[0]!.id).toBe(id);
    expect(hits[0]!.bm25.raw).not.toBeNull();
  });

  it('operator-char sanitization holds through the OR fallback: hyphen, embedded quote, leading dash', async () => {
    const db = setupDb();
    const id = seed(db, 'sqlite-vec compatibility notes a"b edge case -foo marker', 'or-4');

    // None of these tokens are stopwords, so all three feed the OR fallback
    // once the AND pass (which requires "cat-dog" as a literal adjacent
    // phrase, absent here) draws a blank. Before FEAT-480 these characters
    // would throw a syntax error if not quoted; the quoting behavior itself
    // (only the join/fallback strategy changed) must still neutralize them.
    const hits = await search('cat-dog a"b -foo', {}, 10, {
      db, embed: fakeEmbed, weights: defaultConfig().search, mode: 'keyword', debug: true,
    });

    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits.some(h => h.id === id)).toBe(true);
  });

  it('cap boundary: the OR fallback includes exactly the 12th token and drops the 13th', async () => {
    const db = setupDb();
    // 12th token present -> must be included in the OR-join.
    const twelfth = seed(db, 'zzalpha12 marker only', 'cap-1');
    // 13th token present -> must be dropped (FTS_MAX_OR_TOKENS = 12), so
    // this memory must NOT match on it alone.
    const thirteenth = seed(db, 'zzalpha13 marker only', 'cap-2');

    const query = Array.from({ length: 13 }, (_, i) => `zzalpha${i + 1}`).join(' ');
    // No memory contains all 13 tokens -> AND pass draws a blank -> OR
    // fallback runs with the first 12 signal tokens only.
    const hits = await search(query, {}, 10, {
      db, embed: fakeEmbed, weights: defaultConfig().search, mode: 'keyword', debug: true,
    });

    expect(hits.some(h => h.id === twelfth)).toBe(true);
    expect(hits.some(h => h.id === thirteenth)).toBe(false);
  });

  it('stopword stripping is case-insensitive: uppercase "WHAT"/"The" are stripped just like lowercase', async () => {
    const db = setupDb();
    // Contains the literal word "what" but none of the real content terms.
    // If uppercase "WHAT" were NOT recognized as a stopword (case-sensitive
    // bug), it would leak into the OR-join and spuriously match this row.
    const stopwordLeak = seed(db, 'what a wonderful stopword testing memory', 'ci-1');
    const content = seed(db, 'the new widget deployment pipeline design', 'ci-2');

    // Mixed-case stopwords ("WHAT", "is", "the") alongside real content
    // words ("Widget", "pipeline"). No memory contains all 5 tokens -> AND
    // draws a blank -> OR fallback runs.
    const hits = await search('WHAT is the Widget pipeline', {}, 10, {
      db, embed: fakeEmbed, weights: defaultConfig().search, mode: 'keyword', debug: true,
    });

    expect(hits.some(h => h.id === content)).toBe(true);
    expect(hits.some(h => h.id === stopwordLeak)).toBe(false);
  });
});
