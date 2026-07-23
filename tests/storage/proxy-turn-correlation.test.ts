/**
 * tests/storage/proxy-turn-correlation.test.ts
 *
 * FEAT-477: the independent SECOND implicit-usefulness heuristic — see
 * src/storage/proxy-turn-correlation.ts's module doc comment for the full
 * design rationale (no proxy-side session correlator exists, so this
 * measures time-proximity + text-overlap between a served atom and a later
 * `capture_source = 'proxy'` atom).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { MemoryRepo, type InsertInput } from '../../src/storage/memories.js';
import { MemoryEventRepo } from '../../src/storage/memory-events.js';
import { recordMemoryCorrected } from '../../src/storage/usefulness.js';
import {
  runProxyTurnCorrelationPass,
  proxyCorrelationSummary,
  PROXY_TURN_CORRELATION_BASIS,
  type ProxyTurnCorrelationOpts,
} from '../../src/storage/proxy-turn-correlation.js';

const NOW = 1_700_000_000_000; // fixed instant so window math is deterministic
const OPTS: ProxyTurnCorrelationOpts = {
  windowDays: 30,
  correlationWindowMs: 30 * 60 * 1000, // 30 minutes
  minOverlap: 0.5,
  maxGrantsPerRun: 500,
};

function insertMem(repo: MemoryRepo, hash: string, text: string, extra: Partial<InsertInput> = {}): string {
  return repo.insert({
    type: 'fact', text, normalized_text: text,
    repo: 'r1', project: null, branch: null, agent: null, session_id: null,
    hash, source_hash: null,
    ...extra,
  });
}

describe('runProxyTurnCorrelationPass', () => {
  let db: DB;
  let repo: MemoryRepo;
  let events: MemoryEventRepo;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    repo = new MemoryRepo(db);
    events = new MemoryEventRepo(db);
  });

  function servedAt(atomId: string, createdAt: number): void {
    events.append({
      event_type: 'usefulness', atom_id: atomId, created_at: createdAt,
      payload: { family: 'recall_served', query_hash: 'q', score: null, surface: 'rest', mode: null },
    });
  }

  function setCreatedAt(id: string, createdAt: number): void {
    db.prepare('UPDATE memories SET created_at = ? WHERE id = ?').run(createdAt, id);
  }

  // FEAT-477 AC: "handle proxy off gracefully — never a false signal."
  it('proxyActivityAbsent: true and grants nothing when no capture_source=proxy atoms exist at all', () => {
    const a = insertMem(repo, 'proxy-absent-a', 'postgres pool size is twenty connections');
    servedAt(a, NOW - 1000);

    const result = runProxyTurnCorrelationPass(db, OPTS, NOW);
    expect(result).toEqual({ candidates: 0, granted: 0, proxyActivityAbsent: true });
  });

  it('grants a heuristic recall_used event when a later proxy atom shares significant tokens within the window', () => {
    const served = insertMem(repo, 'proxy-match-served', 'postgres connection pool size is twenty for the checkout service');
    servedAt(served, NOW - 60_000);

    const proxyAtom = insertMem(repo, 'proxy-match-atom', 'the postgres connection pool size for checkout was raised', { capture_source: 'proxy' });
    setCreatedAt(proxyAtom, NOW - 30_000); // after serve, inside the 30-min window

    const result = runProxyTurnCorrelationPass(db, OPTS, NOW);
    expect(result).toEqual({ candidates: 1, granted: 1, proxyActivityAbsent: false });

    const grant = events.listForAtom(served).find(e => {
      const p = JSON.parse(e.payload_json ?? '{}');
      return p.family === 'recall_used';
    });
    const payload = JSON.parse(grant?.payload_json ?? '{}');
    expect(payload).toEqual({
      family: 'recall_used', surface: 'system', signal: 'heuristic', basis: PROXY_TURN_CORRELATION_BASIS,
    });
  });

  it('does not grant when the later proxy atom shares no significant tokens', () => {
    const served = insertMem(repo, 'proxy-nomatch-served', 'postgres connection pool size is twenty');
    servedAt(served, NOW - 60_000);

    const proxyAtom = insertMem(repo, 'proxy-nomatch-atom', 'the frontend build pipeline uses webpack now', { capture_source: 'proxy' });
    setCreatedAt(proxyAtom, NOW - 30_000);

    const result = runProxyTurnCorrelationPass(db, OPTS, NOW);
    expect(result).toEqual({ candidates: 1, granted: 0, proxyActivityAbsent: false });
  });

  it('does not match a proxy atom created BEFORE the atom was served', () => {
    const served = insertMem(repo, 'proxy-before-served', 'postgres connection pool size is twenty for checkout');
    servedAt(served, NOW - 1000);

    const proxyAtom = insertMem(repo, 'proxy-before-atom', 'postgres connection pool size for checkout was tuned', { capture_source: 'proxy' });
    setCreatedAt(proxyAtom, NOW - 60_000); // before the serve, not after

    const result = runProxyTurnCorrelationPass(db, OPTS, NOW);
    expect(result).toEqual({ candidates: 1, granted: 0, proxyActivityAbsent: false });
  });

  it('does not match a proxy atom created after the correlation window has elapsed', () => {
    const served = insertMem(repo, 'proxy-late-served', 'postgres connection pool size is twenty for checkout');
    servedAt(served, NOW - 60 * 60 * 1000); // served 1h ago

    const proxyAtom = insertMem(repo, 'proxy-late-atom', 'postgres connection pool size for checkout was tuned', { capture_source: 'proxy' });
    setCreatedAt(proxyAtom, NOW); // 1h after serve — well past the 30-min correlationWindowMs

    const result = runProxyTurnCorrelationPass(db, OPTS, NOW);
    expect(result).toEqual({ candidates: 1, granted: 0, proxyActivityAbsent: false });
  });

  // Mirrors runImplicitPositivePass's AC-3 (permanent-exclusion) posture.
  it('an atom with any memory_corrected event is excluded from candidates entirely', () => {
    const served = insertMem(repo, 'proxy-corrected-served', 'postgres connection pool size is twenty for checkout');
    servedAt(served, NOW - 60_000);
    recordMemoryCorrected(db, { atomId: served, action: 'demoted' });

    const proxyAtom = insertMem(repo, 'proxy-corrected-atom', 'postgres connection pool size for checkout was tuned', { capture_source: 'proxy' });
    setCreatedAt(proxyAtom, NOW - 30_000);

    const result = runProxyTurnCorrelationPass(db, OPTS, NOW);
    expect(result).toEqual({ candidates: 0, granted: 0, proxyActivityAbsent: false });
  });

  it('is idempotent — at most one grant per atom, ever; a second run finds zero new candidates', () => {
    const served = insertMem(repo, 'proxy-idempotent-served', 'postgres connection pool size is twenty for checkout');
    servedAt(served, NOW - 60_000);
    const proxyAtom = insertMem(repo, 'proxy-idempotent-atom', 'postgres connection pool size for checkout was tuned', { capture_source: 'proxy' });
    setCreatedAt(proxyAtom, NOW - 30_000);

    const first = runProxyTurnCorrelationPass(db, OPTS, NOW);
    expect(first).toEqual({ candidates: 1, granted: 1, proxyActivityAbsent: false });

    const second = runProxyTurnCorrelationPass(db, OPTS, NOW);
    expect(second).toEqual({ candidates: 0, granted: 0, proxyActivityAbsent: false });

    const grants = events.listForAtom(served).filter(e => {
      const p = JSON.parse(e.payload_json ?? '{}');
      return p.family === 'recall_used' && p.basis === PROXY_TURN_CORRELATION_BASIS;
    });
    expect(grants).toHaveLength(1);
  });

  // Deliberately DIFFERENT shape from runImplicitPositivePass: the overlap
  // test runs in JS after both SQL queries return, so maxGrantsPerRun caps
  // GRANTS, not the candidate count itself.
  it('caps grants at maxGrantsPerRun while candidates still reflects the full eligible count', () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const served = insertMem(repo, `proxy-cap-served-${i}`, 'postgres connection pool size is twenty for checkout');
      servedAt(served, NOW - 60_000);
      const proxyAtom = insertMem(repo, `proxy-cap-atom-${i}`, 'postgres connection pool size for checkout was tuned', { capture_source: 'proxy' });
      setCreatedAt(proxyAtom, NOW - 30_000);
      ids.push(served);
    }

    const result = runProxyTurnCorrelationPass(db, { ...OPTS, maxGrantsPerRun: 2 }, NOW);
    expect(result).toEqual({ candidates: 3, granted: 2, proxyActivityAbsent: false });
  });

  it('a served atom never "correlates" against itself even if it is capture_source=proxy and falls inside its own window', () => {
    const served = insertMem(repo, 'proxy-self-served', 'postgres connection pool size is twenty for checkout', { capture_source: 'proxy' });
    servedAt(served, NOW - 60_000);
    // Deliberately placed INSIDE the correlation window against its own
    // serve time, with byte-identical text (guaranteed overlap 1.0) — the
    // only capture_source='proxy' row in the DB is the served atom itself,
    // so without the `p.id !== candidate.atomId` guard this would
    // incorrectly grant purely from a self-match.
    setCreatedAt(served, NOW - 30_000);

    const result = runProxyTurnCorrelationPass(db, OPTS, NOW);
    expect(result).toEqual({ candidates: 1, granted: 0, proxyActivityAbsent: false });
  });

  it('respects maxCandidatesScanned as a defensive ceiling on recall_served rows considered', () => {
    for (let i = 0; i < 5; i++) {
      const served = insertMem(repo, `proxy-scancap-served-${i}`, 'postgres connection pool size is twenty for checkout');
      servedAt(served, NOW - 60_000);
    }
    const proxyAtom = insertMem(repo, 'proxy-scancap-atom', 'postgres connection pool size for checkout was tuned', { capture_source: 'proxy' });
    setCreatedAt(proxyAtom, NOW - 30_000);

    const result = runProxyTurnCorrelationPass(db, { ...OPTS, maxCandidatesScanned: 2 }, NOW);
    expect(result.candidates).toBe(2);
  });

  // Proves maxProxyAtomsScanned is a real bound, not a documented-but-unused
  // opt: an older, non-overlapping proxy atom occupies the one scan slot
  // (proxy atoms are read ORDER BY created_at ASC), so the later atom that
  // WOULD have matched is never even considered.
  it('respects maxProxyAtomsScanned as a defensive ceiling on proxy atoms considered', () => {
    const served = insertMem(repo, 'proxy-scancap2-served', 'postgres connection pool size is twenty for checkout');
    servedAt(served, NOW - 60_000);

    const olderNoMatch = insertMem(repo, 'proxy-scancap2-atom-old', 'the frontend build pipeline uses webpack now', { capture_source: 'proxy' });
    setCreatedAt(olderNoMatch, NOW - 45_000); // earlier created_at — occupies the one scan slot

    const laterMatch = insertMem(repo, 'proxy-scancap2-atom-new', 'postgres connection pool size for checkout was tuned', { capture_source: 'proxy' });
    setCreatedAt(laterMatch, NOW - 30_000); // would match if scanned, but the cap excludes it

    const result = runProxyTurnCorrelationPass(db, { ...OPTS, maxProxyAtomsScanned: 1 }, NOW);
    expect(result).toEqual({ candidates: 1, granted: 0, proxyActivityAbsent: false });
  });
});

describe('proxyCorrelationSummary', () => {
  let db: DB;
  let repo: MemoryRepo;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    repo = new MemoryRepo(db);
  });

  it('proxyActivityAbsent: true with zero served/correlated counts when there is no proxy activity', () => {
    expect(proxyCorrelationSummary(db)).toEqual({ servedDistinct: 0, proxyCorrelatedDistinct: 0, proxyActivityAbsent: true });
  });

  it('reports servedDistinct and proxyCorrelatedDistinct once proxy activity + a grant exist', () => {
    const events = new MemoryEventRepo(db);
    const served = insertMem(repo, 'summary-served', 'postgres connection pool size is twenty for checkout');
    events.append({
      event_type: 'usefulness', atom_id: served,
      payload: { family: 'recall_served', query_hash: 'q', score: null, surface: 'rest', mode: null },
    });
    insertMem(repo, 'summary-proxy-atom', 'irrelevant', { capture_source: 'proxy' });

    // Before any grant — proxy activity exists but nothing correlated yet.
    expect(proxyCorrelationSummary(db)).toEqual({ servedDistinct: 1, proxyCorrelatedDistinct: 0, proxyActivityAbsent: false });

    events.append({
      event_type: 'usefulness', atom_id: served,
      payload: { family: 'recall_used', surface: 'system', signal: 'heuristic', basis: PROXY_TURN_CORRELATION_BASIS },
    });
    expect(proxyCorrelationSummary(db)).toEqual({ servedDistinct: 1, proxyCorrelatedDistinct: 1, proxyActivityAbsent: false });
  });

  it('does not count a heuristic grant from the OTHER mechanism (no_correction_survival) as proxy-correlated', () => {
    const events = new MemoryEventRepo(db);
    const served = insertMem(repo, 'summary-other-basis', 'text');
    insertMem(repo, 'summary-other-basis-proxy', 'irrelevant', { capture_source: 'proxy' });
    events.append({
      event_type: 'usefulness', atom_id: served,
      payload: { family: 'recall_used', surface: 'system', signal: 'heuristic', basis: 'no_correction_survival' },
    });

    expect(proxyCorrelationSummary(db).proxyCorrelatedDistinct).toBe(0);
  });
});
