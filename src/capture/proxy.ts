/**
 * LLM proxy capture fork (FEAT-458 S3, ADR-013 "Accepted" — Decision 3/4).
 *
 * Structurally distinct from `src/capture/claude.ts` per this ADR's own
 * framing: `claude.ts` reads a completed transcript FILE after the fact and
 * is incapable of mutating live traffic by construction. This module
 * consumes a live BODY-ONLY tee of an in-flight proxy exchange
 * (`src/proxy/server.ts`'s `ProxyTeeSink`) — it must not import or extend
 * any of `claude.ts`'s file-reading assumptions, and it never receives, is
 * never passed, and has no field capable of carrying request/response
 * HEADERS. The proxy forwards the `Authorization` header (and everything
 * else) to the upstream unchanged (`src/proxy/server.ts`); this module only
 * ever sees the two Buffer streams `ProxyTeeSink` hands it — that exclusion
 * is a type-boundary property, not a runtime filter (ADR-013 review
 * decision 3, "enforced by type boundary + regression test" — see
 * tests/proxy/canary-header-exclusion.test.ts).
 *
 * Reuses, unmodified: `src/ingest/spool.ts` (durable write — no new trust
 * boundary) and `src/capture/relevance-gate.ts` (source-side filtering,
 * ADR-012 decision 2) — same taxonomy and dedup mechanics hook-tap capture
 * already uses.
 */

import { randomUUID, createHash } from 'node:crypto';
import { stableStringify } from '../server/lib/stable-stringify.js';
import { gateRelevance, recordCapturedTurnHash, type RelevanceGateOptions } from './relevance-gate.js';
import { writeToSpool } from '../ingest/spool.js';
import type { ProxyTeeSink } from '../proxy/server.js';

export interface ProxyTurn {
  role: 'user' | 'assistant';
  text: string;
}

/**
 * Wire shape this module produces — same `CanonicalIngestSchema` (v1.0)
 * transcript-kind envelope every other capture path builds
 * (`src/server/routes/ingest.ts`), tagged `capture_source: 'proxy'`
 * (ADR-013 Decision 1, Repudiation row — a second live value alongside
 * `'auto_capture'`, migration 024's already-unconstrained TEXT column).
 */
export interface ProxyCaptureEnvelope {
  /**
   * `CanonicalIngestSchema.event` is a closed enum written for Claude Code's
   * own hook lifecycle (`pre_compact` | `session_end` | `subagent_stop`) —
   * none of those literally describe "one proxied LLM call completed", and
   * this module deliberately does not invent a fourth value (widening that
   * enum is a wire-contract change outside this slice's scope). `session_end`
   * is the closest existing analogue: each captured exchange is a complete,
   * closed unit on its own (there is no proxy-side session concept at all —
   * see `session_id` below) rather than a mid-stream checkpoint, which rules
   * out `pre_compact`/`subagent_stop`.
   */
  event: 'session_end';
  /**
   * The proxy has no session correlator to key off — headers are
   * structurally excluded (no client-supplied session/request id survives
   * to this module) and the body carries no session concept of its own. One
   * random id per captured EXCHANGE (not one per proxy process, not one per
   * upstream connection) is the only correlation-free option available at
   * body-only visibility.
   */
  session_id: string;
  /** No cwd/repo signal reaches a body-only capture fork — a fixed sentinel
   *  distinguishes proxy-sourced rows from every other project_id without
   *  fabricating a project this module cannot actually know. */
  project_id: 'llm-proxy';
  captured_at: string;
  kind: 'transcript';
  tool: 'llm-proxy';
  turns: ProxyTurn[];
  client_scrub_applied: boolean;
  client_scrub_hits: number;
  client_version: string;
  client_scrub_version: string;
  wire_version: 'v1.0';
  capture_source: 'proxy';
}

/** Extract conversational text from an OpenAI chat-completions `content`
 *  field — a plain string, or an array of parts where only `type: 'text'`
 *  blocks carry conversation. Mirrors `claude.ts`'s own `extractText`
 *  shape-for-shape (same multimodal content-block convention), reimplemented
 *  locally rather than imported — this module must not depend on
 *  `claude.ts` (file header). */
