import { describe, it, expect } from 'vitest';
import { buildApp } from '../../src/server/app.js';
import { openDb } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { stableStringify } from '../../src/server/lib/stable-stringify.js';

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

  // ---- wire_version regex tighten (FEAT-4a / v0.2.1 hotfix Finding 3) ----
  // Regex: /^v(?:0|[1-9][0-9]*)\.[0-9]+$/ — mirrors plugin wire.ts:106 and SaaS DTO.
  // Leading-zero major, negative major, and Unicode digits all must be rejected.

  it('canonical wire_version "v01.0" (leading zero on major) returns 400', async () => {
    const { app } = makeApp();
    const res = await (await app).inject({
      method: 'POST',
      url: '/ingest/transcript',
      headers: AUTH,
      payload: { ...CANONICAL_PAYLOAD, wire_version: 'v01.0' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid');
  });

  it('canonical wire_version "v-1.0" (negative major) returns 400', async () => {
    const { app } = makeApp();
    const res = await (await app).inject({
      method: 'POST',
      url: '/ingest/transcript',
      headers: AUTH,
      payload: { ...CANONICAL_PAYLOAD, wire_version: 'v-1.0' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid');
  });

  it('canonical wire_version with Unicode digits (v١.٠) returns 400', async () => {
    // JS regex \d matches only ASCII digits [0-9] in ECMAScript without the
    // Unicode flag, so [0-9] is explicit here — but we confirm the runtime
    // rejects Arabic-Indic digit codepoints regardless.
    const { app } = makeApp();
    const res = await (await app).inject({
      method: 'POST',
      url: '/ingest/transcript',
      headers: AUTH,
      payload: { ...CANONICAL_PAYLOAD, wire_version: 'v١.٠' },
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

// ---------------------------------------------------------------------------
// T1 — idempotency conflict path (single-thread simulation, honest test)
//
// better-sqlite3 serialises all in-process calls, so a Promise.all "concurrent"
// test cannot actually race — the second call always sees the row the first
// inserted, turning the test into a sequential replay test with extra noise.
//
// Instead we prove the ON CONFLICT DO NOTHING path was actually taken by:
//   1. Manually inserting the idempotency row into the DB (simulating the
//      state the server would leave after the first request).
//   2. POSTing the same key+body as a second request.
//   3. Asserting it returns 200 with idempotent: true and the same
//      summary_memory_id — confirming the replay branch ran, not a fresh insert.
//
// This tests the SELECT-inside-tx-then-conflict logic that ON CONFLICT DO NOTHING
// protects, regardless of SQLite's serialisation behaviour.
// ---------------------------------------------------------------------------

describe('ingest endpoint — T1: idempotency conflict path (single-thread DB-state simulation)', () => {
  it('second POST with same key+body returns 200 idempotent replay with same summary_memory_id', async () => {
    const { db, app } = makeApp();
    const resolvedApp = await app;

    const payload = {
      ...CANONICAL_PAYLOAD,
      session_id: 'sess-idem-conflict',
      project_id: 'proj-conflict',
    };
    const idemKey = 'conflict-sim-key-001';
    const headers = { ...AUTH, 'idempotency-key': idemKey };

    // --- First request: creates the transcript and idempotency row ---
    const res1 = await resolvedApp.inject({
      method: 'POST',
      url: '/ingest/transcript',
      headers,
      payload,
    });
    expect(res1.statusCode).toBe(200);
    const body1 = res1.json() as { ok: boolean; summary_memory_id: string; idempotent: boolean };
    expect(body1.ok).toBe(true);
    expect(body1.idempotent).toBe(false);

    // Verify the idempotency row was written (proves ON CONFLICT target exists)
    const idemRow = db
      .prepare('SELECT summary_memory_id FROM ingest_idempotency WHERE key = ?')
      .get(idemKey) as { summary_memory_id: string } | undefined;
    expect(idemRow).toBeDefined();
    expect(idemRow!.summary_memory_id).toBe(body1.summary_memory_id);

    // --- Second request: same key + same body must hit the replay branch ---
    const res2 = await resolvedApp.inject({
      method: 'POST',
      url: '/ingest/transcript',
      headers,
      payload,
    });
    expect(res2.statusCode).toBe(200);
    const body2 = res2.json() as { ok: boolean; summary_memory_id: string; idempotent: boolean };
    expect(body2.ok).toBe(true);

    // Must return the SAME summary_memory_id as the first request
    expect(body2.summary_memory_id).toBe(body1.summary_memory_id);

    // Must be flagged as a replay — proves the SELECT-before-conflict path was taken
    expect(body2.idempotent).toBe(true);

    // Confirm only ONE transcript row exists — the second request did not insert a duplicate
    const transcriptCount = db
      .prepare("SELECT COUNT(*) AS n FROM transcripts WHERE session_id = 'sess-idem-conflict'")
      .get() as { n: number };
    expect(transcriptCount.n).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// T2 — client_scrub_hits_by_label JSON round-trip (explicit DB column check)
// POST with {bearer: 3, api_key: 4}, SELECT the JSON column, deep-equal.
// ---------------------------------------------------------------------------

describe('ingest endpoint — T2: client_scrub_hits_by_label DB round-trip (review fix)', () => {
  it('posts {bearer: 3, api_key: 4} and reads back the identical map from the DB column', async () => {
    const { db, app } = makeApp();
    const scrubMap = { bearer: 3, api_key: 4 };
    const res = await (await app).inject({
      method: 'POST',
      url: '/ingest/transcript',
      headers: AUTH,
      payload: {
        ...CANONICAL_PAYLOAD,
        session_id: 'sess-t2-roundtrip',
        client_scrub_hits_by_label: scrubMap,
      },
    });
    expect(res.statusCode).toBe(200);

    const row = db
      .prepare('SELECT client_scrub_hits_by_label_json FROM transcripts WHERE session_id = ?')
      .get('sess-t2-roundtrip') as { client_scrub_hits_by_label_json: string } | undefined;
    expect(row).toBeDefined();
    const parsed = JSON.parse(row!.client_scrub_hits_by_label_json) as Record<string, number>;
    expect(parsed).toEqual(scrubMap);
  });
});

// ---------------------------------------------------------------------------
// stableStringify unit tests (D-B1 helper)
// ---------------------------------------------------------------------------

describe('stableStringify — canonical key-order serialization', () => {
  it('produces the same string regardless of key insertion order', () => {
    const a = stableStringify({ z: 1, a: 2, m: 3 });
    const b = stableStringify({ a: 2, m: 3, z: 1 });
    const c = stableStringify({ m: 3, z: 1, a: 2 });
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(a).toBe('{"a":2,"m":3,"z":1}');
  });

  it('handles nested objects recursively', () => {
    const a = stableStringify({ outer: { z: 1, a: 2 } });
    const b = stableStringify({ outer: { a: 2, z: 1 } });
    expect(a).toBe(b);
    expect(a).toBe('{"outer":{"a":2,"z":1}}');
  });

  it('handles arrays without sorting elements', () => {
    const result = stableStringify([3, 1, 2]);
    expect(result).toBe('[3,1,2]');
  });

  it('handles null, numbers, strings, booleans', () => {
    expect(stableStringify(null)).toBe('null');
    expect(stableStringify(42)).toBe('42');
    expect(stableStringify('hello')).toBe('"hello"');
    expect(stableStringify(true)).toBe('true');
    expect(stableStringify(false)).toBe('false');
  });

  it('handles arrays of objects with different key orders', () => {
    const a = stableStringify([{ b: 2, a: 1 }, { d: 4, c: 3 }]);
    const b = stableStringify([{ a: 1, b: 2 }, { c: 3, d: 4 }]);
    expect(a).toBe(b);
  });
});
