import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { MemoryRepo } from '../../src/storage/memories.js';
import type { DB } from '../../src/storage/db.js';

describe('MemoryRepo', () => {
  let db: DB;
  let repo: MemoryRepo;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    repo = new MemoryRepo(db);
  });

  it('inserts and reads by id', () => {
    const id = repo.insert({
      type: 'decision',
      text: 'use sqlite-vec for v1',
      normalized_text: 'use sqlite-vec for v1',
      repo: 'astramemory-local',
      hash: 'h1',
      session_id: null,
      project: null,
      branch: null,
      agent: null,
      source_hash: null
    });
    const m = repo.get(id);
    expect(m?.text).toBe('use sqlite-vec for v1');
    expect(m?.type).toBe('decision');
  });

  it('hash dedup — second insert with same hash returns existing id', () => {
    const id1 = repo.insert({
      type: 'fact', text: 't', normalized_text: 't', hash: 'dup',
      repo: null, project: null, branch: null, agent: null, session_id: null, source_hash: null
    });
    const id2 = repo.insert({
      type: 'fact', text: 't', normalized_text: 't', hash: 'dup',
      repo: null, project: null, branch: null, agent: null, session_id: null, source_hash: null
    });
    expect(id1).toBe(id2);
  });

  it('fts5 search finds inserted memory', () => {
    repo.insert({
      type: 'decision', text: 'use postgres for sync', normalized_text: 'use postgres for sync', hash: 'p1',
      repo: null, project: null, branch: null, agent: null, session_id: null, source_hash: null
    });
    const hits = repo.searchFts('postgres', 10);
    expect(hits.length).toBe(1);
    expect(hits[0]?.text).toContain('postgres');
  });

  it('inserts and reads type note', () => {
    const id = repo.insert({
      type: 'note',
      text: 'a freeform note observation',
      normalized_text: 'a freeform note observation',
      hash: 'hash-note-1',
      repo: null, project: null, branch: null, agent: null, session_id: null, source_hash: null
    });
    const m = repo.get(id);
    expect(m?.type).toBe('note');
    expect(m?.text).toBe('a freeform note observation');
  });

  it('inserts and reads type event', () => {
    const id = repo.insert({
      type: 'event',
      text: 'deployment to production completed',
      normalized_text: 'deployment to production completed',
      hash: 'hash-event-1',
      repo: null, project: null, branch: null, agent: null, session_id: null, source_hash: null
    });
    const m = repo.get(id);
    expect(m?.type).toBe('event');
    expect(m?.text).toBe('deployment to production completed');
  });

  it('note and event survive FTS round-trip', () => {
    repo.insert({
      type: 'note', text: 'curious fts roundtrip note', normalized_text: 'curious fts roundtrip note',
      hash: 'fts-note-rt', repo: null, project: null, branch: null, agent: null, session_id: null, source_hash: null
    });
    repo.insert({
      type: 'event', text: 'curious fts roundtrip event', normalized_text: 'curious fts roundtrip event',
      hash: 'fts-event-rt', repo: null, project: null, branch: null, agent: null, session_id: null, source_hash: null
    });
    const hits = repo.searchFts('curious fts roundtrip', 10);
    expect(hits.length).toBe(2);
    const types = hits.map(h => h.type).sort();
    expect(types).toEqual(['event', 'note']);
  });

  // FEAT-458 S3 (ADR-013): InsertInput.capture_source widened to admit
  // 'proxy' alongside the FEAT-455 'auto_capture' | 'hook_close' | null
  // values — this is the typed insert boundary the LLM proxy relay's
  // capture fork writes through.
  it('accepts capture_source "proxy" and round-trips it onto the memories row', () => {
    const id = repo.insert({
      type: 'fact', text: 'proxy-captured fact', normalized_text: 'proxy-captured fact',
      hash: 'cs-proxy-1', repo: null, project: null, branch: null, agent: null, session_id: null,
      source_hash: null, capture_source: 'proxy',
    });
    const m = repo.get(id);
    expect(m?.capture_source).toBe('proxy');
  });

  it('still accepts the pre-existing "auto_capture" / "hook_close" / omitted values unchanged', () => {
    const auto = repo.insert({
      type: 'fact', text: 'auto-captured fact', normalized_text: 'auto-captured fact',
      hash: 'cs-auto-1', repo: null, project: null, branch: null, agent: null, session_id: null,
      source_hash: null, capture_source: 'auto_capture',
    });
    const hookClose = repo.insert({
      type: 'fact', text: 'hook-close fact', normalized_text: 'hook-close fact',
      hash: 'cs-hookclose-1', repo: null, project: null, branch: null, agent: null, session_id: null,
      source_hash: null, capture_source: 'hook_close',
    });
    const omitted = repo.insert({
      type: 'fact', text: 'manual fact', normalized_text: 'manual fact',
      hash: 'cs-omitted-1', repo: null, project: null, branch: null, agent: null, session_id: null,
      source_hash: null,
    });
    expect(repo.get(auto)?.capture_source).toBe('auto_capture');
    expect(repo.get(hookClose)?.capture_source).toBe('hook_close');
    expect(repo.get(omitted)?.capture_source).toBeNull();
  });

  // Issue #205 (AC-2/AC-3): valid_to/validity_extracted round-trip through
  // InsertInput -> insertRow -> hydrate(). Prior to this fix, insertRow's
  // SQL never included valid_to at all — the column existed (migration 006)
  // but nothing could ever write to it through the repo.
  describe('issue #205: valid_to / validity_extracted', () => {
    it('omitted valid_to/validity_extracted — defaults to NULL/false, byte-identical to pre-fix behavior', () => {
      const id = repo.insert({
        type: 'fact', text: 'unbounded fact, no validity fields passed', normalized_text: 'unbounded fact',
        hash: 'valext-omitted-1', repo: null, project: null, branch: null, agent: null, session_id: null,
        source_hash: null,
      });
      const m = repo.get(id);
      expect(m?.valid_to).toBeNull();
      expect(m?.validity_extracted).toBe(false);
    });

    it('explicit valid_to (epoch ms) round-trips — the write path issue #205 adds', () => {
      const boundedAt = 1_700_000_000_000;
      const id = repo.insert({
        type: 'fact', text: 'a fact bounded by a stated end date', normalized_text: 'a fact bounded',
        hash: 'valext-bounded-1', repo: null, project: null, branch: null, agent: null, session_id: null,
        source_hash: null, valid_to: boundedAt, validity_extracted: true,
      });
      const m = repo.get(id);
      expect(m?.valid_to).toBe(boundedAt);
      expect(m?.validity_extracted).toBe(true);
    });

    it('validity_extracted: true with valid_to omitted — "extraction looked, found no bound" (unbounded, but examined)', () => {
      const id = repo.insert({
        type: 'fact', text: 'a fact extraction examined and found genuinely unbounded', normalized_text: 'unbounded examined',
        hash: 'valext-examined-unbounded-1', repo: null, project: null, branch: null, agent: null, session_id: null,
        source_hash: null, validity_extracted: true,
      });
      const m = repo.get(id);
      expect(m?.valid_to).toBeNull();
      expect(m?.validity_extracted).toBe(true);
    });
  });

  // Issue #209: durable vec-index retry marker (migrations/041-vec-index-retry.sql).
  describe('needs_vec_index (issue #209)', () => {
    function insertOne(hash: string): string {
      return repo.insert({
        type: 'fact', text: 'a memory', normalized_text: 'a memory', hash,
        repo: null, project: null, branch: null, agent: null, session_id: null, source_hash: null,
      });
    }

    it('defaults to false on a fresh insert — byte-identical to pre-fix rows', () => {
      const id = insertOne('vecidx-default-1');
      const m = repo.get(id);
      expect(m?.needs_vec_index).toBe(false);
    });

    it('markNeedsVecIndex durably flags the row — does not silently report success', () => {
      const id = insertOne('vecidx-mark-1');
      repo.markNeedsVecIndex(id);
      const m = repo.get(id);
      expect(m?.needs_vec_index).toBe(true);
    });

    it('clearNeedsVecIndex un-flags a previously flagged row', () => {
      const id = insertOne('vecidx-clear-1');
      repo.markNeedsVecIndex(id);
      expect(repo.get(id)?.needs_vec_index).toBe(true);
      repo.clearNeedsVecIndex(id);
      expect(repo.get(id)?.needs_vec_index).toBe(false);
    });

    it('clearNeedsVecIndex on a never-flagged row is a no-op', () => {
      const id = insertOne('vecidx-clear-noop-1');
      repo.clearNeedsVecIndex(id);
      expect(repo.get(id)?.needs_vec_index).toBe(false);
    });

    it('listNeedingVecIndex returns only flagged rows, capped at limit', () => {
      const a = insertOne('vecidx-list-a');
      const b = insertOne('vecidx-list-b');
      insertOne('vecidx-list-c'); // never flagged — must not appear
      repo.markNeedsVecIndex(a);
      repo.markNeedsVecIndex(b);

      const all = repo.listNeedingVecIndex(10);
      expect(all.slice().sort()).toEqual([a, b].sort());

      const limited = repo.listNeedingVecIndex(1);
      expect(limited).toHaveLength(1);
      expect([a, b]).toContain(limited[0]);
    });

    // FEAT-507: oversize-atom repair scan uses this to find candidates the
    // reembed handler's truncate-before-embed fix can actually repair.
    it('listOversizeNeedingVecIndex returns only flagged rows whose text exceeds maxChars', () => {
      const insertWithText = (hash: string, text: string): string =>
        repo.insert({
          type: 'fact', text, normalized_text: text, hash,
          repo: null, project: null, branch: null, agent: null, session_id: null, source_hash: null,
        });

      const oversizeFlagged = insertWithText('oversize-flagged-1', 'x'.repeat(3000));
      const oversizeUnflagged = insertWithText('oversize-unflagged-1', 'x'.repeat(3000));
      const smallFlagged = insertWithText('small-flagged-1', 'x'.repeat(10));
      repo.markNeedsVecIndex(oversizeFlagged);
      repo.markNeedsVecIndex(smallFlagged);
      // oversizeUnflagged deliberately never flagged — already vector-indexed,
      // so it must not appear even though its text is long.

      const candidates = repo.listOversizeNeedingVecIndex(1000, 10);
      expect(candidates).toEqual([oversizeFlagged]);
      expect(candidates).not.toContain(oversizeUnflagged);
      expect(candidates).not.toContain(smallFlagged);
    });

    it('listOversizeNeedingVecIndex caps at limit', () => {
      const insertWithText = (hash: string, text: string): string =>
        repo.insert({
          type: 'fact', text, normalized_text: text, hash,
          repo: null, project: null, branch: null, agent: null, session_id: null, source_hash: null,
        });
      const a = insertWithText('oversize-cap-a', 'x'.repeat(3000));
      const b = insertWithText('oversize-cap-b', 'x'.repeat(3000));
      repo.markNeedsVecIndex(a);
      repo.markNeedsVecIndex(b);

      const limited = repo.listOversizeNeedingVecIndex(1000, 1);
      expect(limited).toHaveLength(1);
      expect([a, b]).toContain(limited[0]);
    });
  });
});
