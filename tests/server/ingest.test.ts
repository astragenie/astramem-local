import { describe, it, expect } from 'vitest';
import { buildApp } from '../../src/server/app.js';
import { openDb } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeApp() {
  const db = openDb(':memory:');
  migrate(db);
  return { db, app: buildApp({ db, token: 't' }) };
}

const AUTH = { authorization: 'Bearer t', 'content-type': 'application/json' } as const;

/** Minimal valid legacy payload */
const LEGACY_PAYLOAD = {
  session_id: 's1',
  source: 'PreCompact',
  content: 'user: hi\nassistant: hello',
  repo: 'astramemory-local',
  agent: 'claude-code',
} as const;

/** Minimal valid canonical payload (all required fields) */
const CANONICAL_PAYLOAD = {
  event: 'pre_compact' as const,
  session_id: 'sess-canonical-1',
  project_id: 'proj-abc',
  captured_at: '2025-06-30T10:00:00.000Z',
  turns: [
    { role: 'user' as const, text: 'Hello' },
    { role: 'assistant' as const, text: 'Hi there' },
  ],
  client_scrub_applied: true,
  client_scrub_hits: 0,
  client_version: '0.6.0',
  client_scrub_version: '1.2.0',
  wire_version: 'v1.0',
};

// ---------------------------------------------------------------------------
// Original tests (preserved)
// ---------------------------------------------------------------------------

describe('ingest endpoint', () => {
  it('GET /health returns 200', async () => {
    const { app } = makeApp();
    const res = await (await app).inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });

  it('POST /ingest/transcript with valid bearer creates session + transcript + distill job', async () => {
    const { db, app } = makeApp();
    const res = await (await app).inject({
      method: 'POST',
      url: '/ingest/transcript',
      headers: AUTH,
      payload: LEGACY_PAYLOAD,
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
    const { app } = makeApp();
    const res = await (await app).inject({
      method: 'POST',
      url: '/ingest/transcript',
      payload: { session_id: 's1', source: 'PreCompact', content: 'x' },
    });
    expect(res.statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Dual-envelope schema tests (FEAT-4a Phase 2 Stage 2)
// ---------------------------------------------------------------------------

describe('ingest endpoint — dual-envelope schema (FEAT-4a)', () => {
  // ---- Legacy envelope ----

  it('legacy envelope still passes validation and returns 200', async () => {
    const { app } = makeApp();
    const res = await (await app).inject({
      method: 'POST',
      url: '/ingest/transcript',
      headers: AUTH,
      payload: LEGACY_PAYLOAD,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });

  // ---- Canonical envelope happy path ----

  it('canonical envelope happy path returns 200 with stage stub', async () => {
    const { app } = makeApp();
    const res = await (await app).inject({
      method: 'POST',
      url: '/ingest/transcript',
      headers: AUTH,
      payload: CANONICAL_PAYLOAD,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.stage).toBe('schema-only-stub');
  });

  it('canonical envelope with all optional fields round-trips validation', async () => {
    const { app } = makeApp();
    const payload = {
      ...CANONICAL_PAYLOAD,
      agent_type: 'claude-code',
      cwd: '/home/user/project',
      client_scrub_hits_by_label: { bearer: 3, api_key: 4 },
      turns: [
        { role: 'user' as const, text: 'Hello', ts: '2025-06-30T10:00:00.000Z' },
        { role: 'assistant' as const, text: 'Hi', ts: '2025-06-30T10:00:01.000Z' },
      ],
    };
    const res = await (await app).inject({
      method: 'POST',
      url: '/ingest/transcript',
      headers: AUTH,
      payload,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });

  it('canonical client_scrub_hits_by_label record round-trips through validation', async () => {
    const { app } = makeApp();
    const res = await (await app).inject({
      method: 'POST',
      url: '/ingest/transcript',
      headers: AUTH,
      payload: {
        ...CANONICAL_PAYLOAD,
        client_scrub_hits_by_label: { bearer: 3, api_key: 4 },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });

  // ---- Canonical envelope: missing wire_version ----

  it('canonical missing wire_version returns 400', async () => {
    const { app } = makeApp();
    const { wire_version: _omit, ...payloadWithout } = CANONICAL_PAYLOAD;
    const res = await (await app).inject({
      method: 'POST',
      url: '/ingest/transcript',
      headers: AUTH,
      payload: payloadWithout,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid');
  });

  // ---- Canonical envelope: malformed wire_version ----

  it('canonical wire_version "1.0" (missing v prefix) returns 400', async () => {
    const { app } = makeApp();
    const res = await (await app).inject({
      method: 'POST',
      url: '/ingest/transcript',
      headers: AUTH,
      payload: { ...CANONICAL_PAYLOAD, wire_version: '1.0' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid');
  });

  it('canonical wire_version "vX.Y" (non-numeric) returns 400', async () => {
    const { app } = makeApp();
    const res = await (await app).inject({
      method: 'POST',
      url: '/ingest/transcript',
      headers: AUTH,
      payload: { ...CANONICAL_PAYLOAD, wire_version: 'vX.Y' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid');
  });

  it('canonical wire_version "v1" (missing minor) returns 400', async () => {
    const { app } = makeApp();
    const res = await (await app).inject({
      method: 'POST',
      url: '/ingest/transcript',
      headers: AUTH,
      payload: { ...CANONICAL_PAYLOAD, wire_version: 'v1' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid');
  });

  // ---- Canonical envelope: empty turns ----

  it('canonical with turns: [] (empty) returns 400', async () => {
    const { app } = makeApp();
    const res = await (await app).inject({
      method: 'POST',
      url: '/ingest/transcript',
      headers: AUTH,
      payload: { ...CANONICAL_PAYLOAD, turns: [] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid');
  });
});
