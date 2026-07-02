import { describe, it, expect } from 'vitest';
import { buildApp } from '../../src/server/app.js';
import { openDb } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';

// ---------------------------------------------------------------------------
// ADR-008 events capture kind — schema + redaction + job-enqueue coverage.
// Mirrors tests/server/ingest.test.ts helpers/conventions.
// ---------------------------------------------------------------------------

function makeApp() {
  const db = openDb(':memory:');
  migrate(db);
  return { db, app: buildApp({ db, token: 't' }) };
}

const AUTH = { authorization: 'Bearer t', 'content-type': 'application/json' } as const;

/** Minimal valid canonical transcript-kind payload (regression baseline) */
const TRANSCRIPT_PAYLOAD = {
  event: 'pre_compact' as const,
  session_id: 'sess-transcript-regression',
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

/** Minimal valid events-kind payload */
const EVENTS_PAYLOAD = {
  event: 'session_end' as const,
  session_id: 'sess-events-1',
  project_id: 'proj-events',
  captured_at: '2026-07-02T10:00:00.000Z',
  kind: 'events' as const,
  tool: 'runner-plugin',
  client_scrub_applied: false,
  client_scrub_hits: 0,
  client_version: '0.1.0',
  client_scrub_version: 'n/a',
  wire_version: 'v1.0',
  events: [
    {
      type: 'lesson' as const,
      text: 'Bun does not support better-sqlite3 native bindings on Windows in CI.',
      importance: 0.8,
      confidence: 0.95,
      evidence: 'npm test failed with a native module load error',
    },
    {
      type: 'decision' as const,
      text: 'Events kind ships stages 6-8 only, no schema change.',
      importance: 0.6,
    },
  ],
};

describe('ingest endpoint — events kind (ADR-008)', () => {
  it('events kind accepted — creates session + transcript(events) + distill-events job', async () => {
    const { db, app } = makeApp();
    const res = await (await app).inject({
      method: 'POST',
      url: '/ingest/transcript',
      headers: AUTH,
      payload: EVENTS_PAYLOAD,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.idempotent).toBe(false);
    expect(typeof body.summary_memory_id).toBe('string');
    expect(body.session_id).toBe(EVENTS_PAYLOAD.session_id);

    const sessions = db.prepare('SELECT * FROM sessions WHERE id = ?').all(EVENTS_PAYLOAD.session_id) as Record<string, unknown>[];
    expect(sessions.length).toBe(1);

    const transcripts = db.prepare('SELECT * FROM transcripts WHERE session_id = ?').all(EVENTS_PAYLOAD.session_id) as Record<string, unknown>[];
    expect(transcripts.length).toBe(1);
    const t = transcripts[0]!;
    expect(t['source']).toBe('runner-plugin-events');
    expect(t['wire_version']).toBe('v1.0');

    const storedEvents = JSON.parse(t['content'] as string) as Array<{ type: string; text: string }>;
    expect(storedEvents).toHaveLength(2);
    expect(storedEvents[0]!.type).toBe('lesson');

    const jobs = db.prepare("SELECT * FROM jobs WHERE state = 'pending'").all() as Record<string, unknown>[];
    expect(jobs.length).toBe(1);
    expect(jobs[0]!['kind']).toBe('distill-events');
    const jobPayload = JSON.parse(jobs[0]!['payload_json'] as string) as { transcript_id: string; session_id: string };
    expect(jobPayload.transcript_id).toBe(t['id']);
    expect(jobPayload.session_id).toBe(EVENTS_PAYLOAD.session_id);
  });

  it('source label falls back to "events" when tool is omitted', async () => {
    const { db, app } = makeApp();
    const { tool: _omit, ...payloadWithoutTool } = EVENTS_PAYLOAD;
    const res = await (await app).inject({
      method: 'POST',
      url: '/ingest/transcript',
      headers: AUTH,
      payload: { ...payloadWithoutTool, session_id: 'sess-events-no-tool' },
    });
    expect(res.statusCode).toBe(200);
    const t = db.prepare('SELECT source FROM transcripts WHERE session_id = ?').get('sess-events-no-tool') as { source: string };
    expect(t.source).toBe('events');
  });

  it('bad event type rejected 400', async () => {
    const { app } = makeApp();
    const res = await (await app).inject({
      method: 'POST',
      url: '/ingest/transcript',
      headers: AUTH,
      payload: {
        ...EVENTS_PAYLOAD,
        session_id: 'sess-events-bad-type',
        events: [{ type: 'not-a-real-type', text: 'whatever' }],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid');
  });

  it('empty events array rejected 400', async () => {
    const { app } = makeApp();
    const res = await (await app).inject({
      method: 'POST',
      url: '/ingest/transcript',
      headers: AUTH,
      payload: { ...EVENTS_PAYLOAD, session_id: 'sess-events-empty', events: [] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid');
  });

  it('missing events array (kind=events but no events field) rejected 400', async () => {
    const { app } = makeApp();
    const { events: _omit, ...payloadWithoutEvents } = EVENTS_PAYLOAD;
    const res = await (await app).inject({
      method: 'POST',
      url: '/ingest/transcript',
      headers: AUTH,
      payload: { ...payloadWithoutEvents, session_id: 'sess-events-missing' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid');
  });

  it('event text below min length (empty string) rejected 400', async () => {
    const { app } = makeApp();
    const res = await (await app).inject({
      method: 'POST',
      url: '/ingest/transcript',
      headers: AUTH,
      payload: {
        ...EVENTS_PAYLOAD,
        session_id: 'sess-events-empty-text',
        events: [{ type: 'note', text: '' }],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid');
  });

  it('transcript kind (default, no `kind` field) still works — regression', async () => {
    const { db, app } = makeApp();
    const res = await (await app).inject({
      method: 'POST',
      url: '/ingest/transcript',
      headers: AUTH,
      payload: TRANSCRIPT_PAYLOAD,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);

    const jobs = db.prepare("SELECT * FROM jobs WHERE state = 'pending'").all() as Record<string, unknown>[];
    expect(jobs.length).toBe(1);
    expect(jobs[0]!['kind']).toBe('distill');
  });

  it('transcript kind explicit `kind: "transcript"` still works — regression', async () => {
    const { db, app } = makeApp();
    const res = await (await app).inject({
      method: 'POST',
      url: '/ingest/transcript',
      headers: AUTH,
      payload: { ...TRANSCRIPT_PAYLOAD, kind: 'transcript' as const, session_id: 'sess-transcript-explicit-kind' },
    });
    expect(res.statusCode).toBe(200);
    const jobs = db.prepare("SELECT * FROM jobs WHERE state = 'pending'").all() as Record<string, unknown>[];
    expect(jobs[0]!['kind']).toBe('distill');
  });

  it('redaction applies to event text — ghp_ token becomes a placeholder in the stored row', async () => {
    const { db, app } = makeApp();
    const secret = 'ghp_' + 'a'.repeat(36);
    const res = await (await app).inject({
      method: 'POST',
      url: '/ingest/transcript',
      headers: AUTH,
      payload: {
        ...EVENTS_PAYLOAD,
        session_id: 'sess-events-redact-text',
        events: [{ type: 'command', text: `use token ${secret} to auth` }],
      },
    });
    expect(res.statusCode).toBe(200);

    const t = db.prepare('SELECT content FROM transcripts WHERE session_id = ?').get('sess-events-redact-text') as { content: string };
    expect(t.content).not.toContain(secret);
    expect(t.content).toMatch(/\[REDACTED:github_token:[0-9a-f]{8}\]/);
  });

  it('redaction applies to event evidence — ghp_ token becomes a placeholder in the stored row', async () => {
    const { db, app } = makeApp();
    const secret = 'ghp_' + 'b'.repeat(36);
    const res = await (await app).inject({
      method: 'POST',
      url: '/ingest/transcript',
      headers: AUTH,
      payload: {
        ...EVENTS_PAYLOAD,
        session_id: 'sess-events-redact-evidence',
        events: [{ type: 'note', text: 'found a leaked token', evidence: `token=${secret}` }],
      },
    });
    expect(res.statusCode).toBe(200);

    const t = db.prepare('SELECT content FROM transcripts WHERE session_id = ?').get('sess-events-redact-evidence') as { content: string };
    expect(t.content).not.toContain(secret);
    expect(t.content).toMatch(/\[REDACTED:github_token:[0-9a-f]{8}\]/);
  });

  it('events kind respects the 500-event max cap — 501 events rejected 400', async () => {
    const { app } = makeApp();
    const events = Array.from({ length: 501 }, (_, i) => ({ type: 'note' as const, text: `event ${i}` }));
    const res = await (await app).inject({
      method: 'POST',
      url: '/ingest/transcript',
      headers: AUTH,
      payload: { ...EVENTS_PAYLOAD, session_id: 'sess-events-over-cap', events },
    });
    expect(res.statusCode).toBe(400);
  });

  it('events kind idempotency — same key + same body → second response idempotent, no new rows', async () => {
    const { db, app } = makeApp();
    const resolvedApp = await app;
    const headers = { ...AUTH, 'idempotency-key': 'events-idem-key-1' };
    const payload = { ...EVENTS_PAYLOAD, session_id: 'sess-events-idem' };

    const res1 = await resolvedApp.inject({ method: 'POST', url: '/ingest/transcript', headers, payload });
    expect(res1.statusCode).toBe(200);
    const body1 = res1.json();
    expect(body1.idempotent).toBe(false);

    const res2 = await resolvedApp.inject({ method: 'POST', url: '/ingest/transcript', headers, payload });
    expect(res2.statusCode).toBe(200);
    const body2 = res2.json();
    expect(body2.idempotent).toBe(true);
    expect(body2.summary_memory_id).toBe(body1.summary_memory_id);

    const transcripts = db.prepare('SELECT * FROM transcripts WHERE session_id = ?').all('sess-events-idem');
    expect(transcripts.length).toBe(1);
  });
});
