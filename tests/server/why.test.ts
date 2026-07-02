import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { MemoryRepo } from '../../src/storage/memories.js';
import { buildApp } from '../../src/server/app.js';

describe('GET /memory/:id/why (KF-A)', () => {
  let db: DB;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
  });

  it('returns a receipt with evidence + session block', async () => {
    db.prepare(
      'INSERT INTO sessions (id, repo, project, branch, agent, started_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('s1', 'astramem-local', null, 'main', 'claude-code', 1000);
    const id = new MemoryRepo(db).insert({
      type: 'decision', text: 'Use SQLite', normalized_text: 'use SQLite',
      repo: 'astramem-local', project: null, branch: 'main', agent: 'claude-code',
      session_id: 's1', hash: 'h-why-1', source_hash: 'src-abc',
      evidence: 'zero-config local file decided in review',
    });

    const app = await buildApp({ db, token: 't' });
    const res = await app.inject({
      method: 'GET', url: `/memory/${id}/why`,
      headers: { authorization: 'Bearer t' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.evidence).toBe('zero-config local file decided in review');
    expect(body.session).toMatchObject({ id: 's1', repo: 'astramem-local' });
    expect(body.transcript_ref).toBe('src-abc');
    expect(body.history).toEqual([]);
  });

  it('null-session memory → receipt without session block', async () => {
    const id = new MemoryRepo(db).insert({
      type: 'fact', text: 'port 7777', normalized_text: 'port 7777',
      repo: null, project: null, branch: null, agent: null,
      session_id: null, hash: 'h-why-2', source_hash: null,
    });
    const app = await buildApp({ db, token: 't' });
    const res = await app.inject({
      method: 'GET', url: `/memory/${id}/why`,
      headers: { authorization: 'Bearer t' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().session).toBeNull();
    expect(res.json().evidence).toBeNull();
  });

  it('unknown id → 404', async () => {
    const app = await buildApp({ db, token: 't' });
    const res = await app.inject({
      method: 'GET', url: '/memory/nope/why',
      headers: { authorization: 'Bearer t' },
    });
    expect(res.statusCode).toBe(404);
  });
});
