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
});
