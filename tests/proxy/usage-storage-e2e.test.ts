/**
 * FEAT-458 S6 — proves `extractUsageMetadata`'s token/cost telemetry
 * (src/capture/proxy.ts, S5) actually reaches durable storage, driving the
 * REAL path end to end: `createProxyCaptureTee`'s sink (the exact object
 * `src/proxy/server.ts` wires into a live proxy request) -> spool write ->
 * `drainIngestSpool` (src/ingest/spool-drain.ts, the same in-process path
 * the daemon runs on a timer) -> `transcripts.proxy_usage_json` in the DB.
 *
 * This is deliberately NOT a unit test of `extractUsageMetadata` in
 * isolation (already covered in tests/capture/proxy.test.ts) — the risk
 * this slice exists to close is the schema boundary silently dropping the
 * field between spool and storage (see ingest.ts's `proxy_usage` field doc
 * and src/capture/proxy.ts's now-updated module doc for the exact hazard:
 * zod's default "strip" mode on `CanonicalIngestSchema` removes an unknown
 * field instead of rejecting it, so a wiring mistake here would look done
 * while silently storing nothing).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createProxyCaptureTee } from '../../src/capture/proxy.js';
import { drainIngestSpool } from '../../src/ingest/spool-drain.js';
import { openDb, type DB } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { defaultConfig } from '../../src/config/config.js';

const GATE_OPTS = { minChars: 1, maxBytes: 1_000_000, dedupWindow: 20 };

function makeDb(): DB {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

/** Non-streaming Anthropic Messages API response carrying a full usage
 *  block — cache fields present and DISTINCT from input_tokens, matching a
 *  real prompt-caching exchange. */
function anthropicResponseWithUsage(): string {
  return JSON.stringify({
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-3-5-sonnet-20241022',
    content: [{ type: 'text', text: 'the retry budget is 3 attempts.' }],
    stop_reason: 'end_turn',
    usage: {
      input_tokens: 50,
      output_tokens: 20,
      cache_creation_input_tokens: 15,
      cache_read_input_tokens: 5,
    },
  });
}

function anthropicRequest(): string {
  return JSON.stringify({
    model: 'claude-3-5-sonnet-20241022',
    max_tokens: 1024,
    messages: [{ role: 'user', content: 'what should the retry budget be?' }],
  });
}

/** OpenAI streaming response WITHOUT `stream_options.include_usage` — the
 *  common case where no chunk ever carries a `usage` field at all. Every
 *  token count must stay JSON null in storage, never fabricated as 0. */
function openaiRequest(): string {
  return JSON.stringify({
    model: 'gpt-4',
    messages: [{ role: 'user', content: 'summarize this' }],
    stream: true,
  });
}

function openaiStreamingResponseNoUsage(): string {
  const lines = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
    'data: [DONE]\n\n',
  ];
  return lines.join('');
}

