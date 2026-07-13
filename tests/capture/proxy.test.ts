/**
 * FEAT-458 S3 — LLM proxy capture fork (ADR-013). Unit-level coverage of
 * src/capture/proxy.ts in isolation (no live HTTP, no live proxy server) —
 * body parsing (request JSON + response JSON/SSE), envelope shape,
 * idempotency-key stability, relevance-gate reuse, the setImmediate spool
 * deferral, and fail-silent behavior on malformed input. The full
 * header-exclusion regression test (routing real traffic through the actual
 * proxy) lives in tests/proxy/canary-header-exclusion.test.ts — this file is
 * the module's own contract, independent of the HTTP wiring.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  extractRequestTurns,
  extractResponseTurn,
  proxyIdempotencyKey,
  createProxyCaptureTee,
  type ProxyCaptureEnvelope,
} from '../../src/capture/proxy.js';
import { listSpoolFiles } from '../../src/ingest/spool.js';

const GATE_OPTS = { minChars: 1, maxBytes: 1_000_000, dedupWindow: 20 };

function chatRequestBody(userText: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    model: 'gpt-4',
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: userText },
    ],
    ...extra,
  });
}

function chatResponseBodyNonStreaming(assistantText: string): string {
  return JSON.stringify({
    id: 'chatcmpl-1',
    choices: [{ message: { role: 'assistant', content: assistantText } }],
  });
}

function chatResponseBodySSE(parts: string[]): string {
  const lines = parts.map((p) => `data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`);
  lines.push('data: [DONE]\n\n');
  return lines.join('');
}

// --- Anthropic Messages API fixtures (FEAT-458 S5) --------------------
// Real event framing / field shapes, not simplified stand-ins — this is
// deliberately the weakness the OpenAI-only suite above had.

function anthropicRequestBody(userText: string, opts: { system?: string } = {}): string {
  return JSON.stringify({
    model: 'claude-3-5-sonnet-20241022',
    max_tokens: 1024,
    ...(opts.system ? { system: opts.system } : {}),
    messages: [{ role: 'user', content: userText }],
  });
}

function anthropicRequestBodyBlocks(): string {
  return JSON.stringify({
    model: 'claude-3-5-sonnet-20241022',
    max_tokens: 1024,
    system: 'You are a helpful assistant. Follow these 400 words of boilerplate instructions...',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'part one' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
          { type: 'text', text: 'part two' },
        ],
      },
    ],
  });
}

function anthropicRequestBodyWithToolResult(): string {
  return JSON.stringify({
    model: 'claude-3-5-sonnet-20241022',
    max_tokens: 1024,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_01', content: [{ type: 'text', text: 'tool output, not human input' }] },
          { type: 'text', text: 'the actual follow-up question' },
        ],
      },
    ],
  });
}

function anthropicResponseBodyNonStreaming(assistantText: string): string {
  return JSON.stringify({
    id: 'msg_01',
    type: 'message',
    role: 'assistant',
    model: 'claude-3-5-sonnet-20241022',
    content: [{ type: 'text', text: assistantText }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  });
}

function anthropicResponseBodyToolOnly(): string {
  return JSON.stringify({
    id: 'msg_01',
    type: 'message',
    role: 'assistant',
    model: 'claude-3-5-sonnet-20241022',
    content: [{ type: 'tool_use', id: 'toolu_01', name: 'get_weather', input: { location: 'SF' } }],
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  });
}

/** A minimal, real Anthropic streaming event sequence: message_start ->
 *  content_block_start(text) -> N x content_block_delta(text_delta) ->
 *  content_block_stop -> message_delta -> message_stop. Matches the actual
 *  `event: <type>\ndata: {...}\n\n` framing, not a simplified stand-in. */
