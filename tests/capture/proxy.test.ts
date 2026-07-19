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
  extractUsageMetadata,
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

function chatResponseBodyNonStreamingWithUsage(
  assistantText: string,
  opts: { finishReason?: string; promptTokens?: number; completionTokens?: number; totalTokens?: number } = {},
): string {
  return JSON.stringify({
    id: 'chatcmpl-1',
    model: 'gpt-4',
    choices: [{ message: { role: 'assistant', content: assistantText }, finish_reason: opts.finishReason ?? 'stop' }],
    usage: {
      prompt_tokens: opts.promptTokens ?? 12,
      completion_tokens: opts.completionTokens ?? 8,
      total_tokens: opts.totalTokens ?? 20,
    },
  });
}

/** A real OpenAI streaming sequence with `stream_options.include_usage`
 *  set — the trailing chunk carries an empty `choices: []` alongside the
 *  cumulative `usage` object, matching the actual wire shape (not folded
 *  into the last content chunk). */
function chatResponseBodySSEWithUsage(parts: string[], opts: { finishReason?: string; promptTokens?: number; completionTokens?: number; totalTokens?: number } = {}): string {
  const lines = parts.map((p) => `data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`);
  lines.push(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: opts.finishReason ?? 'stop' }] })}\n\n`);
  lines.push(
    `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: opts.promptTokens ?? 12, completion_tokens: opts.completionTokens ?? 8, total_tokens: opts.totalTokens ?? 20 } })}\n\n`,
  );
  lines.push('data: [DONE]\n\n');
  return lines.join('');
}

/** A real OpenAI streaming sequence WITHOUT `stream_options.include_usage`
 *  — the far more common case in practice. `finish_reason` still arrives
 *  on the terminal chunk (unrelated to that flag); no chunk ever carries a
 *  `usage` field at all. */
function chatResponseBodySSENoUsage(parts: string[], finishReason = 'stop'): string {
  const lines = parts.map((p) => `data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`);
  lines.push(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finishReason }] })}\n\n`);
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

function anthropicResponseBodyNonStreamingWithUsage(
  assistantText: string,
  opts: { stopReason?: string; inputTokens?: number; outputTokens?: number; cacheCreation?: number; cacheRead?: number } = {},
): string {
  return JSON.stringify({
    id: 'msg_01',
    type: 'message',
    role: 'assistant',
    model: 'claude-3-5-sonnet-20241022',
    content: [{ type: 'text', text: assistantText }],
    stop_reason: opts.stopReason ?? 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: opts.inputTokens ?? 500,
      output_tokens: opts.outputTokens ?? 150,
      cache_creation_input_tokens: opts.cacheCreation ?? 200,
      cache_read_input_tokens: opts.cacheRead ?? 1800,
    },
  });
}

/** An Anthropic streaming sequence with real usage/cache fields on
 *  message_start and the final stop_reason + cumulative output_tokens on
 *  message_delta — the actual two-event split real traffic uses (usage
 *  isn't all on one event). */
