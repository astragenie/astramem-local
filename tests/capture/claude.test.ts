// FEAT-449 — Claude Code transcript capture connector.
//
// The ingest pipeline was starved (0 successful ingests, 786 "transcript
// file not found" — see CLAUDE.md / FEAT-449): the client-side hook read the
// Claude transcript file on a DEFERRED sweep that raced worktree/subagent
// cleanup. This module reads the transcript CONTENT at invocation time
// instead. Mirrors tests/capture/codex.test.ts's structure.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  parseClaudeTranscript,
  readAndParseClaudeTranscript,
  buildClaudeEnvelope,
  claudeIdempotencyKey,
} from '../../src/capture/claude.js';
import { CanonicalIngestSchema, ingestCanonicalTranscript } from '../../src/server/routes/ingest.js';
import { openDb } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { defaultConfig } from '../../src/config/config.js';

const line = (obj: unknown): string => JSON.stringify(obj);

// Representative Claude Code transcript shape: one JSON object per line,
// `type: 'user'|'assistant'`, nested `message: {role, content}` (content is
// a plain string OR an array of Anthropic content blocks — only `text`
// blocks are conversational).
const SESSION = [
  line({ type: 'user', sessionId: 'sess-claude-1', cwd: '/home/u/proj-y', message: { role: 'user', content: 'fix the login bug' } }),
  line({ type: 'assistant', sessionId: 'sess-claude-1', cwd: '/home/u/proj-y', message: { role: 'assistant', content: [{ type: 'text', text: 'Fixed: token expiry used < instead of <=.' }] } }),
  line({ type: 'assistant', sessionId: 'sess-claude-1', cwd: '/home/u/proj-y', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'x', name: 'Read', input: {} }] } }),
  'this line is not json {',
].join('\n');

const SESSION_STRING_CONTENT_ONLY = [
  line({ type: 'user', sessionId: 'sess-claude-2', message: { role: 'user', content: 'what port does the daemon use' } }),
  line({ type: 'assistant', sessionId: 'sess-claude-2', message: { role: 'assistant', content: '7777.' } }),
].join('\n');

describe('parseClaudeTranscript', () => {
  it('parses user/assistant turns, filters non-text blocks, tolerates a corrupt line', () => {
    const parsed = parseClaudeTranscript(SESSION, '/x/session.jsonl');
    expect(parsed.sessionId).toBe('sess-claude-1');
    expect(parsed.cwd).toBe('/home/u/proj-y');
    expect(parsed.turns).toEqual([
      { role: 'user', text: 'fix the login bug' },
      { role: 'assistant', text: 'Fixed: token expiry used < instead of <=.' },
    ]);
  });

  it('handles plain-string message content (no content-block array)', () => {
    const parsed = parseClaudeTranscript(SESSION_STRING_CONTENT_ONLY, '/x/session2.jsonl');
    expect(parsed.turns).toEqual([
      { role: 'user', text: 'what port does the daemon use' },
      { role: 'assistant', text: '7777.' },
    ]);
  });

  it('falls back to the filename for session id when no sessionId field is present', () => {
    const parsed = parseClaudeTranscript(
      line({ type: 'user', message: { role: 'user', content: 'hi' } }),
      '/x/agent-abc123.jsonl',
    );
    expect(parsed.sessionId).toBe('agent-abc123');
  });

  it('never throws on garbage input', () => {
    expect(parseClaudeTranscript('', '/x/a.jsonl').turns).toEqual([]);
    expect(parseClaudeTranscript('not json\n[1,2,3]\nnull', '/x/a.jsonl').turns).toEqual([]);
  });
});

describe('readAndParseClaudeTranscript — AC-1 (reads at invocation)', () => {
  it('reads a real file from disk at call time and parses it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-capture-'));
    try {
      const p = join(dir, 'agent-1.jsonl');
      writeFileSync(p, SESSION);
      const parsed = readAndParseClaudeTranscript(p);
      expect(parsed.sessionId).toBe('sess-claude-1');
      expect(parsed.turns).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it('throws when the file does not exist (caller — the CLI — turns this into AC-3 soft-fail)', () => {
    expect(() => readAndParseClaudeTranscript(join(tmpdir(), 'does-not-exist-claude', 'x.jsonl'))).toThrow();
  });
});

