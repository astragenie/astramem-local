// FEAT-401: `as_of` temporal search — SQL filter on valid_from/valid_to,
// integrated with the existing supersede/event-log join (ADR-001 bitemporal
// columns). See .claude/artifacts/loop/backlog/triaged/FEAT-401.md for the
// hardened Given/When/Then ACs this file implements.

import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { MemoryRepo } from '../../src/storage/memories.js';
import { search, makeFakeVec, validityFilterClause, parseAsOf } from '../../src/search/search.js';
import type { EmbedProvider } from '../../src/contracts/index.js';

function buildMockEmbed(): EmbedProvider {
  return {
    name: 'ollama' as const,
    model: 'mock',
    dim: 1024 as const,
    embed: async (texts: string[]) => texts.map(t => makeFakeVec(t)),
    health: async () => ({ ok: true, model: 'mock', dim: 1024 as const }),
  };
}

const SEARCH_WEIGHTS = { alpha: 0.4, beta: 0.4, gamma: 0.1, delta: 0.1 };

/** Directly set a memory's bitemporal validity window + supersede pointer —
 *  mirrors the eval harness fixture-seeding pattern so tests are deterministic
 *  instead of racing Date.now(). */
function setValidity(db: DB, id: string, validFrom: number, validTo: number | null, supersededBy: string | null = null): void {
  db.prepare('UPDATE memories SET valid_from = ?, valid_to = ?, superseded_by = ? WHERE id = ?')
    .run(validFrom, validTo, supersededBy, id);
}

describe('validityFilterClause (shared SQL filter, FEAT-401)', () => {
  it('with no as_of, returns the pre-FEAT-401 snapshot clause unchanged', () => {
    expect(validityFilterClause(undefined)).toEqual({ clause: 'valid_to IS NULL', params: [] });
  });

  it('with as_of, returns the half-open bitemporal window clause', () => {
    expect(validityFilterClause(1000)).toEqual({
      clause: 'valid_from <= ? AND (valid_to IS NULL OR valid_to > ?)',
      params: [1000, 1000],
    });
  });
});

describe('parseAsOf', () => {
  it('parses an ISO-8601 date-time to epoch ms', () => {
    expect(parseAsOf('2026-06-10T00:00:00.000Z')).toBe(Date.parse('2026-06-10T00:00:00.000Z'));
  });

  it('returns undefined for absent/empty value', () => {
    expect(parseAsOf(undefined)).toBeUndefined();
    expect(parseAsOf('')).toBeUndefined();
  });

  it('throws for an unparseable value', () => {
    expect(() => parseAsOf('not-a-date')).toThrow(/invalid as_of/);
  });
});

