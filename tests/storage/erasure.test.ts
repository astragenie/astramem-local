// Wave 3f — erasure v1 (ADR-006 W5): hard-delete + tombstone + replay filter.

import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { MemoryRepo } from '../../src/storage/memories.js';
import { MemoryEventRepo, MemoryNotFoundError } from '../../src/storage/memory-events.js';
import { embedAndIndex } from '../../src/distill/stages/08-embed-index.js';
import { makeFakeVec } from '../../src/search/search.js';
import { buildApp } from '../../src/server/app.js';
import type { EmbedProvider } from '../../src/contracts/index.js';

function fakeEmbed(): EmbedProvider {
  return {
    name: 'ollama' as const,
    model: 'fake',
    dim: 1024 as const,
    embed: async (texts: string[]) => texts.map(t => makeFakeVec(t)),
    health: async () => ({ ok: true, model: 'fake', dim: 1024 as const }),
  };
}

function seed(db: DB, hash: string, scope: 'personal' | 'team' = 'team'): string {
  return new MemoryRepo(db).insert({
    type: 'fact',
    text: `secret text ${hash}`,
    normalized_text: `secret text ${hash}`,
    repo: 'r1', project: null, branch: null, agent: null,
    session_id: null, hash, source_hash: null, scope,
  });
}

describe('MemoryEventRepo.erase (3f)', () => {
  let db: DB;
  let events: MemoryEventRepo;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    events = new MemoryEventRepo(db);
  });

  it('hard-deletes the row, its vec entry, and FTS visibility; tombstone event remains', async () => {
    const id = seed(db, 'h-erase-1');
    const rowid = (db.prepare('SELECT rowid FROM memories WHERE id = ?').get(id) as { rowid: number }).rowid;
    db.prepare('INSERT INTO memories_vec (rowid, embedding) VALUES (?, ?)')
      .run(BigInt(rowid), Buffer.from(makeFakeVec('x').buffer));

    events.erase(id, 'user requested');

    expect(db.prepare('SELECT 1 FROM memories WHERE id = ?').get(id)).toBeUndefined();
    expect(db.prepare('SELECT 1 FROM memories_vec WHERE rowid = ?').get(BigInt(rowid))).toBeUndefined();
    const fts = db.prepare(`SELECT rowid FROM memories_fts WHERE memories_fts MATCH '"h-erase-1"'`).all();
    expect(fts).toHaveLength(0);

    const tombstones = events.listForAtom(id).filter(e => e.event_type === 'erase_request');
    expect(tombstones).toHaveLength(1);
    expect(JSON.parse(tombstones[0]!.payload_json!)).toMatchObject({ scope: 'team', reason: 'user requested' });
    expect(tombstones[0]!.content_hash).toBe('h-erase-1');
  });

  it('unknown id throws MemoryNotFoundError', () => {
    expect(() => events.erase('nope')).toThrow(MemoryNotFoundError);
  });

  it('replay filter: stage 8 refuses to resurrect an erased content hash', async () => {
    const id = seed(db, 'h-erase-replay');
    events.erase(id);

    const results = await embedAndIndex(
      [{
        type: 'fact',
        text: 'secret text h-erase-replay',
        importance: 0.5,
        confidence: 0.5,
        contentHash: 'ch-x',
        normalizedText: 'secret text h-erase-replay',
        finalHash: 'h-erase-replay',
      }],
      {
        db, embed: fakeEmbed(),
        sessionId: null, repo: 'r1', project: null, branch: null, agent: null,
        sourceHash: null,
      },
    );
    expect(results).toHaveLength(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM memories').get()).toEqual({ n: 0 });
  });

  it('non-erased hashes still insert through stage 8 (filter is surgical)', async () => {
    const results = await embedAndIndex(
      [{
        type: 'fact', text: 'innocent', importance: 0.5, confidence: 0.5,
        contentHash: 'ch-y', normalizedText: 'innocent', finalHash: 'h-innocent',
      }],
      {
        db, embed: fakeEmbed(),
        sessionId: null, repo: 'r1', project: null, branch: null, agent: null,
        sourceHash: null,
      },
    );
    expect(results).toHaveLength(1);
  });

  it('erase tombstone for a team memory is ship-eligible after the row is gone (shipper contract)', () => {
    const id = seed(db, 'h-erase-ship', 'team');
    events.erase(id);
    const eligible = db.prepare(`
      SELECT e.atom_id FROM memory_events e
      LEFT JOIN memories m ON m.id = e.atom_id
      WHERE e.synced_at IS NULL
        AND (m.scope IN ('team','org')
             OR (e.event_type = 'erase_request' AND json_extract(e.payload_json, '$.scope') IN ('team','org')))
    `).all() as Array<{ atom_id: string }>;
    expect(eligible.map(r => r.atom_id)).toContain(id);
  });
});

describe('DELETE /memory/:id (3f REST)', () => {
  it('erases and returns ok; second call 404; erased memory invisible to GET why', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const id = seed(db, 'h-erase-rest');
    const app = await buildApp({ db, token: 't' });

    const res = await app.inject({
      method: 'DELETE', url: `/memory/${id}`,
      headers: { authorization: 'Bearer t' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });

    const again = await app.inject({
      method: 'DELETE', url: `/memory/${id}`,
      headers: { authorization: 'Bearer t' },
    });
    expect(again.statusCode).toBe(404);

    const why = await app.inject({
      method: 'GET', url: `/memory/${id}/why`,
      headers: { authorization: 'Bearer t' },
    });
    expect(why.statusCode).toBe(404);
  });
});
