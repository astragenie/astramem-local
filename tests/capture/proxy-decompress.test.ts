/**
 * FEAT-458 S7 — capture-fork decompression (ADR-013's exclusion invariant
 * still applies: BODY BYTES ONLY, never a header). Found by pointing a real
 * Claude Code session at the proxy with capture ON: the user turn captured,
 * the assistant reply silently did not, because every real upstream
 * (Anthropic, OpenAI, ...) gzip-compresses response bodies by default and
 * every fixture in tests/capture/proxy.test.ts up to this point was
 * plaintext. This file exists specifically so that gap can't recur: every
 * "real compressed bytes" case below is produced with `node:zlib`'s own
 * compressor, never a hand-rolled or synthetic stand-in.
 *
 * Covers two levels:
 *   - `decompressBody` directly (unit-level: one codec / one edge case per
 *     test, precise assertions on the exact bytes back out).
 *   - `createProxyCaptureTee` end-to-end (integration-level: real Anthropic
 *     and OpenAI wire shapes, gzip-compressed on the response side exactly
 *     like the bug that was found, asserting a full user+assistant exchange
 *     round-trips through the real capture path).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { gzipSync, deflateSync, deflateRawSync, brotliCompressSync } from 'node:zlib';
import * as zlibFeatureProbe from 'node:zlib';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { decompressBody, createProxyCaptureTee, type ProxyCaptureEnvelope } from '../../src/capture/proxy.js';
import { listSpoolFiles } from '../../src/ingest/spool.js';

type ZstdCapableZlib = typeof import('node:zlib') & {
  zstdCompressSync?: (buf: Buffer) => Buffer;
};
const zlibWithZstd = zlibFeatureProbe as ZstdCapableZlib;
const zstdAvailable = typeof zlibWithZstd.zstdCompressSync === 'function';

const GATE_OPTS = { minChars: 1, maxBytes: 10_000_000, dedupWindow: 20 };

// --- Real wire-shape fixtures (same shapes tests/capture/proxy.test.ts
// already exercises uncompressed) ------------------------------------

function anthropicRequestBody(userText: string): string {
  return JSON.stringify({
    model: 'claude-3-5-sonnet-20241022',
    max_tokens: 1024,
    messages: [{ role: 'user', content: userText }],
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

/** Real `event: <type>\ndata: {...}\n\n` Anthropic SSE framing. */
function anthropicResponseBodySSE(parts: string[]): string {
  const lines: string[] = [];
  lines.push('event: message_start\n');
  lines.push(
    `data: ${JSON.stringify({ type: 'message_start', message: { id: 'msg_01', type: 'message', role: 'assistant', content: [], model: 'claude-3-5-sonnet-20241022', stop_reason: null, stop_sequence: null, usage: { input_tokens: 25, output_tokens: 1 } } })}\n\n`,
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
  lines.push(`data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: parts.join('').length } })}\n\n`);
  lines.push('event: message_stop\n');
  lines.push(`data: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
  return lines.join('');
}

function openaiRequestBody(userText: string): string {
  return JSON.stringify({
    model: 'gpt-4',
    messages: [{ role: 'user', content: userText }],
  });
}

function openaiResponseBodyNonStreaming(assistantText: string): string {
  return JSON.stringify({
    id: 'chatcmpl-1',
    choices: [{ message: { role: 'assistant', content: assistantText } }],
  });
}

function openaiResponseBodySSE(parts: string[]): string {
  const lines = parts.map((p) => `data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`);
  lines.push('data: [DONE]\n\n');
  return lines.join('');
}

// --- decompressBody() unit tests --------------------------------------

describe('decompressBody — byte-only detection, no header input anywhere', () => {
  it('gzip: reverses a real gzip-compressed Anthropic non-streaming JSON body byte-for-byte', () => {
    const plain = anthropicResponseBodyNonStreaming('The daemon listens on port 7777 by default.');
    const compressed = gzipSync(Buffer.from(plain, 'utf8'));
    // Sanity: this is actually the gzip magic number, not a no-op fixture.
    expect(compressed[0]).toBe(0x1f);
    expect(compressed[1]).toBe(0x8b);
    expect(decompressBody(compressed).toString('utf8')).toBe(plain);
  });

  it('gzip: reverses a real gzip-compressed Anthropic SSE stream byte-for-byte', () => {
    const plain = anthropicResponseBodySSE(['Hel', 'lo, ', 'world!']);
    const compressed = gzipSync(Buffer.from(plain, 'utf8'));
    expect(decompressBody(compressed).toString('utf8')).toBe(plain);
  });

  it('gzip: reverses a real gzip-compressed OpenAI non-streaming JSON body', () => {
    const plain = openaiResponseBodyNonStreaming('hello from openai');
    const compressed = gzipSync(Buffer.from(plain, 'utf8'));
    expect(decompressBody(compressed).toString('utf8')).toBe(plain);
  });

  it('zlib/deflate: reverses a real zlib-compressed body (0x78 header)', () => {
    const plain = anthropicResponseBodyNonStreaming('zlib-compressed reply');
    const compressed = deflateSync(Buffer.from(plain, 'utf8'));
    expect(compressed[0]).toBe(0x78);
    expect(decompressBody(compressed).toString('utf8')).toBe(plain);
  });

  it('brotli: reverses a real brotli-compressed body with NO magic number — proves the speculative-decode path', () => {
    const plain = anthropicResponseBodyNonStreaming('brotli has no magic number at all, this must be speculative');
    const compressed = brotliCompressSync(Buffer.from(plain, 'utf8'));
    // Brotli genuinely has no fixed magic prefix — this is not gzip's 1f8b,
    // not zlib's 78, not zstd's 28b52ffd.
    expect(compressed[0]).not.toBe(0x1f);
    expect(compressed[0]).not.toBe(0x78);
    expect(decompressBody(compressed).toString('utf8')).toBe(plain);
  });

  it('raw deflate (headerless): reverses a real raw-deflate body — also has no magic number', () => {
    const plain = anthropicResponseBodyNonStreaming('raw deflate, no zlib header either');
    const compressed = deflateRawSync(Buffer.from(plain, 'utf8'));
    expect(decompressBody(compressed).toString('utf8')).toBe(plain);
  });

  it.skipIf(!zstdAvailable)('zstd: reverses a real zstd-compressed body (0x28b52ffd magic)', () => {
    const plain = anthropicResponseBodyNonStreaming('zstd-compressed reply');
    const compressed = zlibWithZstd.zstdCompressSync!(Buffer.from(plain, 'utf8'));
    expect(compressed[0]).toBe(0x28);
    expect(compressed[1]).toBe(0xb5);
    expect(compressed[2]).toBe(0x2f);
    expect(compressed[3]).toBe(0xfd);
    expect(decompressBody(compressed).toString('utf8')).toBe(plain);
  });

  it('plaintext (never compressed) passes through completely unchanged — no regression', () => {
    const plain = anthropicResponseBodyNonStreaming('this body was never compressed at all');
    const raw = Buffer.from(plain, 'utf8');
    expect(decompressBody(raw).toString('utf8')).toBe(plain);
  });

  it('plaintext SSE (never compressed) passes through completely unchanged', () => {
    const plain = openaiResponseBodySSE(['no ', 'compression ', 'here']);
    const raw = Buffer.from(plain, 'utf8');
    expect(decompressBody(raw).toString('utf8')).toBe(plain);
  });

  it('empty buffer passes through unchanged, no throw', () => {
    const raw = Buffer.alloc(0);
    expect(() => decompressBody(raw)).not.toThrow();
    expect(decompressBody(raw)).toEqual(Buffer.alloc(0));
  });

  it('a corrupt/truncated gzip stream fails silently — falls back to the original bytes, never throws', () => {
    const plain = anthropicResponseBodyNonStreaming('this will never be readable after truncation');
    const compressed = gzipSync(Buffer.from(plain, 'utf8'));
    // Valid gzip magic, but the stream is chopped mid-payload.
    const truncated = compressed.subarray(0, Math.floor(compressed.length / 2));
    let result: Buffer | undefined;
    expect(() => {
      result = decompressBody(truncated);
    }).not.toThrow();
    // Falls all the way through every candidate and returns the original
    // (still-compressed, now-truncated) bytes untouched — not an empty
    // buffer, not a throw, not a partial garbage decode.
    expect(result).toEqual(truncated);
  });

  it('a corrupt gzip magic with garbage payload fails silently — falls back, never throws', () => {
    const garbage = Buffer.concat([Buffer.from([0x1f, 0x8b]), Buffer.from('not actually gzip data after the magic bytes')]);
    let result: Buffer | undefined;
    expect(() => {
      result = decompressBody(garbage);
    }).not.toThrow();
    expect(result).toEqual(garbage);
  });

  it('a large-but-under-cap decode succeeds — the cap does not fire on legitimately-sized bodies', () => {
    // A highly-repetitive 20MB plaintext compresses to a tiny gzip payload
    // but would decompress back to 20MB — well under the module's real
    // 64MB cap, proving normal (if unusually large) traffic is unaffected.
    const large = 'A'.repeat(20 * 1024 * 1024);
    const compressed = gzipSync(Buffer.from(large, 'utf8'));
    expect(compressed.length).toBeLessThan(100_000); // tiny compressed size vs. huge output — a real bomb shape

    let result: Buffer | undefined;
    expect(() => {
      result = decompressBody(compressed);
    }).not.toThrow();
    expect(result!.length).toBe(large.length);
  });

  it('a genuine zip-bomb-ish decode PAST the 64MB cap is bounded and dropped silently — never inflates unbounded memory', () => {
    // 70MB of repeated text compresses to a trivially small gzip payload
    // (a real zip bomb's shape: tiny compressed size, enormous decompressed
    // size) but exceeds the module's MAX_DECOMPRESSED_BODY_BYTES cap
    // (64MB) — node:zlib's maxOutputLength aborts mid-decompression rather
    // than ever materializing the full 70MB, and this function's fallback
    // returns the ORIGINAL (still-compressed) bytes untouched, exactly like
    // any other failed decode.
    const bomb = 'B'.repeat(70 * 1024 * 1024);
    const compressed = gzipSync(Buffer.from(bomb, 'utf8'));
    expect(compressed.length).toBeLessThan(100_000);

    let result: Buffer | undefined;
    expect(() => {
      result = decompressBody(compressed);
    }).not.toThrow();
    // Bounded: never returns the 70MB decoded payload — falls back to the
    // small original compressed bytes instead.
    expect(result).toEqual(compressed);
    expect(result!.length).toBeLessThan(1_000_000);
  });
});

// --- End-to-end: createProxyCaptureTee with real compressed traffic ---

describe('createProxyCaptureTee — real compressed bytes end to end (the exact bug found against reality)', () => {
  let dataDir: string;

  afterEach(() => {
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  function freshDataDir(): string {
    dataDir = mkdtempSync(join(tmpdir(), 'astramem-proxy-decompress-test-'));
    return dataDir;
  }

  it('gzip-compressed Anthropic response (request plaintext, exactly like a real Claude Code call): full user+assistant exchange round-trips', async () => {
    const dir = freshDataDir();
    const createTee = createProxyCaptureTee({ dataDir: dir, clientVersion: '9.9.9', relevanceGate: GATE_OPTS });
    const sink = createTee();

    sink('req', { chunk: Buffer.from(anthropicRequestBody('what port does the daemon listen on'), 'utf8') });
    sink('req', { end: true });
    const compressedRes = gzipSync(Buffer.from(anthropicResponseBodyNonStreaming('The daemon listens on port 7777 by default.'), 'utf8'));
    sink('res', { chunk: compressedRes });
    sink('res', { end: true });
    await new Promise((r) => setImmediate(r));

    const files = listSpoolFiles(dir);
    expect(files).toHaveLength(1);
    const envelope = JSON.parse(readFileSync(files[0]!.path, 'utf8')) as ProxyCaptureEnvelope;
    expect(envelope.turns).toEqual([
      { role: 'user', text: 'what port does the daemon listen on' },
      { role: 'assistant', text: 'The daemon listens on port 7777 by default.' },
    ]);
  });

  it('gzip-compressed Anthropic SSE response: full user+assistant exchange round-trips', async () => {
    const dir = freshDataDir();
    const createTee = createProxyCaptureTee({ dataDir: dir, clientVersion: '9.9.9', relevanceGate: GATE_OPTS });
    const sink = createTee();

    sink('req', { chunk: Buffer.from(anthropicRequestBody('stream me an answer'), 'utf8') });
    sink('req', { end: true });
    const compressedRes = gzipSync(Buffer.from(anthropicResponseBodySSE(['Hel', 'lo, ', 'world!']), 'utf8'));
    // Split across multiple tee chunks, as a real streamed-then-compressed
    // (or chunked transfer) body would arrive in more than one piece.
    const mid = Math.floor(compressedRes.length / 2);
    sink('res', { chunk: compressedRes.subarray(0, mid) });
    sink('res', { chunk: compressedRes.subarray(mid) });
    sink('res', { end: true });
    await new Promise((r) => setImmediate(r));

    const files = listSpoolFiles(dir);
    expect(files).toHaveLength(1);
    const envelope = JSON.parse(readFileSync(files[0]!.path, 'utf8')) as ProxyCaptureEnvelope;
    expect(envelope.turns).toEqual([
      { role: 'user', text: 'stream me an answer' },
      { role: 'assistant', text: 'Hello, world!' },
    ]);
  });

  it('gzip-compressed OpenAI non-streaming response: full user+assistant exchange round-trips', async () => {
    const dir = freshDataDir();
    const createTee = createProxyCaptureTee({ dataDir: dir, clientVersion: '9.9.9', relevanceGate: GATE_OPTS });
    const sink = createTee();

    sink('req', { chunk: Buffer.from(openaiRequestBody('hi there'), 'utf8') });
    sink('req', { end: true });
    sink('res', { chunk: gzipSync(Buffer.from(openaiResponseBodyNonStreaming('hello back'), 'utf8')) });
    sink('res', { end: true });
    await new Promise((r) => setImmediate(r));

    const envelope = JSON.parse(readFileSync(listSpoolFiles(dir)[0]!.path, 'utf8')) as ProxyCaptureEnvelope;
    expect(envelope.turns).toEqual([
      { role: 'user', text: 'hi there' },
      { role: 'assistant', text: 'hello back' },
    ]);
  });

  it('brotli-compressed response (no magic number): full user+assistant exchange still round-trips through the tee', async () => {
    const dir = freshDataDir();
    const createTee = createProxyCaptureTee({ dataDir: dir, clientVersion: '9.9.9', relevanceGate: GATE_OPTS });
    const sink = createTee();

    sink('req', { chunk: Buffer.from(anthropicRequestBody('brotli end to end'), 'utf8') });
    sink('req', { end: true });
    sink('res', { chunk: brotliCompressSync(Buffer.from(anthropicResponseBodyNonStreaming('answered via brotli'), 'utf8')) });
    sink('res', { end: true });
    await new Promise((r) => setImmediate(r));

    const envelope = JSON.parse(readFileSync(listSpoolFiles(dir)[0]!.path, 'utf8')) as ProxyCaptureEnvelope;
    expect(envelope.turns).toEqual([
      { role: 'user', text: 'brotli end to end' },
      { role: 'assistant', text: 'answered via brotli' },
    ]);
  });

  it('plaintext response (no compression at all) still round-trips — no regression from adding decompression', async () => {
    const dir = freshDataDir();
    const createTee = createProxyCaptureTee({ dataDir: dir, clientVersion: '9.9.9', relevanceGate: GATE_OPTS });
    const sink = createTee();

    sink('req', { chunk: Buffer.from(anthropicRequestBody('plain and simple'), 'utf8') });
    sink('req', { end: true });
    sink('res', { chunk: Buffer.from(anthropicResponseBodyNonStreaming('no compression needed here'), 'utf8') });
    sink('res', { end: true });
    await new Promise((r) => setImmediate(r));

    const envelope = JSON.parse(readFileSync(listSpoolFiles(dir)[0]!.path, 'utf8')) as ProxyCaptureEnvelope;
    expect(envelope.turns).toEqual([
      { role: 'user', text: 'plain and simple' },
      { role: 'assistant', text: 'no compression needed here' },
    ]);
  });

  it('a corrupt/truncated gzip response fails silently: the user turn still captures, no throw, no assistant turn fabricated', async () => {
    const dir = freshDataDir();
    const createTee = createProxyCaptureTee({ dataDir: dir, clientVersion: '9.9.9', relevanceGate: GATE_OPTS });
    const sink = createTee();

    sink('req', { chunk: Buffer.from(anthropicRequestBody('this response will arrive broken'), 'utf8') });
    sink('req', { end: true });
    const compressed = gzipSync(Buffer.from(anthropicResponseBodyNonStreaming('never actually readable'), 'utf8'));
    sink('res', { chunk: compressed.subarray(0, Math.floor(compressed.length / 3)) }); // truncated mid-stream
    sink('res', { end: true });

    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 10));

    const files = listSpoolFiles(dir);
    expect(files).toHaveLength(1);
    const envelope = JSON.parse(readFileSync(files[0]!.path, 'utf8')) as ProxyCaptureEnvelope;
    // Only the user turn — the corrupted response never fabricates an
    // assistant turn from garbage bytes, and capturing the user side alone
    // never throws or blocks.
    expect(envelope.turns).toEqual([{ role: 'user', text: 'this response will arrive broken' }]);
  });

  it('decompression runs deferred (setImmediate), never synchronously inside the sink callback — same invariant as plaintext capture', () => {
    const dir = freshDataDir();
    const createTee = createProxyCaptureTee({ dataDir: dir, clientVersion: '9.9.9', relevanceGate: GATE_OPTS });
    const sink = createTee();

    sink('req', { chunk: Buffer.from(anthropicRequestBody('timing check'), 'utf8') });
    sink('req', { end: true });
    sink('res', { chunk: gzipSync(Buffer.from(anthropicResponseBodyNonStreaming('timing check reply'), 'utf8')) });
    sink('res', { end: true });

    // Synchronously right after the final sink call — decompression +
    // parsing + spool write must NOT have happened yet.
    expect(listSpoolFiles(dir)).toHaveLength(0);
  });
});