function extractOpenAIText(content: unknown): string {
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

/**
 * Parse an accumulated request-body buffer (already fully reassembled from
 * tee'd chunks — see `createProxyCaptureTee` below) into user turns. Only
 * `role: 'user'` messages become turns — `system`/`assistant`/`tool`
 * messages in the request are the caller's own prior context, not this
 * exchange's new human input, and (for a client that resends full history
 * on every call) capturing them here would re-spool the same content on
 * every request, exactly the volume the relevance gate's dedup window
 * exists to cut. Tolerant of any parse failure — returns no turns rather
 * than throwing (fail-silent capture, ADR-013 Decision 2).
 */
export function extractRequestTurns(rawBody: string): ProxyTurn[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object') return [];
  const messages = (parsed as Record<string, unknown>)['messages'];
  if (!Array.isArray(messages)) return [];

  const turns: ProxyTurn[] = [];
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    const msg = m as { role?: unknown; content?: unknown };
    if (msg.role !== 'user') continue;
    const text = extractOpenAIText(msg.content).trim();
    if (text) turns.push({ role: 'user', text });
  }
  return turns;
}

/**
 * Parse an accumulated response-body buffer into a single assistant turn.
 * Body-only visibility means there is no `content-type` header to branch
 * on, so the shape is detected from the bytes themselves: a non-streaming
 * OpenAI chat-completion is a single JSON object; a streaming one is a
 * newline-delimited `data: {...}` SSE sequence terminated by `data:
 * [DONE]`. Tries JSON first (cheap, and unambiguous when it succeeds — an
 * SSE body is never valid whole-buffer JSON), falls back to SSE parsing.
 * Any malformed line/chunk is skipped, never fatal — matches `claude.ts`'s
 * own transcript-parsing tolerance for a still-forming/imperfect stream.
 */
export function extractResponseTurn(rawBody: string): ProxyTurn | null {
  const trimmed = rawBody.trim();
  if (!trimmed) return null;

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const choices = parsed['choices'];
    if (Array.isArray(choices) && choices.length > 0) {
      const first = choices[0] as Record<string, unknown>;
      const message = first['message'] as Record<string, unknown> | undefined;
      if (message) {
        const text = extractOpenAIText(message['content']).trim();
        if (text) return { role: 'assistant', text };
      }
    }
    return null; // valid JSON, but not a recognized chat-completion shape
  } catch {
    // Not whole-buffer JSON — fall through to SSE parsing below.
  }

  let acc = '';
  for (const rawLine of trimmed.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('data:')) continue;
    const payload = line.slice('data:'.length).trim();
    if (payload === '' || payload === '[DONE]') continue;
    let obj: unknown;
    try {
      obj = JSON.parse(payload);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== 'object') continue;
    const choices = (obj as Record<string, unknown>)['choices'];
    if (!Array.isArray(choices) || choices.length === 0) continue;
    const delta = (choices[0] as Record<string, unknown>)['delta'];
    if (!delta || typeof delta !== 'object') continue;
    const content = (delta as Record<string, unknown>)['content'];
    if (typeof content === 'string') acc += content;
  }
  const text = acc.trim();
  return text ? { role: 'assistant', text } : null;
}

function buildProxyEnvelope(
  turns: ProxyTurn[],
  clientVersion: string,
  capturedAt = new Date().toISOString(),
): ProxyCaptureEnvelope {
  return {
    event: 'session_end',
    session_id: `proxy-${randomUUID()}`,
    project_id: 'llm-proxy',
    captured_at: capturedAt,
    kind: 'transcript',
    tool: 'llm-proxy',
    turns,
    // No client-side scrub for the proxy fork — the daemon's stage-0
    // redaction (SEC-3/5) is the enforcement point, same posture claude.ts
    // documents for its own v1.
    client_scrub_applied: false,
    client_scrub_hits: 0,
    client_version: clientVersion,
    client_scrub_version: 'none',
    wire_version: 'v1.0',
    capture_source: 'proxy',
  };
}

