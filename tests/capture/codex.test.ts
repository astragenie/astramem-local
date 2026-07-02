// Wave 4c — Codex CLI capture connector (ADR-008). Codex first, Cursor postponed.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  parseCodexSession,
  buildCodexEnvelope,
  codexIdempotencyKey,
  scanCodexSessionFiles,
  findNewSessions,
} from '../../src/capture/codex.js';
import { CanonicalIngestSchema } from '../../src/server/routes/ingest.js';
import { openDb } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { buildApp } from '../../src/server/app.js';

const line = (obj: unknown): string => JSON.stringify(obj);

// Modern Codex shape: session_meta + response_item wrappers.
const MODERN_SESSION = [
  line({ type: 'session_meta', payload: { id: 'sess-abc', cwd: '/home/u/proj-x', timestamp: '2026-07-02T10:00:00Z' } }),
  line({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<user_instructions>be terse</user_instructions>' }] } }),
  line({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'fix the login bug' }] } }),
  line({ type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{}' } }),
  line({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Fixed: token expiry used < instead of <=.' }] } }),
  'this line is not json {',
].join('\n');

// Legacy shape: bare message items, no meta.
const LEGACY_SESSION = [
  line({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'what port does the daemon use' }] }),
  line({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '7777.' }] }),
].join('\n');

describe('parseCodexSession', () => {
  it('parses modern wrapped sessions: meta, turns, injected-context and tool-call filtering', () => {
    const parsed = parseCodexSession(MODERN_SESSION, '/x/rollout-2026.jsonl');
    expect(parsed.sessionId).toBe('sess-abc');
    expect(parsed.cwd).toBe('/home/u/proj-x');
    expect(parsed.turns).toEqual([
      { role: 'user', text: 'fix the login bug' },
      { role: 'assistant', text: 'Fixed: token expiry used < instead of <=.' },
    ]);
  });

  it('parses legacy bare-message sessions, falling back to filename for session id', () => {
    const parsed = parseCodexSession(LEGACY_SESSION, '/x/rollout-legacy-01.jsonl');
    expect(parsed.sessionId).toBe('rollout-legacy-01');
    expect(parsed.cwd).toBeNull();
    expect(parsed.turns).toHaveLength(2);
  });

  it('never throws on garbage input', () => {
    expect(parseCodexSession('', '/x/a.jsonl').turns).toEqual([]);
    expect(parseCodexSession('not json\n[1,2,3]\nnull', '/x/a.jsonl').turns).toEqual([]);
  });
});

describe('buildCodexEnvelope', () => {
  it('produces a schema-valid capture@1 transcript envelope', () => {
    const parsed = parseCodexSession(MODERN_SESSION, '/x/r.jsonl');
    const env = buildCodexEnvelope(parsed, '0.5.0', '2026-07-02T12:00:00.000Z');
    expect(env.project_id).toBe('proj-x');
    expect(env.session_id).toBe('codex-sess-abc');
    expect(env.tool).toBe('codex-cli');
    const validated = CanonicalIngestSchema.safeParse(env);
    expect(validated.success).toBe(true);
  });

  it('idempotency key is stable for same content, distinct for different content', () => {
    const a = parseCodexSession(MODERN_SESSION, '/x/r.jsonl');
    const b = parseCodexSession(MODERN_SESSION, '/x/r.jsonl');
    const c = parseCodexSession(LEGACY_SESSION, '/x/r2.jsonl');
    expect(codexIdempotencyKey(a)).toBe(codexIdempotencyKey(b));
    expect(codexIdempotencyKey(a)).not.toBe(codexIdempotencyKey(c));
  });
});

describe('session scanning + capture state', () => {
  it('finds nested jsonl files, skips unchanged ones via state, skips no-exchange sessions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-scan-'));
    try {
      const day = join(dir, '2026', '07', '02');
      mkdirSync(day, { recursive: true });
      writeFileSync(join(day, 'rollout-a.jsonl'), MODERN_SESSION);
      writeFileSync(join(day, 'rollout-b.jsonl'), line({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'lone prompt' }] }));
      writeFileSync(join(day, 'notes.txt'), 'not a session');

      expect(scanCodexSessionFiles(dir)).toHaveLength(2);

      const fresh = findNewSessions(dir, {});
      expect(fresh).toHaveLength(1); // rollout-b has no assistant turn
      const first = fresh[0]!;
      expect(first.parsed.sessionId).toBe('sess-abc');

      // Same size → skipped on the next run.
      const state = { [first.filePath]: { size: first.size } };
      expect(findNewSessions(dir, state)).toHaveLength(0);

      // File grows (Codex appends) → re-captured.
      writeFileSync(first.filePath, MODERN_SESSION + '\n' + line({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'more' }] }));
      expect(findNewSessions(dir, state)).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it('missing sessions dir yields empty, not an error', () => {
    expect(scanCodexSessionFiles(join(tmpdir(), 'does-not-exist-codex'))).toEqual([]);
  });
});

describe('end-to-end: envelope round-trips through POST /ingest/transcript', () => {
  it('ingests once, replays on identical re-send', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const app = await buildApp({ db, token: 't' });
    const parsed = parseCodexSession(MODERN_SESSION, '/x/r.jsonl');
    const envelope = buildCodexEnvelope(parsed, '0.5.0', '2026-07-02T12:00:00.000Z');
    const headers = {
      authorization: 'Bearer t',
      'idempotency-key': codexIdempotencyKey(parsed),
    };

    const first = await app.inject({ method: 'POST', url: '/ingest/transcript', headers, payload: envelope });
    expect(first.statusCode).toBe(200);
    expect(first.json().idempotent).toBe(false);

    const replay = await app.inject({ method: 'POST', url: '/ingest/transcript', headers, payload: envelope });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().idempotent).toBe(true);

    const job = db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE kind = 'distill'`).get() as { n: number };
    expect(job.n).toBe(1);
    const transcript = db.prepare('SELECT source FROM transcripts').get() as { source: string };
    expect(transcript.source).toContain('session_end');
  });
});
