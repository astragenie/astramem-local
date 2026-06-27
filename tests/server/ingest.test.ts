import { describe, it, expect } from 'vitest';
import { buildApp } from '../../src/server/app.js';
import { openDb } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';

describe('ingest endpoint', () => {
  it('GET /health returns 200', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const app = await buildApp({ db, token: 't' });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });

  it('POST /ingest/transcript with valid bearer creates session + transcript + distill job', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const app = await buildApp({ db, token: 't' });
    const res = await app.inject({
      method: 'POST',
      url: '/ingest/transcript',
      headers: { authorization: 'Bearer t', 'content-type': 'application/json' },
      payload: {
        session_id: 's1',
        source: 'PreCompact',
        content: 'user: hi\nassistant: hello',
        repo: 'astramemory-local',
        agent: 'claude-code'
      }
    });
    expect(res.statusCode).toBe(200);
    const sessions = db.prepare('SELECT * FROM sessions WHERE id = ?').all('s1');
    const transcripts = db.prepare('SELECT * FROM transcripts WHERE session_id = ?').all('s1');
    const jobs = db.prepare('SELECT * FROM jobs WHERE state = ?').all('pending');
    expect(sessions.length).toBe(1);
    expect(transcripts.length).toBe(1);
    expect(jobs.length).toBe(1);
  });

  it('POST /ingest/transcript without bearer returns 401', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const app = await buildApp({ db, token: 't' });
    const res = await app.inject({
      method: 'POST',
      url: '/ingest/transcript',
      payload: { session_id: 's1', source: 'PreCompact', content: 'x' }
    });
    expect(res.statusCode).toBe(401);
  });
});
