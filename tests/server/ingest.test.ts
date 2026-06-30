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

  // ---- Canonical envelope happy path (stage 3: real insert) ----

  it('canonical envelope happy path creates session + transcript + distill job', async () => {
    const { db, app } = makeApp();
    const res = await (await app).inject({
      method: 'POST',
      url: '/ingest/transcript',
      headers: AUTH,
      payload: CANONICAL_PAYLOAD,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.idempotent).toBe(false);
    expect(typeof body.summary_memory_id).toBe('string');
    expect(body.session_id).toBe(CANONICAL_PAYLOAD.session_id);

    // session row
    const sessions = db.prepare('SELECT * FROM sessions WHERE id = ?').all(CANONICAL_PAYLOAD.session_id) as Record<string, unknown>[];
    expect(sessions.length).toBe(1);
    expect(sessions[0]!['project']).toBe(CANONICAL_PAYLOAD.project_id);
    expect(sessions[0]!['repo']).toBeNull();

    // transcript row — all new columns populated
    const transcripts = db
      .prepare('SELECT * FROM transcripts WHERE session_id = ?')
      .all(CANONICAL_PAYLOAD.session_id) as Record<string, unknown>[];
    expect(transcripts.length).toBe(1);
    const t = transcripts[0]!;
    expect(t['event']).toBe('pre_compact');
    expect(t['source']).toBe('claude-code-pre_compact');
    expect(t['wire_version']).toBe('v1.0');
    expect(t['client_scrub_applied']).toBe(1);
    expect(t['client_scrub_hits']).toBe(0);
    expect(t['client_version']).toBe('0.6.0');
    expect(t['client_scrub_version']).toBe('1.2.0');
    expect(t['client_scrub_hits_by_label_json']).toBeNull();
    // content is JSON-serialised turns
    const parsedContent = JSON.parse(t['content'] as string) as unknown[];
    expect(parsedContent).toHaveLength(2);
    // captured_at is epoch ms
    expect(t['captured_at']).toBe(new Date(CANONICAL_PAYLOAD.captured_at).getTime());
    // summary_memory_id in response matches transcript id
    expect(body.summary_memory_id).toBe(t['id']);

    // distill job
    const jobs = db.prepare("SELECT * FROM jobs WHERE state = 'pending'").all() as Record<string, unknown>[];
    expect(jobs.length).toBe(1);
    expect(jobs[0]!['kind']).toBe('distill');
    const payload = JSON.parse(jobs[0]!['payload_json'] as string) as { transcript_id: string; session_id: string };
    expect(payload.transcript_id).toBe(t['id']);
    expect(payload.session_id).toBe(CANONICAL_PAYLOAD.session_id);
  });

  it('canonical envelope with all optional fields round-trips through DB', async () => {
    const { db, app } = makeApp();
    const payload = {
      ...CANONICAL_PAYLOAD,
      session_id: 'sess-optional-fields',
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

    const sessions = db.prepare('SELECT * FROM sessions WHERE id = ?').all('sess-optional-fields') as Record<string, unknown>[];
    expect(sessions[0]!['agent']).toBe('claude-code');
  });

  it('client_scrub_hits_by_label round-trips through client_scrub_hits_by_label_json column', async () => {
    const { db, app } = makeApp();
    const res = await (await app).inject({
      method: 'POST',
      url: '/ingest/transcript',
      headers: AUTH,
      payload: {
        ...CANONICAL_PAYLOAD,
        session_id: 'sess-label-roundtrip',
        client_scrub_hits_by_label: { bearer: 3, api_key: 4 },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);

    const row = db.prepare('SELECT client_scrub_hits_by_label_json FROM transcripts WHERE session_id = ?')
      .get('sess-label-roundtrip') as { client_scrub_hits_by_label_json: string };
    expect(row).toBeDefined();
    const parsed = JSON.parse(row.client_scrub_hits_by_label_json) as Record<string, number>;
    expect(parsed).toEqual({ bearer: 3, api_key: 4 });
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

// ---------------------------------------------------------------------------
// Idempotency tests (FEAT-4a Phase 2 Stage 3)
// ---------------------------------------------------------------------------

describe('ingest endpoint — idempotency (FEAT-4a)', () => {
  const IDEM_PAYLOAD = {
    ...CANONICAL_PAYLOAD,
    session_id: 'sess-idem',
    project_id: 'proj-idem',
  };

  const IDEM_HEADERS = { ...AUTH, 'idempotency-key': 'idem-key-001' };

  it('same key + same body → second response has idempotent: true, no new rows', async () => {
    const { db, app } = makeApp();
    const resolvedApp = await app;

    // First request — creates the row
    const res1 = await resolvedApp.inject({
      method: 'POST',
      url: '/ingest/transcript',
      headers: IDEM_HEADERS,
      payload: IDEM_PAYLOAD,
    });
    expect(res1.statusCode).toBe(200);
    const body1 = res1.json();
    expect(body1.idempotent).toBe(false);
    const firstId = body1.summary_memory_id as string;

    // Second request — exact same key + same body
    const res2 = await resolvedApp.inject({
      method: 'POST',
      url: '/ingest/transcript',
      headers: IDEM_HEADERS,
      payload: IDEM_PAYLOAD,
    });
    expect(res2.statusCode).toBe(200);
    const body2 = res2.json();
    expect(body2.idempotent).toBe(true);
    expect(body2.summary_memory_id).toBe(firstId);

    // Only one transcript row and one job row should exist
    const transcripts = db.prepare('SELECT * FROM transcripts WHERE session_id = ?').all('sess-idem');
    expect(transcripts.length).toBe(1);
    const jobs = db.prepare("SELECT * FROM jobs WHERE state = 'pending'").all();
    expect(jobs.length).toBe(1);
  });

  it('same key + different body → 409 idempotency_conflict', async () => {
    const { app } = makeApp();
    const resolvedApp = await app;

    // First request
    await resolvedApp.inject({
      method: 'POST',
      url: '/ingest/transcript',
      headers: IDEM_HEADERS,
      payload: IDEM_PAYLOAD,
    });

    // Second request — same key, different body (altered turns)
    const res2 = await resolvedApp.inject({
      method: 'POST',
      url: '/ingest/transcript',
      headers: IDEM_HEADERS,
      payload: { ...IDEM_PAYLOAD, turns: [{ role: 'user' as const, text: 'Different content' }] },
    });
    expect(res2.statusCode).toBe(409);
    const body2 = res2.json();
    expect(body2.error).toBe('idempotency_conflict');
    expect(body2.idempotency_key).toBe('idem-key-001');
    expect(typeof body2.detail).toBe('string');
  });

  it('no idempotency-key header → no row in ingest_idempotency', async () => {
    const { db, app } = makeApp();
    const res = await (await app).inject({
      method: 'POST',
      url: '/ingest/transcript',
      headers: AUTH, // no idempotency-key
      payload: { ...IDEM_PAYLOAD, session_id: 'sess-no-key' },
    });
    expect(res.statusCode).toBe(200);
    const rows = db.prepare('SELECT * FROM ingest_idempotency').all();
    expect(rows.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Legacy envelope regression guard after migrations (FEAT-4a Phase 2 Stage 3)
// ---------------------------------------------------------------------------

describe('ingest endpoint — legacy regression guard', () => {
  it('legacy envelope still creates session + transcript + distill job after migration', async () => {
    const { db, app } = makeApp();
    const res = await (await app).inject({
      method: 'POST',
      url: '/ingest/transcript',
      headers: AUTH,
      payload: LEGACY_PAYLOAD,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);

    const sessions = db.prepare('SELECT * FROM sessions WHERE id = ?').all('s1') as Record<string, unknown>[];
    const transcripts = db.prepare('SELECT * FROM transcripts WHERE session_id = ?').all('s1') as Record<string, unknown>[];
    const jobs = db.prepare("SELECT * FROM jobs WHERE state = 'pending'").all();

    expect(sessions.length).toBe(1);
    expect(transcripts.length).toBe(1);
    expect(jobs.length).toBe(1);

    // Legacy rows: wire_version gets DB default 'v0.0', new columns are null
    const t = transcripts[0]!;
    expect(t['wire_version']).toBe('v0.0');
    expect(t['event']).toBeNull();
    expect(t['captured_at']).toBeNull();
  });
});