describe('FEAT-401: as_of temporal search', () => {
  let db: DB;
  let repo: MemoryRepo;
  const t0 = 1_800_000_000_000; // fixed base instant — deterministic, no Date.now() races
  const t1 = t0 + 1000;
  const t2 = t0 + 2000;
  const t3 = t0 + 3000;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    repo = new MemoryRepo(db);
  });

  function insertFact(text: string, hash: string): string {
    return repo.insert({
      type: 'decision', text, normalized_text: text.toLowerCase(),
      repo: 'r1', project: null, branch: null, agent: null, session_id: null,
      hash, source_hash: null, importance: 0.8,
    });
  }

  // AC-1: Given a memory superseded at time T2 by a newer fact, When
  // search/recall runs with as_of=T1 (T1 < T2), Then the pre-supersede
  // memory is returned and the post-T2 fact is not.
  it('AC-1: as_of before the supersede instant returns the pre-supersede memory, not the successor', async () => {
    const oldId = insertFact('adopt postgres canonical store decision', 'as-of-ac1-old');
    const newId = insertFact('adopt postgres canonical store decision refined', 'as-of-ac1-new');
    setValidity(db, oldId, t0, t2, newId);
    setValidity(db, newId, t2, null);

    const hits = await search('postgres canonical store decision', { as_of: t1 }, 10, {
      db, embed: buildMockEmbed(), weights: SEARCH_WEIGHTS,
    });
    const ids = hits.map(h => h.id);
    expect(ids).toContain(oldId);
    expect(ids).not.toContain(newId);
  });

  it('AC-1 (post-window): as_of after the supersede instant returns the successor, not the old memory', async () => {
    const oldId = insertFact('adopt postgres canonical store decision', 'as-of-ac1b-old');
    const newId = insertFact('adopt postgres canonical store decision refined', 'as-of-ac1b-new');
    setValidity(db, oldId, t0, t2, newId);
    setValidity(db, newId, t2, null);

    const hits = await search('postgres canonical store decision', { as_of: t3 }, 10, {
      db, embed: buildMockEmbed(), weights: SEARCH_WEIGHTS,
    });
    const ids = hits.map(h => h.id);
    expect(ids).toContain(newId);
    expect(ids).not.toContain(oldId);
  });

  // AC-2: Given no as_of param, When search/recall runs, Then results are
  // byte-identical to current behavior (snapshot test passes unchanged).
  it('AC-2: no as_of param — snapshot behavior unchanged (only currently-valid rows surface)', async () => {
    const oldId = insertFact('adopt postgres canonical store decision', 'as-of-ac2-old');
    const newId = insertFact('adopt postgres canonical store decision refined', 'as-of-ac2-new');
    setValidity(db, oldId, t0, t2, newId);
    setValidity(db, newId, t2, null);

    const withoutAsOf = await search('postgres canonical store decision', {}, 10, {
      db, embed: buildMockEmbed(), weights: SEARCH_WEIGHTS,
    });
    const idsNoFilter = withoutAsOf.map(h => h.id);
    expect(idsNoFilter).toContain(newId);
    expect(idsNoFilter).not.toContain(oldId);

    // Explicitly passing as_of: undefined must be indistinguishable from
    // omitting the key entirely — same object shape callers already use.
    const withUndefinedAsOf = await search('postgres canonical store decision', { as_of: undefined }, 10, {
      db, embed: buildMockEmbed(), weights: SEARCH_WEIGHTS,
    });
    expect(withUndefinedAsOf.map(h => h.id)).toEqual(idsNoFilter);
  });

  // AC-5: Given a fact with 3+ supersession generations, When as_of targets
  // each generation's validity window, Then exactly the generation valid at
  // that instant is returned (no cross-window leakage into the
  // supersede/event-log join).
  it('AC-5: 3+ supersession generations — as_of resolves exactly the generation valid at that instant', async () => {
    const g1 = insertFact('rerank strategy: cross-encoder off', 'as-of-ac5-g1');
    const g2 = insertFact('rerank strategy: cross-encoder shadow mode', 'as-of-ac5-g2');
    const g3 = insertFact('rerank strategy: cross-encoder on, staged rollout', 'as-of-ac5-g3');

    // g1 valid [t0,t1) -> g2 valid [t1,t2) -> g3 valid [t2, null)
    setValidity(db, g1, t0, t1, g2);
    setValidity(db, g2, t1, t2, g3);
    setValidity(db, g3, t2, null);

    const opts = { db, embed: buildMockEmbed(), weights: SEARCH_WEIGHTS };

    const atG1 = await search('rerank strategy cross-encoder', { as_of: t0 + 500 }, 10, opts);
    expect(atG1.map(h => h.id)).toContain(g1);
    expect(atG1.map(h => h.id)).not.toContain(g2);
    expect(atG1.map(h => h.id)).not.toContain(g3);

    const atG2 = await search('rerank strategy cross-encoder', { as_of: t1 + 500 }, 10, opts);
    expect(atG2.map(h => h.id)).toContain(g2);
    expect(atG2.map(h => h.id)).not.toContain(g1);
    expect(atG2.map(h => h.id)).not.toContain(g3);

    const atG3 = await search('rerank strategy cross-encoder', { as_of: t2 + 500 }, 10, opts);
    expect(atG3.map(h => h.id)).toContain(g3);
    expect(atG3.map(h => h.id)).not.toContain(g1);
    expect(atG3.map(h => h.id)).not.toContain(g2);

    // Exact boundary instants: the generation taking over at the transition
    // instant is the one considered valid (half-open interval semantics) —
    // no leakage of the outgoing generation into the new window.
    const atT1Exact = await search('rerank strategy cross-encoder', { as_of: t1 }, 10, opts);
    expect(atT1Exact.map(h => h.id)).toContain(g2);
    expect(atT1Exact.map(h => h.id)).not.toContain(g1);

    const atT2Exact = await search('rerank strategy cross-encoder', { as_of: t2 }, 10, opts);
    expect(atT2Exact.map(h => h.id)).toContain(g3);
    expect(atT2Exact.map(h => h.id)).not.toContain(g2);
  });
});