describe('proxy_usage — end-to-end from capture tee through spool-drain to transcripts.proxy_usage_json', () => {
  let dataDir: string;

  afterEach(() => {
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  function freshDataDir(): string {
    dataDir = mkdtempSync(join(tmpdir(), 'astramem-proxy-usage-e2e-'));
    return dataDir;
  }

  it('an Anthropic exchange with cache tokens: usage lands in the DB, cache fields stay structurally distinct, total_tokens is null (Anthropic never reports one)', async () => {
    const dir = freshDataDir();
    const createTee = createProxyCaptureTee({ dataDir: dir, clientVersion: '9.9.9', relevanceGate: GATE_OPTS });
    const sink = createTee();

    sink('req', { chunk: Buffer.from(anthropicRequest()) });
    sink('req', { end: true });
    sink('res', { chunk: Buffer.from(anthropicResponseWithUsage()) });
    sink('res', { end: true });
    await new Promise((r) => setImmediate(r)); // finishCapture's deferred spool write

    const db = makeDb();
    const config = defaultConfig();
    const result = drainIngestSpool(db, config, dir);
    expect(result).toEqual({ drained: 1, quarantined: 0, pending: 0 });

    const row = db.prepare(
      `SELECT proxy_usage_json FROM transcripts ORDER BY ingested_at DESC LIMIT 1`,
    ).get() as { proxy_usage_json: string | null };

    expect(row.proxy_usage_json).not.toBeNull();
    const usage = JSON.parse(row.proxy_usage_json!) as Record<string, unknown>;
    expect(usage).toEqual({
      provider: 'anthropic',
      model: 'claude-3-5-sonnet-20241022',
      input_tokens: 50,
      output_tokens: 20,
      total_tokens: null, // Anthropic never reports a pre-summed total
      cache_creation_input_tokens: 15,
      cache_read_input_tokens: 5,
      stop_reason: 'end_turn',
      truncated: false,
    });
    // Cache fields never folded into input_tokens — the entire point of
    // keeping them separate (they bill at very different rates).
    expect(usage['input_tokens']).not.toBe(
      (usage['input_tokens'] as number) + (usage['cache_read_input_tokens'] as number),
    );

    db.close();
  });

  it('an OpenAI stream with no usage chunk: every token count round-trips as JSON null in the DB, never coerced to 0', async () => {
    const dir = freshDataDir();
    const createTee = createProxyCaptureTee({ dataDir: dir, clientVersion: '9.9.9', relevanceGate: GATE_OPTS });
    const sink = createTee();

    sink('req', { chunk: Buffer.from(openaiRequest()) });
    sink('req', { end: true });
    sink('res', { chunk: Buffer.from(openaiStreamingResponseNoUsage()) });
    sink('res', { end: true });
    await new Promise((r) => setImmediate(r));

    const db = makeDb();
    const config = defaultConfig();
    const result = drainIngestSpool(db, config, dir);
    expect(result).toEqual({ drained: 1, quarantined: 0, pending: 0 });

    const row = db.prepare(
      `SELECT proxy_usage_json FROM transcripts ORDER BY ingested_at DESC LIMIT 1`,
    ).get() as { proxy_usage_json: string | null };

    expect(row.proxy_usage_json).not.toBeNull();
    const usage = JSON.parse(row.proxy_usage_json!) as Record<string, unknown>;
    expect(usage['provider']).toBe('openai');
    expect(usage['model']).toBe('gpt-4');
    // The discriminating assertion: null, not 0. A fabricated 0 here would
    // silently corrupt every future cost aggregation built on this column.
    expect(usage['input_tokens']).toBeNull();
    expect(usage['output_tokens']).toBeNull();
    expect(usage['total_tokens']).toBeNull();
    expect(usage['cache_creation_input_tokens']).toBeNull();
    expect(usage['cache_read_input_tokens']).toBeNull();
    expect(usage['stop_reason']).toBe('stop');
    expect(usage['truncated']).toBe(false);

    db.close();
  });

  it('a response shape extractUsageMetadata cannot recognize stores NULL in proxy_usage_json — byte-identical to pre-slice behavior for every other envelope field', async () => {
    const dir = freshDataDir();
    const createTee = createProxyCaptureTee({ dataDir: dir, clientVersion: '9.9.9', relevanceGate: GATE_OPTS });
    const sink = createTee();

    // The request still yields a real user turn (so the exchange spools at
    // all), but the response body matches neither provider's shape —
    // extractUsageMetadata / extractResponseTurn both return null on it.
    sink('req', { chunk: Buffer.from(anthropicRequest()) });
    sink('req', { end: true });
    sink('res', { chunk: Buffer.from(JSON.stringify({ not: 'a recognized provider shape' })) });
    sink('res', { end: true });
    await new Promise((r) => setImmediate(r));

    const db = makeDb();
    const config = defaultConfig();
    const result = drainIngestSpool(db, config, dir);
    expect(result).toEqual({ drained: 1, quarantined: 0, pending: 0 });

    const row = db.prepare(
      `SELECT proxy_usage_json FROM transcripts ORDER BY ingested_at DESC LIMIT 1`,
    ).get() as { proxy_usage_json: string | null };
    expect(row.proxy_usage_json).toBeNull();

    db.close();
  });
});