function anthropicResponseBodySSEWithUsage(
  parts: string[],
  opts: { stopReason?: string; inputTokens?: number; cacheCreation?: number; cacheRead?: number; outputTokens?: number } = {},
): string {
  const lines: string[] = [];
  lines.push('event: message_start\n');
  lines.push(
    `data: ${JSON.stringify({
      type: 'message_start',
      message: {
        id: 'msg_01', type: 'message', role: 'assistant', content: [], model: 'claude-3-5-sonnet-20241022',
        stop_reason: null, stop_sequence: null,
        usage: {
          input_tokens: opts.inputTokens ?? 500,
          cache_creation_input_tokens: opts.cacheCreation ?? 200,
          cache_read_input_tokens: opts.cacheRead ?? 1800,
          output_tokens: 1,
        },
      },
    })}\n\n`,
  );
  lines.push('event: content_block_start\n');
  lines.push(`data: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`);
  for (const p of parts) {
    lines.push('event: content_block_delta\n');
    lines.push(`data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: p } })}\n\n`);
  }
  lines.push('event: content_block_stop\n');
  lines.push(`data: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`);
  lines.push('event: message_delta\n');
  lines.push(
    `data: ${JSON.stringify({
      type: 'message_delta',
      delta: { stop_reason: opts.stopReason ?? 'end_turn', stop_sequence: null },
      usage: { output_tokens: opts.outputTokens ?? parts.join('').length },
    })}\n\n`,
  );
  lines.push('event: message_stop\n');
  lines.push(`data: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
  return lines.join('');
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

describe('extractUsageMetadata (FEAT-458 S5 scope add — usage/cost telemetry)', () => {
  it('extracts model, cache fields (kept SEPARATE from input_tokens), and stop_reason from an Anthropic non-streaming response', () => {
    const req = anthropicRequestBody('a question');
    const res = anthropicResponseBodyNonStreamingWithUsage('an answer', {
      inputTokens: 500, outputTokens: 150, cacheCreation: 200, cacheRead: 1800, stopReason: 'end_turn',
    });
    expect(extractUsageMetadata(req, res)).toEqual({
      provider: 'anthropic',
      model: 'claude-3-5-sonnet-20241022',
      input_tokens: 500,
      output_tokens: 150,
      total_tokens: null,
      cache_creation_input_tokens: 200,
      cache_read_input_tokens: 1800,
      stop_reason: 'end_turn',
      truncated: false,
    });
  });

  it('extracts usage from an Anthropic SSE stream (input/cache from message_start, output/stop_reason from message_delta)', () => {
    const req = anthropicRequestBody('a question');
    const res = anthropicResponseBodySSEWithUsage(['par', 't of ', 'the reply'], {
      inputTokens: 500, cacheCreation: 200, cacheRead: 1800, outputTokens: 42, stopReason: 'end_turn',
    });
    expect(extractUsageMetadata(req, res)).toEqual({
      provider: 'anthropic',
      model: 'claude-3-5-sonnet-20241022',
      input_tokens: 500,
      output_tokens: 42,
      total_tokens: null,
      cache_creation_input_tokens: 200,
      cache_read_input_tokens: 1800,
      stop_reason: 'end_turn',
      truncated: false,
    });
  });

  it('flags a TRUNCATED reply (Anthropic stop_reason: "max_tokens") — non-streaming', () => {
    const res = anthropicResponseBodyNonStreamingWithUsage('cut off mid-', { stopReason: 'max_tokens' });
    const meta = extractUsageMetadata(anthropicRequestBody('a question'), res);
    expect(meta?.stop_reason).toBe('max_tokens');
    expect(meta?.truncated).toBe(true);
  });

  it('flags a TRUNCATED reply (Anthropic stop_reason: "max_tokens") — SSE streaming', () => {
    const res = anthropicResponseBodySSEWithUsage(['cut off mid-'], { stopReason: 'max_tokens' });
    const meta = extractUsageMetadata(anthropicRequestBody('a question'), res);
    expect(meta?.stop_reason).toBe('max_tokens');
    expect(meta?.truncated).toBe(true);
  });

  it('does NOT flag a normal end_turn/stop completion as truncated', () => {
    const res = anthropicResponseBodyNonStreamingWithUsage('a complete answer', { stopReason: 'end_turn' });
    expect(extractUsageMetadata(anthropicRequestBody('a question'), res)?.truncated).toBe(false);
  });

  it('extracts OpenAI usage parity fields (prompt/completion/total_tokens, finish_reason) — non-streaming', () => {
    const req = chatRequestBody('a question');
    const res = chatResponseBodyNonStreamingWithUsage('an answer', { promptTokens: 30, completionTokens: 10, totalTokens: 40, finishReason: 'stop' });
    expect(extractUsageMetadata(req, res)).toEqual({
      provider: 'openai',
      model: 'gpt-4',
      input_tokens: 30,
      output_tokens: 10,
      total_tokens: 40,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      stop_reason: 'stop',
      truncated: false,
    });
  });

  it('flags a TRUNCATED OpenAI reply (finish_reason: "length")', () => {
    const res = chatResponseBodyNonStreamingWithUsage('cut off', { finishReason: 'length' });
    expect(extractUsageMetadata(chatRequestBody('a question'), res)?.truncated).toBe(true);
  });

  it('extracts OpenAI usage from an SSE stream WHEN stream_options.include_usage was set', () => {
    const req = chatRequestBody('a question');
    const res = chatResponseBodySSEWithUsage(['par', 't of ', 'the reply'], { promptTokens: 30, completionTokens: 10, totalTokens: 40, finishReason: 'stop' });
    expect(extractUsageMetadata(req, res)).toEqual({
      provider: 'openai',
      model: 'gpt-4',
      input_tokens: 30,
      output_tokens: 10,
      total_tokens: 40,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      stop_reason: 'stop',
      truncated: false,
    });
  });

  it('MISSING usage (OpenAI streaming WITHOUT include_usage) yields null token counts, never fabricated zeros — the test that protects downstream cost math', () => {
    const req = chatRequestBody('a question');
    const res = chatResponseBodySSENoUsage(['par', 't of ', 'the reply'], 'stop');
    const meta = extractUsageMetadata(req, res);
    // model and stop_reason ARE available independent of include_usage —
    // only the token counts are genuinely absent from the wire.
    expect(meta).toEqual({
      provider: 'openai',
      model: 'gpt-4',
      input_tokens: null,
      output_tokens: null,
      total_tokens: null,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      stop_reason: 'stop',
      truncated: false,
    });
    // Belt-and-suspenders: explicitly not zero anywhere a real count is absent.
    expect(meta?.input_tokens).not.toBe(0);
    expect(meta?.output_tokens).not.toBe(0);
    expect(meta?.total_tokens).not.toBe(0);
  });

  it('reads model from the REQUEST body only — never the response — for both formats', () => {
    // The response body's own `model` field (if any) is deliberately never
    // consulted; requestModel is the sole source (module doc rationale).
    const req = anthropicRequestBody('a question');
    const res = anthropicResponseBodyNonStreamingWithUsage('an answer');
    expect(extractUsageMetadata(req, res)?.model).toBe('claude-3-5-sonnet-20241022');
  });

  it('returns null when the response body has no recognizable provider shape at all', () => {
    expect(extractUsageMetadata(chatRequestBody('x'), '')).toBeNull();
    expect(extractUsageMetadata(chatRequestBody('x'), 'not json and not sse {')).toBeNull();
    expect(extractUsageMetadata(chatRequestBody('x'), JSON.stringify({ ok: true }))).toBeNull();
  });

  it('never throws on malformed input', () => {
    expect(() => extractUsageMetadata('not json {', 'also not json {')).not.toThrow();
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
    // 2026-07-13 timezone-offset bugfix — regression guard against silently
    // reverting captured_at back to `new Date().toISOString()` (see
    // src/capture/local-time.ts's module doc for the bug this closes).
    expect(envelope.captured_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}(Z|[+-]\d{2}:\d{2})$/);
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

  it('FEAT-478 AC-1: a too-short assistant reply gates out the WHOLE exchange, not just the reply', async () => {
    const dir = freshDataDir();
    // minChars gates the assistant reply ("gzip.") but not the longer user
    // question — exactly the FEAT-478 bug report's own repro shape.
    const askGate = { minChars: 8, maxBytes: 1_000_000, dedupWindow: 20 };
    const createTee = createProxyCaptureTee({ dataDir: dir, clientVersion: '9.9.9', relevanceGate: askGate });
    const sink = createTee();

    sink('req', { chunk: Buffer.from(chatRequestBody('which compression codec does the ingest spool use')) });
    sink('req', { end: true });
    sink('res', { chunk: Buffer.from(chatResponseBodyNonStreaming('gzip.')) }); // 5 chars < minChars 8
    sink('res', { end: true });
    await new Promise((r) => setImmediate(r));

    // Option A: an exchange is only captured when its answer survives. The
    // long user question surviving alone is an orphaned prompt — nothing
    // spools at all, not just the gated reply.
    expect(listSpoolFiles(dir)).toHaveLength(0);
  });

  it('FEAT-478 AC-3 (regression guard): a terse-but-VALID assistant reply is NOT suppressed — both turns spool', async () => {
    const dir = freshDataDir();
    // Same minChars floor as AC-1 above, but the reply is long enough to
    // survive the gate on its own — good, terse data must not be collateral
    // damage from the AC-1 fix.
    const askGate = { minChars: 8, maxBytes: 1_000_000, dedupWindow: 20 };
    const createTee = createProxyCaptureTee({ dataDir: dir, clientVersion: '9.9.9', relevanceGate: askGate });
    const sink = createTee();

    sink('req', { chunk: Buffer.from(chatRequestBody('which compression codec does the ingest spool use')) });
    sink('req', { end: true });
    sink('res', { chunk: Buffer.from(chatResponseBodyNonStreaming('gzip, via node:zlib.')) }); // >= 8 chars, survives the gate
    sink('res', { end: true });
    await new Promise((r) => setImmediate(r));

    const files = listSpoolFiles(dir);
    expect(files).toHaveLength(1);
    const envelope = JSON.parse(readFileSync(files[0]!.path, 'utf8')) as ProxyCaptureEnvelope;
    expect(envelope.turns).toEqual([
      { role: 'user', text: 'which compression codec does the ingest spool use' },
      { role: 'assistant', text: 'gzip, via node:zlib.' },
    ]);
  });

  it('FEAT-478 AC-4: a discarded exchange does NOT poison the dedup window — a later identical question WITH a good answer still spools', async () => {
    const dir = freshDataDir();
    const askGate = { minChars: 8, maxBytes: 1_000_000, dedupWindow: 20 };
    const createTee = createProxyCaptureTee({ dataDir: dir, clientVersion: '9.9.9', relevanceGate: askGate });

    // First exchange: the reply gates out (too short) so the WHOLE exchange
    // is discarded (AC-1). Under the pre-fix code, the user turn's hash
    // would already have been recorded into recentHashes during gating,
    // even though this exchange never spools.
    const sink1 = createTee();
    sink1('req', { chunk: Buffer.from(chatRequestBody('what port does the daemon default to')) });
    sink1('req', { end: true });
    sink1('res', { chunk: Buffer.from(chatResponseBodyNonStreaming('7777.')) }); // 5 chars < minChars 8
    sink1('res', { end: true });
    await new Promise((r) => setImmediate(r));
    expect(listSpoolFiles(dir)).toHaveLength(0);

    // Second exchange: the SAME question, this time with a good, long-enough
    // answer. If the first exchange's discard had still recorded the user
    // turn's hash (the poisoning bug), this identical question would now be
    // deduped away and the answer would spool alone, orphaned. It must not.
    const sink2 = createTee();
    sink2('req', { chunk: Buffer.from(chatRequestBody('what port does the daemon default to')) });
    sink2('req', { end: true });
    sink2('res', { chunk: Buffer.from(chatResponseBodyNonStreaming('7777, unless overridden in config.yaml.')) });
    sink2('res', { end: true });
    await new Promise((r) => setImmediate(r));

    const files = listSpoolFiles(dir);
    expect(files).toHaveLength(1);
    const envelope = JSON.parse(readFileSync(files[0]!.path, 'utf8')) as ProxyCaptureEnvelope;
    expect(envelope.turns).toEqual([
      { role: 'user', text: 'what port does the daemon default to' },
      { role: 'assistant', text: '7777, unless overridden in config.yaml.' },
    ]);
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
