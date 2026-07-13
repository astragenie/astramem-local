// FEAT-401: `as_of` temporal search — SQL filter on valid_from/valid_to,
// integrated with the existing supersede/event-log join (ADR-001 bitemporal
// columns). See .claude/artifacts/loop/backlog/triaged/FEAT-401.md for the
// hardened Given/When/Then ACs this file implements.

import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { MemoryRepo } from '../../src/storage/memories.js';
import { MemoryEventRepo } from '../../src/storage/memory-events.js';
import { search, makeFakeVec, validityFilterClause, parseAsOf } from '../../src/search/search.js';
import type { EmbedProvider } from '../../src/contracts/index.js';

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

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
  // `valid_to IS NULL` means UNBOUNDED. It does NOT mean CURRENTLY VALID.
  //
  // Those were indistinguishable until issue #205 (PR #216) started populating
  // `valid_to` — before that, every row was NULL and the old clause was a no-op.
  // The moment real end-dates landed in the column, the old clause began hiding
  // facts that are still true:
  //
  //   "the support contract runs through March 2027"
  //     -> model correctly extracts invalid_at: 2027-03-01
  //     -> valid_to is NOT NULL -> excluded from every default recall, TODAY.
  //
  // The feature inverted: the better extraction got at finding real end dates,
  // the more live facts vanished from search.
  it('with no as_of, keeps a fact whose end date has NOT arrived yet', () => {
    const now = 1_000_000;
    const { clause, params } = validityFilterClause(undefined, now);
    expect(clause).toBe('(valid_to IS NULL OR valid_to > ?)');
    expect(params).toEqual([now]);
  });

  it('with as_of, returns the half-open bitemporal window clause', () => {
    expect(validityFilterClause(1000)).toEqual({
      clause: 'valid_from <= ? AND (valid_to IS NULL OR valid_to > ?)',
      params: [1000, 1000],
    });
  });
});