function anthropicResponseBodySSE(parts: string[]): string {
  const lines: string[] = [];
  lines.push('event: message_start\n');
  lines.push(
    `data: ${JSON.stringify({ type: 'message_start', message: { id: 'msg_01', type: 'message', role: 'assistant', content: [], model: 'claude-3-5-sonnet-20241022', stop_reason: null, stop_sequence: null, usage: { input_tokens: 25, output_tokens: 1 } } })}\n\n`,
  );
  lines.push('event: content_block_start\n');
  lines.push(`data: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`);
  lines.push('event: ping\n');
  lines.push(`data: ${JSON.stringify({ type: 'ping' })}\n\n`);
  for (const p of parts) {
    lines.push('event: content_block_delta\n');
    lines.push(`data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: p } })}\n\n`);
  }
  lines.push('event: content_block_stop\n');
  lines.push(`data: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`);
  lines.push('event: message_delta\n');
  lines.push(`data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: parts.join('').length } })}\n\n`);
  lines.push('event: message_stop\n');
  lines.push(`data: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
  return lines.join('');
}

/** A streaming response with a text block AND a tool_use block, whose
 *  deltas are interleaved out of index order on the wire (block 1's
 *  input_json_delta arrives between block 0's text_delta chunks) — proves
 *  per-index accumulation, not a single running accumulator. */
function anthropicResponseBodySSEInterleavedToolUse(): string {
  const lines: string[] = [];
  lines.push('event: message_start\n');
  lines.push(`data: ${JSON.stringify({ type: 'message_start', message: { id: 'msg_01', role: 'assistant', content: [], model: 'claude-3-5-sonnet-20241022' } })}\n\n`);
  lines.push('event: content_block_start\n');
  lines.push(`data: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`);
  lines.push('event: content_block_start\n');
  lines.push(`data: ${JSON.stringify({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_01', name: 'get_weather', input: {} } })}\n\n`);
  lines.push('event: content_block_delta\n');
  lines.push(`data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Let me check ' } })}\n\n`);
  lines.push('event: content_block_delta\n');
  lines.push(`data: ${JSON.stringify({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"locat' } })}\n\n`);
  lines.push('event: content_block_delta\n');
  lines.push(`data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'the weather.' } })}\n\n`);
  lines.push('event: content_block_delta\n');
  lines.push(`data: ${JSON.stringify({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 'ion": "SF"}' } })}\n\n`);
  lines.push('event: content_block_stop\n');
  lines.push(`data: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`);
  lines.push('event: content_block_stop\n');
  lines.push(`data: ${JSON.stringify({ type: 'content_block_stop', index: 1 })}\n\n`);
  lines.push('event: message_delta\n');
  lines.push(`data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 45 } })}\n\n`);
  lines.push('event: message_stop\n');
  lines.push(`data: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
  return lines.join('');
}

/** A streaming response that never emits a single text_delta — a pure
 *  tool_use turn (no visible reply text) or an aborted/empty stream. */
function anthropicResponseBodySSEToolOnly(): string {
  const lines: string[] = [];
  lines.push('event: message_start\n');
  lines.push(`data: ${JSON.stringify({ type: 'message_start', message: { id: 'msg_01', role: 'assistant', content: [], model: 'claude-3-5-sonnet-20241022' } })}\n\n`);
  lines.push('event: content_block_start\n');
  lines.push(`data: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_01', name: 'get_weather', input: {} } })}\n\n`);
  lines.push('event: content_block_delta\n');
  lines.push(`data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"location": "SF"}' } })}\n\n`);
  lines.push('event: content_block_stop\n');
  lines.push(`data: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`);
  lines.push('event: message_delta\n');
  lines.push(`data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 12 } })}\n\n`);
  lines.push('event: message_stop\n');
  lines.push(`data: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
  return lines.join('');
}

describe('extractRequestTurns', () => {
  it('extracts only role:"user" messages, skips system/assistant', () => {
    const body = chatRequestBody('what port does the daemon use');
    expect(extractRequestTurns(body)).toEqual([{ role: 'user', text: 'what port does the daemon use' }]);
  });

  it('handles multimodal content blocks (array of {type:"text"} parts), skips non-text parts', () => {
    const body = JSON.stringify({
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'part one' }, { type: 'image_url', image_url: { url: 'x' } }, { type: 'text', text: 'part two' }] },
      ],
    });
    expect(extractRequestTurns(body)).toEqual([{ role: 'user', text: 'part one\npart two' }]);
  });

  it('returns no turns for malformed JSON (fail-silent, never throws)', () => {
    expect(() => extractRequestTurns('not json {')).not.toThrow();
    expect(extractRequestTurns('not json {')).toEqual([]);
  });

  it('returns no turns when messages is missing or not an array', () => {
    expect(extractRequestTurns(JSON.stringify({ model: 'gpt-4' }))).toEqual([]);
    expect(extractRequestTurns(JSON.stringify({ messages: 'nope' }))).toEqual([]);
  });
});

describe('extractResponseTurn', () => {
  it('parses a non-streaming JSON chat-completion response', () => {
    const body = chatResponseBodyNonStreaming('hello there');
    expect(extractResponseTurn(body)).toEqual({ role: 'assistant', text: 'hello there' });
  });

  it('reconstructs an SSE-streamed response by concatenating delta.content across chunks', () => {
    const body = chatResponseBodySSE(['Hel', 'lo, ', 'world!']);
    expect(extractResponseTurn(body)).toEqual({ role: 'assistant', text: 'Hello, world!' });
  });

  it('tolerates a malformed SSE line without losing the rest of the stream', () => {
    const body =
      'data: {"choices":[{"delta":{"content":"good "}}]}\n\n' +
      'data: not-json-at-all\n\n' +
      'data: {"choices":[{"delta":{"content":"chunk"}}]}\n\n' +
      'data: [DONE]\n\n';
    expect(extractResponseTurn(body)).toEqual({ role: 'assistant', text: 'good chunk' });
  });

  it('returns null for an empty body', () => {
    expect(extractResponseTurn('')).toBeNull();
    expect(extractResponseTurn('   ')).toBeNull();
  });

  it('returns null for well-formed JSON that is not a recognized chat-completion shape', () => {
    expect(extractResponseTurn(JSON.stringify({ ok: true }))).toBeNull();
  });

  it('never throws on malformed input', () => {
    expect(() => extractResponseTurn('data: {not json\n\n')).not.toThrow();
  });
});

describe('extractRequestTurns — Anthropic Messages API', () => {
  it('extracts the user turn from a plain-string content field, ignores the top-level system field', () => {
    const body = anthropicRequestBody('what port does the daemon use', { system: 'You are Claude Code, an agentic CLI...' });
    expect(extractRequestTurns(body)).toEqual([{ role: 'user', text: 'what port does the daemon use' }]);
  });

  it('handles content as an array of typed blocks, skips non-text blocks (image), never touches system', () => {
    expect(extractRequestTurns(anthropicRequestBodyBlocks())).toEqual([{ role: 'user', text: 'part one\npart two' }]);
  });

  it('skips tool_result blocks — only the NEW human-authored text block becomes a turn', () => {
    expect(extractRequestTurns(anthropicRequestBodyWithToolResult())).toEqual([
      { role: 'user', text: 'the actual follow-up question' },
    ]);
  });
});

describe('extractResponseTurn — Anthropic Messages API', () => {
  it('parses a non-streaming JSON response (top-level content[] array, no choices field)', () => {
    const body = anthropicResponseBodyNonStreaming('hello there');
    expect(extractResponseTurn(body)).toEqual({ role: 'assistant', text: 'hello there' });
  });

  it('reconstructs an SSE-streamed response from content_block_delta text_delta events', () => {
    const body = anthropicResponseBodySSE(['Hel', 'lo, ', 'world!']);
    expect(extractResponseTurn(body)).toEqual({ role: 'assistant', text: 'Hello, world!' });
  });

  it('returns null for a tool-only non-streaming response (no text block at all)', () => {
    expect(extractResponseTurn(anthropicResponseBodyToolOnly())).toBeNull();
  });

  it('returns null for a tool-only streaming response (no text_delta ever emitted — aborted/empty case)', () => {
    expect(extractResponseTurn(anthropicResponseBodySSEToolOnly())).toBeNull();
  });

  it('accumulates text per content-block index, ignoring interleaved tool_use input_json_delta chunks under a different index', () => {
    const result = extractResponseTurn(anthropicResponseBodySSEInterleavedToolUse());
    expect(result).toEqual({ role: 'assistant', text: 'Let me check the weather.' });
  });

  it('tolerates a malformed data line without losing the rest of the stream', () => {
    const body =
      'event: content_block_delta\n' +
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"good "}}\n\n' +
      'event: content_block_delta\n' +
      'data: not-json-at-all\n\n' +
      'event: content_block_delta\n' +
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"chunk"}}\n\n' +
      'event: message_stop\n' +
      'data: {"type":"message_stop"}\n\n';
    expect(extractResponseTurn(body)).toEqual({ role: 'assistant', text: 'good chunk' });
  });

  it('never throws on malformed input', () => {
    expect(() => extractResponseTurn('event: content_block_delta\ndata: {not json\n\n')).not.toThrow();
  });
});

describe('proxyIdempotencyKey', () => {
  it('is stable across two builds with identical turns despite different session_id/captured_at', () => {
    const envA: ProxyCaptureEnvelope = {
      event: 'session_end', session_id: 'proxy-aaaa', project_id: 'llm-proxy',
      captured_at: '2026-01-01T00:00:00.000Z', kind: 'transcript', tool: 'llm-proxy',
      turns: [{ role: 'user', text: 'hi' }, { role: 'assistant', text: 'hello' }],
      client_scrub_applied: false, client_scrub_hits: 0, client_version: '1.0.0',
      client_scrub_version: 'none', wire_version: 'v1.0', capture_source: 'proxy',
    };
    const envB: ProxyCaptureEnvelope = {
      ...envA, session_id: 'proxy-bbbb', captured_at: '2026-06-01T12:34:56.000Z',
    };
    expect(proxyIdempotencyKey(envA)).toBe(proxyIdempotencyKey(envB));
  });

  it('differs when the turns content differs', () => {
    const base: ProxyCaptureEnvelope = {
      event: 'session_end', session_id: 'proxy-aaaa', project_id: 'llm-proxy',
      captured_at: '2026-01-01T00:00:00.000Z', kind: 'transcript', tool: 'llm-proxy',
      turns: [{ role: 'user', text: 'hi' }],
      client_scrub_applied: false, client_scrub_hits: 0, client_version: '1.0.0',
      client_scrub_version: 'none', wire_version: 'v1.0', capture_source: 'proxy',
    };
    const other: ProxyCaptureEnvelope = { ...base, turns: [{ role: 'user', text: 'bye' }] };
    expect(proxyIdempotencyKey(base)).not.toBe(proxyIdempotencyKey(other));
  });

  it('produces a 64-char lowercase hex digest (writeToSpool\'s required key shape)', () => {
    const env: ProxyCaptureEnvelope = {
      event: 'session_end', session_id: 'proxy-x', project_id: 'llm-proxy',
      captured_at: '2026-01-01T00:00:00.000Z', kind: 'transcript', tool: 'llm-proxy',
      turns: [{ role: 'user', text: 'hi' }],
      client_scrub_applied: false, client_scrub_hits: 0, client_version: '1.0.0',
      client_scrub_version: 'none', wire_version: 'v1.0', capture_source: 'proxy',
    };
    expect(proxyIdempotencyKey(env)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('createProxyCaptureTee', () => {
  let dataDir: string;

  afterEach(() => {
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  function freshDataDir(): string {
    dataDir = mkdtempSync(join(tmpdir(), 'astramem-proxy-capture-test-'));
    return dataDir;
  }

  it('spools a complete exchange, tagged capture_source: "proxy", only AFTER both directions end', async () => {
    const dir = freshDataDir();
    const createTee = createProxyCaptureTee({ dataDir: dir, clientVersion: '9.9.9', relevanceGate: GATE_OPTS });
    const sink = createTee();

    sink('req', { chunk: Buffer.from(chatRequestBody('what is the daemon default port')) });
    sink('req', { end: true });
    // Nothing spooled yet — response side hasn't ended.
    await new Promise((r) => setImmediate(r));
    expect(listSpoolFiles(dir)).toHaveLength(0);

    sink('res', { chunk: Buffer.from(chatResponseBodyNonStreaming('7777 by default.')) });
    sink('res', { end: true });
    await new Promise((r) => setImmediate(r));

    const files = listSpoolFiles(dir);
    expect(files).toHaveLength(1);
    const envelope = JSON.parse(readFileSync(files[0]!.path, 'utf8')) as ProxyCaptureEnvelope;
    expect(envelope.capture_source).toBe('proxy');
    expect(envelope.tool).toBe('llm-proxy');
    expect(envelope.turns).toEqual([
      { role: 'user', text: 'what is the daemon default port' },
      { role: 'assistant', text: '7777 by default.' },
    ]);
  });

  it('defers the spool write off the sink callback via setImmediate — never synchronous', () => {
    const dir = freshDataDir();
    const createTee = createProxyCaptureTee({ dataDir: dir, clientVersion: '9.9.9', relevanceGate: GATE_OPTS });
    const sink = createTee();

    sink('req', { chunk: Buffer.from(chatRequestBody('capture this please')) });
    sink('req', { end: true });
    sink('res', { chunk: Buffer.from(chatResponseBodyNonStreaming('captured, noted.')) });
    sink('res', { end: true });

    // Synchronously right after the final sink call — must NOT have written
    // yet (ADR-013 Decision 3 / FEAT-458 S3 requirement 6: never block the
    // pipe-completion critical path with a synchronous fs write).
    expect(listSpoolFiles(dir)).toHaveLength(0);
  });

  it('two concurrent createTee() instances from the same factory never mix buffers (per-request isolation)', async () => {
    const dir = freshDataDir();
    const createTee = createProxyCaptureTee({ dataDir: dir, clientVersion: '9.9.9', relevanceGate: GATE_OPTS });
    const sinkA = createTee();
    const sinkB = createTee();

    // Interleaved, as concurrent requests on a real server would be.
    sinkA('req', { chunk: Buffer.from(chatRequestBody('question A')) });
    sinkB('req', { chunk: Buffer.from(chatRequestBody('question B')) });
    sinkA('req', { end: true });
    sinkB('req', { end: true });
    sinkB('res', { chunk: Buffer.from(chatResponseBodyNonStreaming('answer B')) });
    sinkA('res', { chunk: Buffer.from(chatResponseBodyNonStreaming('answer A')) });
    sinkA('res', { end: true });
    sinkB('res', { end: true });

    await new Promise((r) => setImmediate(r));

    const files = listSpoolFiles(dir);
    expect(files).toHaveLength(2);
    const envelopes = files.map((f) => JSON.parse(readFileSync(f.path, 'utf8')) as ProxyCaptureEnvelope);
    const byUserText = new Map(envelopes.map((e) => [e.turns[0]!.text, e]));
    expect(byUserText.get('question A')?.turns[1]).toEqual({ role: 'assistant', text: 'answer A' });
    expect(byUserText.get('question B')?.turns[1]).toEqual({ role: 'assistant', text: 'answer B' });
  });

  it('applies the relevance gate (too-short turns dropped) using the caller-supplied options', async () => {
    const dir = freshDataDir();
    const strictGate = { minChars: 100, maxBytes: 1_000_000, dedupWindow: 20 };
    const createTee = createProxyCaptureTee({ dataDir: dir, clientVersion: '9.9.9', relevanceGate: strictGate });
    const sink = createTee();

    sink('req', { chunk: Buffer.from(chatRequestBody('ok')) });
    sink('req', { end: true });
    sink('res', { chunk: Buffer.from(chatResponseBodyNonStreaming('ok')) });
    sink('res', { end: true });
    await new Promise((r) => setImmediate(r));

    // Both turns are far under minChars: 100 — the gate gets them, nothing spools.
    expect(listSpoolFiles(dir)).toHaveLength(0);
  });

  it('dedup window persists ACROSS requests from the same createProxyCaptureTee() factory (long-running-process scope, not per-request)', async () => {
    const dir = freshDataDir();
    const dedupGate = { minChars: 1, maxBytes: 1_000_000, dedupWindow: 20 };
    const createTee = createProxyCaptureTee({ dataDir: dir, clientVersion: '9.9.9', relevanceGate: dedupGate });

    // First exchange with a distinctive repeated user turn.
    const sink1 = createTee();
    sink1('req', { chunk: Buffer.from(chatRequestBody('the exact same repeated question')) });
    sink1('req', { end: true });
    sink1('res', { chunk: Buffer.from(chatResponseBodyNonStreaming('first answer')) });
    sink1('res', { end: true });
    await new Promise((r) => setImmediate(r));
    expect(listSpoolFiles(dir)).toHaveLength(1);

    // Second, later exchange — SAME user text (dedup should catch this one
    // turn, even though it comes from a brand-new createTee() call, because
    // the dedup Set lives in the outer factory closure, not the inner one).
    const sink2 = createTee();
    sink2('req', { chunk: Buffer.from(chatRequestBody('the exact same repeated question')) });
    sink2('req', { end: true });
    sink2('res', { chunk: Buffer.from(chatResponseBodyNonStreaming('a different second answer')) });
    sink2('res', { end: true });
    await new Promise((r) => setImmediate(r));

    // The user turn was deduped, but the (non-duplicate) assistant turn
    // still qualifies — so a second envelope IS spooled, just without the
    // repeated user turn. listSpoolFiles sorts by idempotency-key (a content
    // hash), NOT insertion order, so find the second envelope by its
    // (distinctive) content rather than assuming array position.
    const files = listSpoolFiles(dir);
    expect(files).toHaveLength(2);
    const envelopes = files.map((f) => JSON.parse(readFileSync(f.path, 'utf8')) as ProxyCaptureEnvelope);
    const second = envelopes.find((e) => e.turns.length === 1);
    expect(second?.turns).toEqual([{ role: 'assistant', text: 'a different second answer' }]);
  });

  it('fails silent on a malformed body — never throws from the sink, nothing spooled', async () => {
    const dir = freshDataDir();
    const createTee = createProxyCaptureTee({ dataDir: dir, clientVersion: '9.9.9', relevanceGate: GATE_OPTS });
    const sink = createTee();

    expect(() => {
      sink('req', { chunk: Buffer.from('not json at all {') });
      sink('req', { end: true });
      sink('res', { chunk: Buffer.from('also not json {') });
      sink('res', { end: true });
    }).not.toThrow();

    await new Promise((r) => setImmediate(r));
    expect(listSpoolFiles(dir)).toHaveLength(0);
  });

  it('round-trips a full user+assistant exchange for the Anthropic Messages API (non-streaming) — the bug this slice fixes', async () => {
    const dir = freshDataDir();
    const createTee = createProxyCaptureTee({ dataDir: dir, clientVersion: '9.9.9', relevanceGate: GATE_OPTS });
    const sink = createTee();

    sink('req', { chunk: Buffer.from(anthropicRequestBody('what is the daemon default port', { system: 'boilerplate instructions' })) });
    sink('req', { end: true });
    sink('res', { chunk: Buffer.from(anthropicResponseBodyNonStreaming('7777 by default.')) });
    sink('res', { end: true });
    await new Promise((r) => setImmediate(r));

    const files = listSpoolFiles(dir);
    expect(files).toHaveLength(1);
    const envelope = JSON.parse(readFileSync(files[0]!.path, 'utf8')) as ProxyCaptureEnvelope;
    expect(envelope.capture_source).toBe('proxy');
    // BOTH turns present — this is exactly the "assistant reply dropped"
    // regression the bug report described: turns=1 [user] only.
    expect(envelope.turns).toEqual([
      { role: 'user', text: 'what is the daemon default port' },
      { role: 'assistant', text: '7777 by default.' },
    ]);
  });

  it('round-trips a full user+assistant exchange for the Anthropic Messages API (SSE streaming)', async () => {
    const dir = freshDataDir();
    const createTee = createProxyCaptureTee({ dataDir: dir, clientVersion: '9.9.9', relevanceGate: GATE_OPTS });
    const sink = createTee();

    sink('req', { chunk: Buffer.from(anthropicRequestBody('what is the daemon default port')) });
    sink('req', { end: true });
    sink('res', { chunk: Buffer.from(anthropicResponseBodySSE(['7777 ', 'by ', 'default.'])) });
    sink('res', { end: true });
    await new Promise((r) => setImmediate(r));

    const files = listSpoolFiles(dir);
    expect(files).toHaveLength(1);
    const envelope = JSON.parse(readFileSync(files[0]!.path, 'utf8')) as ProxyCaptureEnvelope;
    expect(envelope.turns).toEqual([
      { role: 'user', text: 'what is the daemon default port' },
      { role: 'assistant', text: '7777 by default.' },
    ]);
  });

  it('still round-trips a full user+assistant exchange for OpenAI chat-completions — dual-format support did not regress the original format', async () => {
    const dir = freshDataDir();
    const createTee = createProxyCaptureTee({ dataDir: dir, clientVersion: '9.9.9', relevanceGate: GATE_OPTS });
    const sink = createTee();

    sink('req', { chunk: Buffer.from(chatRequestBody('what is the daemon default port')) });
    sink('req', { end: true });
    sink('res', { chunk: Buffer.from(chatResponseBodySSE(['7777 ', 'by ', 'default.'])) });
    sink('res', { end: true });
    await new Promise((r) => setImmediate(r));

    const files = listSpoolFiles(dir);
    expect(files).toHaveLength(1);
    const envelope = JSON.parse(readFileSync(files[0]!.path, 'utf8')) as ProxyCaptureEnvelope;
    expect(envelope.turns).toEqual([
      { role: 'user', text: 'what is the daemon default port' },
      { role: 'assistant', text: '7777 by default.' },
    ]);
  });

  it('an incomplete exchange (request never ends) never spools', async () => {
    const dir = freshDataDir();
    const createTee = createProxyCaptureTee({ dataDir: dir, clientVersion: '9.9.9', relevanceGate: GATE_OPTS });
    const sink = createTee();

    sink('req', { chunk: Buffer.from(chatRequestBody('hanging request')) });
    // req never ends.
    sink('res', { chunk: Buffer.from(chatResponseBodyNonStreaming('reply')) });
    sink('res', { end: true });
    await new Promise((r) => setImmediate(r));

    expect(listSpoolFiles(dir)).toHaveLength(0);
  });
});