describe('buildClaudeEnvelope', () => {
  it('produces a schema-valid capture@1 canonical transcript envelope', () => {
    const parsed = parseClaudeTranscript(SESSION, '/x/session.jsonl');
    const env = buildClaudeEnvelope(parsed, 'subagent_stop', '0.9.0', '2026-07-09T12:00:00.000Z');
    expect(env.project_id).toBe('proj-y');
    expect(env.session_id).toBe('claude-sess-claude-1');
    expect(env.tool).toBe('claude-code');
    expect(env.event).toBe('subagent_stop');
    expect(env.wire_version).toMatch(/^v(?:0|[1-9][0-9]*)\.[0-9]+$/);
    const validated = CanonicalIngestSchema.safeParse(env);
    expect(validated.success).toBe(true);
  });

  it('derives a worktree-safe project_id (FEAT-425 basename heuristic)', () => {
    const parsed = parseClaudeTranscript(
      [
        line({ type: 'user', sessionId: 's1', cwd: '/home/u/astramemory-local-worktrees/wt-419', message: { role: 'user', content: 'hi' } }),
        line({ type: 'assistant', sessionId: 's1', cwd: '/home/u/astramemory-local-worktrees/wt-419', message: { role: 'assistant', content: 'hello' } }),
      ].join('\n'),
      '/x/agent.jsonl',
    );
    const env = buildClaudeEnvelope(parsed, 'session_end', '0.9.0');
    expect(env.project_id).toBe('astramemory-local');
  });
});

describe('claudeIdempotencyKey — AC-2 (content-stable, captured_at-independent)', () => {
  it('is stable across two invocations on identical content even with different captured_at', () => {
    const parsed = parseClaudeTranscript(SESSION, '/x/session.jsonl');
    const envA = buildClaudeEnvelope(parsed, 'subagent_stop', '0.9.0', '2026-07-09T12:00:00.000Z');
    const envB = buildClaudeEnvelope(parsed, 'subagent_stop', '0.9.0', '2026-07-09T15:30:00.000Z');
    expect(claudeIdempotencyKey(envA)).toBe(claudeIdempotencyKey(envB));
  });

  it('differs for different content', () => {
    const parsedA = parseClaudeTranscript(SESSION, '/x/session.jsonl');
    const parsedB = parseClaudeTranscript(SESSION_STRING_CONTENT_ONLY, '/x/session2.jsonl');
    const envA = buildClaudeEnvelope(parsedA, 'subagent_stop', '0.9.0');
    const envB = buildClaudeEnvelope(parsedB, 'subagent_stop', '0.9.0');
    expect(claudeIdempotencyKey(envA)).not.toBe(claudeIdempotencyKey(envB));
  });
});

describe('end-to-end: envelope round-trips through ingestCanonicalTranscript', () => {
  it('ingests once, replays on identical re-send (same key)', () => {
    const db = openDb(':memory:');
    migrate(db);
    const config = defaultConfig();
    const parsed = parseClaudeTranscript(SESSION, '/x/session.jsonl');
    const envelope = buildClaudeEnvelope(parsed, 'subagent_stop', '0.9.0', '2026-07-09T12:00:00.000Z');
    const key = claudeIdempotencyKey(envelope);

    const first = ingestCanonicalTranscript(db, config, envelope, key);
    expect(first.transcriptId).toBeTruthy();

    let replayId: string | undefined;
    try {
      ingestCanonicalTranscript(db, config, envelope, key);
      expect.fail('expected IdempotentReplayError');
    } catch (err) {
      replayId = (err as { replayId?: string }).replayId;
    }
    expect(replayId).toBe(first.transcriptId);

    const job = db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE kind = 'distill'`).get() as { n: number };
    expect(job.n).toBe(1);
    const transcript = db.prepare('SELECT source FROM transcripts').get() as { source: string };
    expect(transcript.source).toContain('subagent_stop');
  });
});