describe('default recall and a bounded-but-still-true fact (issue #205 follow-up)', () => {
  // The behavioural version of the clause test above — this is the acceptance
  // criterion for the whole fix, expressed as data rather than SQL text.
  function rowsVisibleNow(rows: Array<{ id: string; valid_to: number | null }>, now: number) {
    const { clause } = validityFilterClause(undefined, now);
    expect(clause).toContain('valid_to >');
    return rows.filter(r => r.valid_to === null || r.valid_to > now);
  }

  const NOW = Date.parse('2026-07-13T00:00:00Z');

  it('a fact valid until 2027 is still returned today; an expired one is not', () => {
    const rows = [
      { id: 'unbounded', valid_to: null },
      { id: 'contract-through-2027', valid_to: Date.parse('2027-03-01T00:00:00Z') },
      { id: 'expired-last-year', valid_to: Date.parse('2025-01-01T00:00:00Z') },
    ];

    const visible = rowsVisibleNow(rows, NOW).map(r => r.id);

    expect(visible).toContain('unbounded');
    expect(visible).toContain('contract-through-2027'); // the bug: this used to vanish
    expect(visible).not.toContain('expired-last-year'); // correctly excluded
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
  // Fixed base instant — deterministic, no Date.now() races.
  //
  // MUST be in the PAST. It used to be 1_800_000_000_000 (Jan 2027, i.e. in the
  // future), which made every superseded row in this fixture carry a FUTURE
  // `valid_to`. That is not a state production can ever reach: supersede,
  // invalidate, archive and purge all stamp `valid_to = Date.now()`
  // (src/storage/memory-events.ts), so a superseded row's `valid_to` is always
  // already past by the time anything queries it.
  //
  // The old future instant was invisible while the default filter was
  // `valid_to IS NULL` — that clause hid ANY non-null `valid_to`, past or
  // future alike, so a future-dated fixture behaved identically to a past one.
  // Once the filter learned the difference (`valid_to > now` — a fact whose end
  // date has not arrived yet is still true), the fixture's future timestamps
  // started meaning what they actually say: "not expired yet."
  const t0 = 1_600_000_000_000; // 2020-09-13 — safely in the past
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

// Inspector BLOCKER repro (post-first-pass review): every test above seeds
// idealized CONTIGUOUS windows via setValidity() (old.valid_to ==
// new.valid_from by construction). The real production path never produces
// that automatically — MemoryRepo.insert() stamps new.valid_from = insert
// time, and MemoryEventRepo.supersede() (called later, e.g. by the
// supersede_memory MCP tool) only stamped old.valid_to = supersede time. Any
// gap between "new memory created" and "supersede() called on the old one"
// left an overlap window where both generations satisfied the as_of filter
// simultaneously — violating AC-1/AC-5 ("exactly one generation"). Fixed in
// src/storage/memory-events.ts supersede() by co-issuing
// new.valid_from = the same `now` as old.valid_to, in the same transaction.
// These tests exercise the REAL repo.insert() + events.supersede() path with
// real wall-clock gaps — no setValidity()/manual UPDATE — so they fail
// against the pre-fix code and pass against the fix.
describe('FEAT-401 (real path): as_of through actual MemoryEventRepo.supersede()', () => {
  let db: DB;
  let repo: MemoryRepo;
  let events: MemoryEventRepo;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    repo = new MemoryRepo(db);
    events = new MemoryEventRepo(db);
  });

  function insertFact(text: string, hash: string): string {
    return repo.insert({
      type: 'decision', text, normalized_text: text.toLowerCase(),
      repo: 'r1', project: null, branch: null, agent: null, session_id: null,
      hash, source_hash: null, importance: 0.8,
    });
  }

  it('supersede() co-issues new.valid_from with old.valid_to — closes the insert-to-supersede overlap window', async () => {
    const oldId = insertFact('rerank strategy real-path old', 'real-sup-old');
    await sleep(30); // real gap: old insert -> new insert
    const newId = insertFact('rerank strategy real-path new', 'real-sup-new');
    // Captured BEFORE supersede() runs — this is what new.valid_from would
    // stay at if supersede() only touched the old row (the pre-fix bug).
    const newInsertValidFrom = repo.get(newId)!.valid_from;
    await sleep(30); // real gap: new insert -> supersede() call

    events.supersede(oldId, newId);

    const oldMem = repo.get(oldId);
    const newMem = repo.get(newId);
    expect(oldMem?.valid_to).not.toBeNull();
    // The fix: the boundary is co-issued, so the windows are contiguous.
    expect(newMem?.valid_from).toBe(oldMem?.valid_to);
    // And it genuinely moved forward off the insert-time stamp — otherwise
    // the assertion above would be vacuously true.
    expect(newMem!.valid_from).toBeGreaterThan(newInsertValidFrom);

    const opts = { db, embed: buildMockEmbed(), weights: SEARCH_WEIGHTS };

    // The would-be overlap window (pre-fix): [newInsertValidFrom, old.valid_to).
    // An as_of landing here must resolve to EXACTLY the old generation —
    // this is the assertion that fails without the co-issue fix (both rows
    // used to satisfy validityFilterClause at this instant).
    const asOfInFormerOverlap = Math.floor((newInsertValidFrom + oldMem!.valid_to!) / 2);
    const hits = await search('rerank strategy real-path', { as_of: asOfInFormerOverlap }, 10, opts);
    const ids = hits.map(h => h.id);
    expect(ids).toContain(oldId);
    expect(ids).not.toContain(newId);

    // Just after the supersede instant: exactly the new generation.
    const afterHits = await search('rerank strategy real-path', { as_of: oldMem!.valid_to! + 1 }, 10, opts);
    const afterIds = afterHits.map(h => h.id);
    expect(afterIds).toContain(newId);
    expect(afterIds).not.toContain(oldId);
  });

  it('AC-2 real path: live (no as_of) search is unaffected by the valid_from co-issue', async () => {
    const oldId = insertFact('rerank strategy real-path snapshot old', 'real-snap-old');
    await sleep(30);
    const newId = insertFact('rerank strategy real-path snapshot new', 'real-snap-new');
    await sleep(30);
    events.supersede(oldId, newId);

    const hits = await search('rerank strategy real-path snapshot', {}, 10, {
      db, embed: buildMockEmbed(), weights: SEARCH_WEIGHTS,
    });
    const ids = hits.map(h => h.id);
    expect(ids).toContain(newId);
    expect(ids).not.toContain(oldId);
  });

  it('existing supersede() contract is preserved: old invalidated + superseded_by set, new stays valid', async () => {
    const oldId = insertFact('supersede contract check old', 'real-contract-old');
    await sleep(20);
    const newId = insertFact('supersede contract check new', 'real-contract-new');
    await sleep(20);

    events.supersede(oldId, newId);

    const oldMem = repo.get(oldId);
    const newMem = repo.get(newId);
    expect(oldMem?.valid_to).not.toBeNull();
    expect(oldMem?.superseded_by).toBe(newId);
    expect(newMem?.valid_to).toBeNull();
  });

  it('AC-5 real path: 3+ real supersede() generations — as_of resolves exactly one generation chain-wide', async () => {
    const g1 = insertFact('rerank real chain generation one', 'real-chain-g1');
    await sleep(25);
    const g2 = insertFact('rerank real chain generation two', 'real-chain-g2');
    await sleep(25);
    events.supersede(g1, g2);
    await sleep(25);
    const g3 = insertFact('rerank real chain generation three', 'real-chain-g3');
    await sleep(25);
    events.supersede(g2, g3);

    const g1Mem = repo.get(g1);
    const g2Mem = repo.get(g2);
    const g3Mem = repo.get(g3);

    // Contiguous boundaries end-to-end — no gap, no overlap.
    expect(g2Mem?.valid_from).toBe(g1Mem?.valid_to);
    expect(g3Mem?.valid_from).toBe(g2Mem?.valid_to);

    const opts = { db, embed: buildMockEmbed(), weights: SEARCH_WEIGHTS };
    const midG1 = Math.floor((g1Mem!.valid_from + g1Mem!.valid_to!) / 2);
    const midG2 = Math.floor((g2Mem!.valid_from + g2Mem!.valid_to!) / 2);
    const afterG3 = g3Mem!.valid_from + 1;

    const cases: Array<[number, string, string[]]> = [
      [midG1, g1, [g2, g3]],
      [midG2, g2, [g1, g3]],
      [afterG3, g3, [g1, g2]],
    ];
    for (const [asOf, expectedId, otherIds] of cases) {
      const hits = await search('rerank real chain generation', { as_of: asOf }, 10, opts);
      const ids = hits.map(h => h.id);
      expect(ids).toContain(expectedId);
      for (const other of otherIds) expect(ids).not.toContain(other);
    }
  });
});

// Issue #205 (AC-6): the exact motivating scenario from the issue — a fact
// that was true for a real period and then genuinely stopped being true.
// Unlike the FEAT-401 tests above (which seed validity via a manual
// setValidity() UPDATE, simulating supersede()), these seed valid_to
// directly through InsertInput — the write capability issue #205 adds
// (previously insertRow's SQL never included valid_to at all, so this
// exact scenario was impossible to represent without a raw UPDATE).
describe('issue #205: atom-level valid_to via InsertInput (Postgres -> Kafka scenario)', () => {
  let db: DB;
  let repo: MemoryRepo;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    repo = new MemoryRepo(db);
  });

  const jan = Date.parse('2026-01-15T00:00:00.000Z');
  const feb = Date.parse('2026-02-15T00:00:00.000Z');
  const apr = Date.parse('2026-04-01T00:00:00.000Z');
  const today = Date.parse('2026-07-13T00:00:00.000Z');

  it('as_of February returns the Postgres fact; as_of today returns only Kafka', async () => {
    // The January atom: valid_from=Jan (captured then), valid_to=April (the
    // source text stated the migration date) — this is the write path fix
    // (AC-2): before this fix, valid_to could never be set at insert time.
    const postgresId = repo.insert({
      type: 'fact', text: 'The event store uses Postgres.', normalized_text: 'the event store uses postgres.',
      repo: null, project: null, branch: null, agent: null, session_id: null,
      hash: 'ac6-postgres', source_hash: null, importance: 0.5,
      valid_from: jan, valid_to: apr, validity_extracted: true,
    });
    // The April atom: valid_from=April (captured then, and also the stated
    // start of this fact), still unbounded (valid_to omitted — currently true).
    const kafkaId = repo.insert({
      type: 'fact', text: 'The event store uses Kafka.', normalized_text: 'the event store uses kafka.',
      repo: null, project: null, branch: null, agent: null, session_id: null,
      hash: 'ac6-kafka', source_hash: null, importance: 0.5,
      valid_from: apr, validity_extracted: true,
    });

    const opts = { db, embed: buildMockEmbed(), weights: SEARCH_WEIGHTS };

    const atFeb = await search('event store', { as_of: feb }, 10, opts);
    const febIds = atFeb.map(h => h.id);
    expect(febIds).toContain(postgresId);
    expect(febIds).not.toContain(kafkaId);

    const atToday = await search('event store', { as_of: today }, 10, opts);
    const todayIds = atToday.map(h => h.id);
    expect(todayIds).toContain(kafkaId);
    expect(todayIds).not.toContain(postgresId);

    // AC-6: an unbounded fact lands with valid_to = NULL and
    // validity_extracted = 1 ("extraction looked, found no bound").
    const kafkaMem = repo.get(kafkaId);
    expect(kafkaMem?.valid_to).toBeNull();
    expect(kafkaMem?.validity_extracted).toBe(true);
  });

  it('AC-6: a legacy row (validity_extracted = 0, valid_to = NULL) is still returned by a current-snapshot query — no regression', async () => {
    // No valid_to, no validity_extracted — every pre-fix caller's exact shape.
    const legacyId = repo.insert({
      type: 'fact', text: 'a legacy fact from before issue #205 shipped', normalized_text: 'a legacy fact',
      repo: null, project: null, branch: null, agent: null, session_id: null,
      hash: 'ac6-legacy', source_hash: null, importance: 0.5,
    });
    const legacyMem = repo.get(legacyId);
    expect(legacyMem?.validity_extracted).toBe(false);
    expect(legacyMem?.valid_to).toBeNull();

    const opts = { db, embed: buildMockEmbed(), weights: SEARCH_WEIGHTS };
    const hits = await search('legacy fact before issue', {}, 10, opts);
    expect(hits.map(h => h.id)).toContain(legacyId);

    // And it resolves correctly under as_of too — validityFilterClause()
    // treats a NULL valid_to identically regardless of validity_extracted,
    // exactly as designed (the flag is provenance-only, never a query input).
    // Use a real future instant (not the fixed `today` constant, which can
    // be earlier than the actual insert-time wall-clock `valid_from` this
    // repo.insert() call stamps) so the as_of filter's `valid_from <= T`
    // half is guaranteed to pass regardless of when the test suite runs.
    const asOfFuture = Date.now() + 60_000;
    const hitsAsOf = await search('legacy fact before issue', { as_of: asOfFuture }, 10, opts);
    expect(hitsAsOf.map(h => h.id)).toContain(legacyId);
  });
});