/**
 * Stable idempotency key (mirrors `claudeIdempotencyKey`'s exclusion
 * pattern): a SHA-256 stable-stringify hash of the envelope's CONTENT,
 * excluding both `captured_at` (varies every call even for identical
 * content) and `session_id` (this module mints a fresh random one per
 * exchange — see `ProxyCaptureEnvelope.session_id` doc — so including it
 * would defeat idempotency entirely, never colliding even for byte-identical
 * re-sends). Re-capturing an identical exchange therefore produces the SAME
 * key — a same-path spool overwrite, never an accumulating duplicate.
 */
export function proxyIdempotencyKey(envelope: ProxyCaptureEnvelope): string {
  const { captured_at: _capturedAt, session_id: _sessionId, ...stable } = envelope;
  return createHash('sha256').update(stableStringify(stable)).digest('hex');
}

export interface ProxyCaptureOptions {
  dataDir: string;
  clientVersion: string;
  relevanceGate: RelevanceGateOptions;
}

/**
 * Build a capture-fork attachment point for the LLM proxy. Call this ONCE
 * per proxy process — the returned factory is exactly what gets passed as
 * `ProxyServeOpts.createTee`; `src/proxy/server.ts` calls THAT once per
 * incoming request to obtain a fresh, per-exchange sink. Two different
 * closure lifetimes on purpose:
 *
 *   - This function's own closure (`recentHashes`) lives for the whole
 *     proxy process — the correct scope for the relevance gate's dedup
 *     window (ADR-012 decision 2) on a long-running daemon, unlike the
 *     one-shot `capture claude` CLI's per-invocation (and therefore
 *     always-empty-at-start) window.
 *   - The inner per-request closure (`reqChunks`/`resChunks`/the two
 *     `*Ended` flags) lives for exactly one exchange, so two concurrent
 *     requests through the same proxy never share — or corrupt — each
 *     other's buffered bytes.
 */
export function createProxyCaptureTee(opts: ProxyCaptureOptions): () => ProxyTeeSink {
  const recentHashes = new Set<string>();

  return function createSink(): ProxyTeeSink {
    const reqChunks: Buffer[] = [];
    const resChunks: Buffer[] = [];
    let reqEnded = false;
    let resEnded = false;
    let finished = false;

    function finishCapture(): void {
      const reqBody = Buffer.concat(reqChunks).toString('utf8');
      const resBody = Buffer.concat(resChunks).toString('utf8');

      const turns: ProxyTurn[] = extractRequestTurns(reqBody);
      const assistantTurn = extractResponseTurn(resBody);
      if (assistantTurn) turns.push(assistantTurn);
      if (turns.length === 0) return;

      const gated: ProxyTurn[] = [];
      for (const turn of turns) {
        if (gateRelevance(turn, recentHashes, opts.relevanceGate)) continue;
        recordCapturedTurnHash(recentHashes, turn.text, opts.relevanceGate.dedupWindow);
        gated.push(turn);
      }
      if (gated.length === 0) return;

      const envelope = buildProxyEnvelope(gated, opts.clientVersion);
      const key = proxyIdempotencyKey(envelope);
      writeToSpool(opts.dataDir, key, envelope);
    }

    function maybeFinish(): void {
      if (finished || !reqEnded || !resEnded) return;
      finished = true;
      // ADR-013 Decision 3 / FEAT-458 S3 requirement 6: writeToSpool is a
      // synchronous fs call (tmp-write + rename) — deferred via setImmediate
      // so it never runs inside the 'end' handler Node uses while finishing
      // the client-facing response. By the time this fires the forwarded
      // response is already fully complete, so a slow or failing capture
      // here can no longer backpressure it or delay accepting the next
      // request.
      setImmediate(() => {
        try {
          finishCapture();
        } catch {
          // Fail-silent capture (ADR-013 Decision 2) — this one exchange is
          // simply not captured; the already-completed forwarded
          // request/response is entirely unaffected.
        }
      });
    }

    return (dir, event) => {
      if ('chunk' in event) {
        (dir === 'req' ? reqChunks : resChunks).push(event.chunk);
        return;
      }
      if (dir === 'req') reqEnded = true;
      else resEnded = true;
      maybeFinish();
    };
  };
}
