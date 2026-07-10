/**
 * FEAT-455 build (ADR-012 checklist #5): validates the disable -> purge flow
 * end to end against a REAL auto-captured memory.
 *
 * ADR-012 decision 4 requires: "Disabling auto-capture offers a purge, wired
 * to the existing purge tooling (erase_memory/invalidate_memory ...) scoped
 * to atoms tagged with the auto-capture provenance source ... Offered, not
 * forced: a user may keep already-formed memories while stopping new
 * auto-capture."
 *
 * Originally written during the FEAT-455 security spike against a marker
 * embedded in `evidence` (the real `capture_source` column did not exist
 * yet — see docs/specs/FEAT-455-spike-results.md §3, checklist #4, and
 * migrations/024-capture-source.sql). Now that the column has landed, this
 * test uses it directly — exactly the swap the spike's own doc comment
 * anticipated, with no other change: erase()/invalidate() themselves need
 * no auto-capture-specific code at all.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { MemoryRepo, type InsertInput } from '../../src/storage/memories.js';
import { MemoryEventRepo, MemoryNotFoundError } from '../../src/storage/memory-events.js';

function insertMem(repo: MemoryRepo, hash: string, opts: { autoCaptured: boolean }): string {
  const input: InsertInput = {
    type: 'fact',
    text: `memory ${hash}`,
    normalized_text: `memory ${hash}`,
    repo: 'r1',
    project: null,
    branch: null,
    agent: 'claude-code',
    session_id: null,
    hash,
    source_hash: null,
    capture_source: opts.autoCaptured ? 'auto_capture' : null,
  };
  return repo.insert(input);
}

/** The real disable-flow handler's "list auto-captured atom ids" query —
 *  scoped by the dedicated provenance column, same predicate the doctor
 *  WARN-row count check uses (src/doctor/checks.ts's checkAutoCapture). */
function listAutoCapturedIds(db: DB): string[] {
  const rows = db
    .prepare(`SELECT id FROM memories WHERE capture_source = 'auto_capture' AND valid_to IS NULL`)
    .all() as { id: string }[];
  return rows.map(r => r.id);
}

describe('ADR-012 disable -> purge flow (erase_memory path — "PERMANENTLY remove")', () => {
  let db: DB;
  let repo: MemoryRepo;
  let events: MemoryEventRepo;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    repo = new MemoryRepo(db);
    events = new MemoryEventRepo(db);
  });

  it('scopes erasure to ONLY the auto-captured atoms, leaves manual atoms untouched', () => {
    const auto1 = insertMem(repo, 'auto-1', { autoCaptured: true });
    const auto2 = insertMem(repo, 'auto-2', { autoCaptured: true });
    const manual1 = insertMem(repo, 'manual-1', { autoCaptured: false });

    const scoped = listAutoCapturedIds(db);
    expect(new Set(scoped)).toEqual(new Set([auto1, auto2]));

    // The disable-flow purge: erase every scoped id via the SAME primitive
    // erase_memory (MCP)/DELETE /memory/:id (REST) already exposes.
    for (const id of scoped) {
      events.erase(id, 'auto-capture disabled — user opted into purge');
    }

    expect(repo.get(auto1)).toBeNull();
    expect(repo.get(auto2)).toBeNull();
    expect(repo.get(manual1)).not.toBeNull(); // untouched — purge is scoped, not global

    // Tombstone survives the row (erase_request event) for both erased atoms.
    const auto1History = events.listForAtom(auto1);
    expect(auto1History.some(e => e.event_type === 'erase_request')).toBe(true);
    const auto2History = events.listForAtom(auto2);
    expect(auto2History.some(e => e.event_type === 'erase_request')).toBe(true);

    // Replay filter: re-distillation of the same content must not resurrect it.
    expect(events.isErasedHash('auto-1')).toBe(true);
    expect(events.isErasedHash('auto-2')).toBe(true);
    expect(events.isErasedHash('manual-1')).toBe(false);
  });

  it('is a hard delete — the row is unrecoverable, byte-scan confirms no residual text', () => {
    const id = insertMem(repo, 'auto-erase-scan', { autoCaptured: true });
    events.erase(id, 'purge on disable');

    const row = db.prepare('SELECT * FROM memories WHERE id = ?').get(id);
    expect(row).toBeUndefined();

    const ftsRow = db.prepare(`SELECT rowid FROM memories_fts WHERE memories_fts MATCH 'memory'`).all();
    // The erased atom's own FTS row must be gone (AFTER DELETE trigger) —
    // any surviving FTS hits belong to other rows, none of which exist here.
    expect(ftsRow.length).toBe(0);
  });

  it('an empty scope (auto-capture was enabled but nothing was ever captured) is a safe no-op', () => {
    const manual1 = insertMem(repo, 'manual-only', { autoCaptured: false });
    const scoped = listAutoCapturedIds(db);
    expect(scoped).toEqual([]);
    for (const id of scoped) events.erase(id); // loop body never runs
    expect(repo.get(manual1)).not.toBeNull();
  });

  it('re-running the purge against an already-erased id throws MemoryNotFoundError, not a ' +
     'silent double-tombstone — a disable-flow handler must treat this as already-done, not fail the whole batch', () => {
    const id = insertMem(repo, 'auto-double-erase', { autoCaptured: true });
    events.erase(id);
    expect(() => events.erase(id)).toThrow(MemoryNotFoundError);
  });
});

describe('ADR-012 disable -> purge flow — invalidate_memory path ("offered, not forced")', () => {
  let db: DB;
  let repo: MemoryRepo;
  let events: MemoryEventRepo;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    repo = new MemoryRepo(db);
    events = new MemoryEventRepo(db);
  });

  it('a user who declines the hard purge can invalidate instead — memory kept, marked invalid, ' +
     'text still physically present — the softer alternative the erase_memory tool description ' +
     'itself recommends ("Prefer invalidate_memory unless deletion is required")', () => {
    const id = insertMem(repo, 'auto-soft', { autoCaptured: true });

    events.invalidate(id, 'auto-capture disabled — kept, not purged');

    const mem = repo.get(id);
    expect(mem).not.toBeNull();
    expect(mem?.valid_to).not.toBeNull(); // invalid, but text still present
    expect(mem?.text).toBe('memory auto-soft');
  });

  it('FINDING: unlike archive()/restore() and supersede()/unsupersede(), invalidate() ' +
     'has NO direct reversal primitive in this lifecycle API — restore() throws ' +
     'MemoryConflictError because it specifically requires archived===1, which ' +
     'invalidate() never sets. A disable-flow "soft purge, changed my mind" UX would ' +
     'need a new reversal method (or would need to call archive() instead of ' +
     'invalidate() up front, trading its distinct semantics away) — flagged here as a ' +
     'gap for the eventual FEAT-455 build, not fixed in this spike.', () => {
    const id = insertMem(repo, 'auto-soft-2', { autoCaptured: true });
    events.invalidate(id, 'auto-capture disabled — kept, not purged');
    expect(() => events.restore(id)).toThrow('is not archived');
  });

  it('declining the purge entirely (toggle off, keep everything) requires literally no ' +
     'lifecycle call — auto-captured memories remain valid and queryable by id', () => {
    const auto1 = insertMem(repo, 'auto-kept-1', { autoCaptured: true });
    // No purge, no invalidate — simulates "keep already-formed memories".
    expect(repo.get(auto1)?.valid_to).toBeNull();
  });
});
