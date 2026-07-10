import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { MemoryRepo } from '../../src/storage/memories.js';
import { buildApp } from '../../src/server/app.js';

function seedSession(db: DB, id: string) {
  db.prepare(
    'INSERT INTO sessions (id, repo, project, branch, agent, started_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, 'astramem-local', null, 'main', 'claude-code', Date.now());
}

describe('GET /sessions/:id/digest (KF-C)', () => {
  let db: DB;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
  });

  it('returns per-type counts + memory texts for the session', async () => {
    seedSession(db, 's1');
    const repo = new MemoryRepo(db);
    repo.insert({ type: 'decision', text: 'Use SQLite', normalized_text: 'use SQLite',
      repo: 'r', project: null, branch: null, agent: null, session_id: 's1',
      hash: 'd1', source_hash: null });
    repo.insert({ type: 'lesson', text: 'Bun lacks better-sqlite3 on Windows', normalized_text: 'bun lacks',
      repo: 'r', project: null, branch: null, agent: null, session_id: 's1',
      hash: 'd2', source_hash: null });

    const app = await buildApp({ db, token: 't' });
    const res = await app.inject({ method: 'GET', url: '/sessions/s1/digest',
      headers: { authorization: 'Bearer t' } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ready');
    expect(body.counts).toEqual({ decision: 1, lesson: 1 });
    expect(body.memories).toHaveLength(2);
  });

  it('distill job still queued → status pending', async () => {
    seedSession(db, 's2');
    db.prepare(
      'INSERT INTO jobs (id, kind, payload_json, state, attempts, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)'
    ).run('j1', 'distill', JSON.stringify({ transcript_id: 't1', session_id: 's2' }), 'pending', Date.now(), Date.now());

    const app = await buildApp({ db, token: 't' });
    const res = await app.inject({ method: 'GET', url: '/sessions/s2/digest',
      headers: { authorization: 'Bearer t' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('pending');
  });

  it('poison distill job, no active job → status partial + poison_jobs count', async () => {
    seedSession(db, 's3');
    db.prepare(
      'INSERT INTO jobs (id, kind, payload_json, state, attempts, created_at, updated_at) VALUES (?, ?, ?, ?, 3, ?, ?)'
    ).run('j2', 'distill', JSON.stringify({ transcript_id: 't2', session_id: 's3' }), 'poison', Date.now(), Date.now());

    const app = await buildApp({ db, token: 't' });
    const res = await app.inject({ method: 'GET', url: '/sessions/s3/digest',
      headers: { authorization: 'Bearer t' } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('partial');
    expect(body.poison_jobs).toBe(1);
  });

  it('active job takes priority over an unrelated poison job → status pending', async () => {
    seedSession(db, 's4');
    db.prepare(
      'INSERT INTO jobs (id, kind, payload_json, state, attempts, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)'
    ).run('j3', 'distill', JSON.stringify({ transcript_id: 't3', session_id: 's4' }), 'pending', Date.now(), Date.now());

    const app = await buildApp({ db, token: 't' });
    const res = await app.inject({ method: 'GET', url: '/sessions/s4/digest',
      headers: { authorization: 'Bearer t' } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('pending');
    expect(body.poison_jobs).toBe(0);
  });

  it('no jobs at all → status ready + poison_jobs 0 (backward-compatible default path)', async () => {
    seedSession(db, 's5');
    const app = await buildApp({ db, token: 't' });
    const res = await app.inject({ method: 'GET', url: '/sessions/s5/digest',
      headers: { authorization: 'Bearer t' } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ready');
    expect(body.poison_jobs).toBe(0);
  });

  it('unknown session → 404', async () => {
    const app = await buildApp({ db, token: 't' });
    const res = await app.inject({ method: 'GET', url: '/sessions/nope/digest',
      headers: { authorization: 'Bearer t' } });
    expect(res.statusCode).toBe(404);
  });

  // AC-13 (FEAT-456 SLICE-2): pending_contradictions counts pending
  // kind='contradiction' proposals touching this session's memories.
  it('pending_contradictions counts a pending contradiction proposal touching this session (winner or loser side)', async () => {
    seedSession(db, 's6');
    const repo = new MemoryRepo(db);
    const inSession = repo.insert({ type: 'fact', text: 'default port is 7777', normalized_text: 'default port is 7777',
      repo: 'r', project: null, branch: null, agent: null, session_id: 's6',
      hash: 'd-c1', source_hash: null });
    const otherSession = repo.insert({ type: 'fact', text: 'default port is 8888', normalized_text: 'default port is 8888',
      repo: 'r', project: null, branch: null, agent: null, session_id: null,
      hash: 'd-c2', source_hash: null });
    // winner_id side (otherSession is newer/winner, inSession is older/loser
    // — direction is irrelevant here, the count checks either side).
    db.prepare(`
      INSERT INTO consolidation_proposals (id, kind, winner_id, loser_id, similarity, status, created_at)
      VALUES (?, 'contradiction', ?, ?, ?, 'pending', ?)
    `).run('prop-digest-1', otherSession, inSession, 0.7, Date.now());

    const app = await buildApp({ db, token: 't' });
    const res = await app.inject({ method: 'GET', url: '/sessions/s6/digest',
      headers: { authorization: 'Bearer t' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().pending_contradictions).toBe(1);
  });

  it('pending_contradictions is 0 when no consolidation run has produced one yet (documented latency)', async () => {
    seedSession(db, 's7');
    const repo = new MemoryRepo(db);
    repo.insert({ type: 'fact', text: 'a fresh atom', normalized_text: 'a fresh atom',
      repo: 'r', project: null, branch: null, agent: null, session_id: 's7',
      hash: 'd-c3', source_hash: null });

    const app = await buildApp({ db, token: 't' });
    const res = await app.inject({ method: 'GET', url: '/sessions/s7/digest',
      headers: { authorization: 'Bearer t' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().pending_contradictions).toBe(0);
  });
});
