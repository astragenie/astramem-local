/**
 * Claude Code transcript capture connector (FEAT-449).
 *
 * Root cause (2026-07-09 distill-starvation dig): the ingest pipeline was
 * fully starved — `ingest.log` showed 0 successful ingests and 786
 * `transcript file not found` errors. The astramem-plugin SubagentStop /
 * session_end hook read the Claude Code `.jsonl` transcript file on a
 * DEFERRED sweep, racing worktree/subagent cleanup — by read time the file
 * was already deleted. `/ingest/transcript` only ever accepted CONTENT
 * (never a path — src/server/routes/ingest.ts), so the read-races-cleanup
 * failure was entirely client-side.
 *
 * This module reads the transcript CONTENT at the moment the hook fires
 * (file still guaranteed live) and converts it into the same canonical
 * transcript envelope `/ingest/transcript` already accepts — the VALUE is
 * captured immediately, decoupled from any later read. Mirrors
 * src/capture/codex.ts's structure and tolerance: unknown/malformed lines
 * are skipped, never fatal.
 *
 * Claude Code's on-disk transcript format (main session or a
 * `subagents/agent-*.jsonl` sidecar): one JSON object per line, each
 * carrying `type: 'user' | 'assistant' | ...`, a nested `message: {role,
 * content}` (content is either a plain string or an array of Anthropic
 * content blocks — only `type: 'text'` blocks are conversational), and
 * `sessionId` / `cwd` fields repeated on (most) lines.
 */

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { createHash } from 'node:crypto';
import { deriveWorktreeSafeBasename } from '../pipeline/cwd-basename.js';
import { stableStringify } from '../server/lib/stable-stringify.js';

export interface ClaudeTurn {
  role: 'user' | 'assistant';
  text: string;
}

export interface ParsedClaudeTranscript {
  sessionId: string;
  cwd: string | null;
  turns: ClaudeTurn[];
}

export type ClaudeCaptureEvent = 'subagent_stop' | 'session_end';

export interface ClaudeCaptureEnvelope {
  event: ClaudeCaptureEvent;
  session_id: string;
  project_id: string;
  agent_type: string;
  cwd?: string;
  captured_at: string;
  kind: 'transcript';
  tool: 'claude-code';
  turns: Array<{ role: 'user' | 'assistant'; text: string }>;
  client_scrub_applied: boolean;
  client_scrub_hits: number;
  client_version: string;
  client_scrub_version: string;
  wire_version: 'v1.0';
}

/** Extract conversational text from an Anthropic-shaped message `content`
 *  field — a plain string, or an array of blocks where only `type: 'text'`
 *  blocks carry conversation (tool_use/tool_result/thinking blocks are
 *  skipped, matching codex.ts's `extractText` filtering of non-text parts). */
function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map(part => {
      if (!part || typeof part !== 'object') return '';
      const block = part as { type?: unknown; text?: unknown };
      return block.type === 'text' && typeof block.text === 'string' ? block.text : '';
    })
    .filter(Boolean)
    .join('\n');
}

/** Parse one Claude Code `.jsonl` transcript (main session or a subagent
 *  sidecar) into turns. Never throws on malformed content — partial/corrupt
 *  lines (a transcript still being written) are skipped, not fatal. */
export function parseClaudeTranscript(jsonl: string, filePath: string): ParsedClaudeTranscript {
  let sessionId = basename(filePath, '.jsonl');
  let cwd: string | null = null;
  const turns: ClaudeTurn[] = [];

  for (const raw of jsonl.split('\n')) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    let line: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      line = parsed as Record<string, unknown>;
    } catch {
      continue; // partial/corrupt line (transcript still being written) — skip
    }

    if (typeof line['sessionId'] === 'string') sessionId = line['sessionId'];
    if (typeof line['cwd'] === 'string') cwd = line['cwd'];

    if (line['type'] !== 'user' && line['type'] !== 'assistant') continue;

    const message = line['message'];
    if (!message || typeof message !== 'object') continue;
    const role = (message as Record<string, unknown>)['role'];
    if (role !== 'user' && role !== 'assistant') continue;

    const text = extractText((message as Record<string, unknown>)['content']).trim();
    if (!text) continue;
    turns.push({ role, text });
  }

  return { sessionId, cwd, turns };
}

/** Read + parse a transcript file from disk. Throws (missing/unreadable
 *  file, or any other fs error) — the CLI caller is responsible for turning
 *  that into the AC-3 soft-fail (one warning, non-zero exitCode, no crash). */
export function readAndParseClaudeTranscript(filePath: string): ParsedClaudeTranscript {
  const jsonl = readFileSync(filePath, 'utf8');
  return parseClaudeTranscript(jsonl, filePath);
}

export function buildClaudeEnvelope(
  parsed: ParsedClaudeTranscript,
  event: ClaudeCaptureEvent,
  clientVersion: string,
  capturedAt = new Date().toISOString(),
): ClaudeCaptureEnvelope {
  return {
    event,
    session_id: `claude-${parsed.sessionId}`,
    project_id: deriveWorktreeSafeBasename(parsed.cwd) ?? 'claude-code',
    agent_type: 'claude-code',
    ...(parsed.cwd ? { cwd: parsed.cwd } : {}),
    captured_at: capturedAt,
    kind: 'transcript',
    tool: 'claude-code',
    turns: parsed.turns,
    // Client-side scrub not implemented for Claude capture v1 — the daemon's
    // stage-0 redaction (SEC-3/5) is the enforcement point; report honestly.
    client_scrub_applied: false,
    client_scrub_hits: 0,
    client_version: clientVersion,
    client_scrub_version: 'none',
    wire_version: 'v1.0',
  };
}

/**
 * Stable idempotency key for the durable ingest spool (AC-2): a SHA-256
 * stable-stringify hash of the envelope's CONTENT fields, deliberately
 * excluding `captured_at` (the one field that varies on every invocation
 * even when the underlying transcript is byte-identical). Re-running capture
 * on an unmodified transcript therefore produces the SAME key — the spool
 * write is a same-path overwrite (refreshed captured_at), never a duplicate.
 */
export function claudeIdempotencyKey(envelope: ClaudeCaptureEnvelope): string {
  const { captured_at: _capturedAt, ...stable } = envelope;
  return createHash('sha256').update(stableStringify(stable)).digest('hex');
}
