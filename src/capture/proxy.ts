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
 *
 * Wire-format support (FEAT-458 S5): both OpenAI chat-completions and the
 * Anthropic Messages API — the shape Claude Code itself speaks — are
 * parsed, detected from BODY BYTES ONLY per the header-exclusion invariant
 * above (there is no content-type header available to branch on even if
 * this module were allowed to see headers, which it structurally is not).
 * See `extractResponseTurn` / `extractSseResponseTurn` for the per-format
 * detection logic.
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
  /** FEAT-458 S6 — omitted entirely (not `null`) when `extractUsageMetadata`
   *  returns null (no recognized provider shape in the response body) so
   *  the field round-trips through `CanonicalIngestSchema`'s `.optional()`
   *  (src/server/routes/ingest.ts) rather than failing zod validation with
   *  a literal null against an object schema. */
  proxy_usage?: ProxyUsageMetadata;
}

/** Extract conversational text from a chat `content` field — a plain
 *  string, or an array of parts where only `type: 'text'` blocks carry
 *  conversation. Shared by BOTH wire formats this module supports: OpenAI
 *  chat-completions and the Anthropic Messages API use the identical
 *  multimodal content-block convention (`{type:'text', text:'...'}`
 *  alongside other typed blocks — `image_url` for OpenAI, `tool_use` /
 *  `tool_result` / `thinking` for Anthropic), so one shape-agnostic
 *  extractor covers both without needing to know which API produced the
 *  body. Mirrors `claude.ts`'s own `extractText` shape-for-shape,
 *  reimplemented locally rather than imported — this module must not depend
 *  on `claude.ts` (file header). */
function extractContentBlockText(content: unknown): string {
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
 *
 * Wire-format note: an Anthropic Messages API request carries its system
 * prompt in a top-level `system` field (a string, or an array of text
 * blocks) rather than as a `role: 'system'` entry inside `messages[]` —
 * unlike OpenAI, which puts system content in `messages[]` where the
 * `role !== 'user'` filter above already excludes it. This function
 * deliberately never reads `parsed.system` at all, for both APIs: it's
 * boilerplate that repeats on every call in a client that resends full
 * history (exactly the redundant-volume problem the role filter above
 * exists to avoid for OpenAI's system messages too), it can be large, and
 * it is the highest-sensitivity part of the payload (product/tool
 * instructions, not user-authored content) — capturing it isn't this
 * module's call to make silently. The `role: 'user'` filter is what
 * happens to also make this the behavior for both formats; no per-format
 * branch was needed. `messages[].content` itself — string or array of
 * typed blocks (Anthropic user turns can include `tool_result` blocks
 * alongside `text`) — is handled by `extractContentBlockText`, which only
 * ever pulls `type: 'text'` blocks; a `tool_result` block is therefore
 * skipped like any other non-text block, consistent with "only NEW human
 * input becomes a turn."
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
    const text = extractContentBlockText(msg.content).trim();
    if (text) turns.push({ role: 'user', text });
  }
  return turns;
}

/**
 * Parse an accumulated response-body buffer into a single assistant turn.
 * Body-only visibility means there is no `content-type` header to branch
 * on, so BOTH the streaming-vs-whole-JSON split AND the OpenAI-vs-Anthropic
 * wire-format split are detected from the bytes themselves — see
 * `extractSseResponseTurn` below for the streaming-format sniff. A
 * non-streaming response of either format is a single JSON object; a
 * streaming one is a newline-delimited SSE sequence. Tries JSON first
 * (cheap, and unambiguous when it succeeds — an SSE body is never valid
 * whole-buffer JSON), falls back to SSE parsing. Any malformed line/chunk
 * is skipped, never fatal — matches `claude.ts`'s own transcript-parsing
 * tolerance for a still-forming/imperfect stream.
 */
export function extractResponseTurn(rawBody: string): ProxyTurn | null {
  const trimmed = rawBody.trim();
  if (!trimmed) return null;

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;

    // OpenAI chat-completion: `{ choices: [{ message: { content } }] }`.
    const choices = parsed['choices'];
    if (Array.isArray(choices) && choices.length > 0) {
      const first = choices[0] as Record<string, unknown>;
      const message = first['message'] as Record<string, unknown> | undefined;
      if (message) {
        const text = extractContentBlockText(message['content']).trim();
        if (text) return { role: 'assistant', text };
      }
      return null;
    }

    // Anthropic Messages API non-streaming response has no `choices` field
    // at all: `{ content: [...typed blocks...], role: 'assistant',
    // stop_reason, ... }`. Only `type: 'text'` blocks carry conversation —
    // `tool_use`/`thinking` blocks are deliberately skipped by
    // `extractContentBlockText`, matching `claude.ts`'s own convention for
    // this identical block shape (module doc / see that file's
    // `extractText`). A tool-only response (no text block at all) falls
    // through to `text` being empty and correctly returns null below — no
    // assistant turn, not an error.
    const content = parsed['content'];
    if (Array.isArray(content)) {
      const text = extractContentBlockText(content).trim();
      if (text) return { role: 'assistant', text };
      return null;
    }

    return null; // valid JSON, but not a recognized response shape
  } catch {
    // Not whole-buffer JSON — fall through to SSE parsing below.
  }

  return extractSseResponseTurn(trimmed);
}

/**
 * Reconstruct an assistant turn from an SSE-framed streaming response body.
 * Two wire vocabularies share this one parser, discriminated by the shape
 * of each `data:` payload — never by headers, and not even by the
 * preceding `event:` line (ignored; each Anthropic payload's own `type`
 * field is redundant with it, so classifying by payload shape alone is
 * strictly more robust — it survives a client that omits `event:` lines
 * entirely):
 *
 *   - OpenAI: `data: {"choices":[{"delta":{"content":"..."}}]}` chunks,
 *     terminated by a literal `data: [DONE]` line. A single running
 *     accumulator is correct here — OpenAI's delta stream carries exactly
 *     one logical text stream.
 *   - Anthropic: `event: content_block_delta` / `data:
 *     {"type":"content_block_delta","index":N,"delta":{"type":"text_delta","text":"..."}}`,
 *     no `[DONE]` sentinel — the stream simply ends after `message_stop`.
 *     Anthropic responses can carry multiple CONCURRENT content blocks
 *     (e.g. a text block and a tool_use block, each its own `index`, whose
 *     deltas may interleave on the wire) — so text is accumulated
 *     per-index in a map, not into one running string, and only
 *     `text_delta` chunks are appended (an `input_json_delta` — a
 *     tool_use block's partial JSON args — or a `thinking_delta` /
 *     `signature_delta` — extended-thinking content — under a DIFFERENT
 *     index never corrupts the visible reply text even mid-interleave).
 *     The final turn joins each captured text block's accumulated string,
 *     in ascending index order, with '\n' — matching how
 *     `extractContentBlockText` already joins multiple text blocks from a
 *     non-streaming `content[]` array.
 *
 * A response is always ONE format or the other in practice (a real
 * upstream never mixes vocabularies), so accumulating both defensively and
 * preferring whichever is non-empty is safe and avoids needing an upfront
 * format-sniff pass over the whole body.
 */
function extractSseResponseTurn(trimmed: string): ProxyTurn | null {
  let openaiAcc = '';
  const anthropicTextBlocks = new Map<number, string>();

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
    const rec = obj as Record<string, unknown>;

    const choices = rec['choices'];
    if (Array.isArray(choices) && choices.length > 0) {
      const delta = (choices[0] as Record<string, unknown>)['delta'];
      if (delta && typeof delta === 'object') {
        const content = (delta as Record<string, unknown>)['content'];
        if (typeof content === 'string') openaiAcc += content;
      }
      continue;
    }

    if (rec['type'] === 'content_block_delta') {
      const index = rec['index'];
      const delta = rec['delta'];
      if (typeof index === 'number' && delta && typeof delta === 'object') {
        const d = delta as Record<string, unknown>;
        if (d['type'] === 'text_delta' && typeof d['text'] === 'string') {
          anthropicTextBlocks.set(index, (anthropicTextBlocks.get(index) ?? '') + d['text']);
        }
        // input_json_delta (tool_use args) / thinking_delta / signature_delta
        // (extended thinking) — not conversational reply text, skipped.
      }
      continue;
    }
    // message_start / content_block_start / content_block_stop /
    // message_delta / message_stop / ping — no text payload, ignored.
  }

  const openaiText = openaiAcc.trim();
  if (openaiText) return { role: 'assistant', text: openaiText };

  if (anthropicTextBlocks.size > 0) {
    const anthropicText = [...anthropicTextBlocks.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, text]) => text)
      .join('\n')
      .trim();
    if (anthropicText) return { role: 'assistant', text: anthropicText };
  }

  return null; // no text_delta / delta.content anywhere — an empty or
  // tool-only/aborted stream, not an error.
}

/**
 * Token/cost telemetry for one exchange — BODY BYTES ONLY, same visibility
 * as turn extraction above, never headers.
 *
 * WIRED into `ProxyCaptureEnvelope` / `finishCapture` below as of FEAT-458
 * S6 — `CanonicalIngestSchema` (src/server/routes/ingest.ts) now carries an
 * explicit optional `proxy_usage` field, so the previously-documented strip-
 * mode hazard (an unknown envelope field silently REMOVED by zod's default
 * "strip" behavior at drain-time `safeParse`, not rejected — the false-
 * confidence failure mode this module already got bitten by once, module
 * doc, S3) is closed: the field now has a schema home before it is ever
 * attached, not after.
 *
 * - `model`: read from the REQUEST body's top-level `model` field only,
 *   for both wire formats — a client always specifies what to call, so
 *   it's unconditionally present there, unlike the response side (an
 *   Anthropic streaming response only echoes it inside the `message_start`
 *   event, which a truncated/aborted capture might not have; some
 *   gateways drop it from non-streaming responses entirely). One source of
 *   truth, always populated when the request parsed at all.
 * - `stop_reason`: Anthropic's `stop_reason` / OpenAI's `finish_reason`,
 *   normalized into one field. `truncated` is derived from it: Anthropic
 *   `"max_tokens"` / OpenAI `"length"` — both mean the reply was cut off
 *   before the model finished, which the operator cares about regardless
 *   of which API served it.
 * - Cache fields (`cache_creation_input_tokens` / `cache_read_input_tokens`)
 *   are Anthropic-only and kept SEPARATE from `input_tokens` rather than
 *   folded in — this is the operator's single biggest lever on API cost
 *   and collapsing it into one number would erase the signal that matters.
 * - Every numeric field is `number | null` — `null` means "not present in
 *   this body" and is never coerced to `0`. A fabricated zero here would
 *   silently corrupt any cost aggregation built on top later; a missing
 *   value must stay visibly missing. The clearest case is OpenAI streaming
 *   without `stream_options.include_usage` set — no chunk ever carries a
 *   `usage` field, so every token count stays `null` while `model` and
 *   `stop_reason` (available independent of that flag) still populate.
 * - No dollar-cost computation — a per-model pricing table rots the moment
 *   prices change, and a confidently-wrong dollar figure is worse than raw
 *   counts. Pricing is a deliberate, separate decision.
 * - Returns `null` only when the response body itself carries no
 *   recognizable provider shape at all (empty, malformed, or neither
 *   `choices` nor `content`/Anthropic-event-typed) — matches
 *   `extractResponseTurn`'s own "unrecognized shape → null" convention.
 */
export interface ProxyUsageMetadata {
  provider: 'anthropic' | 'openai';
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  /** OpenAI only (`usage.total_tokens`) — Anthropic doesn't report a
   *  pre-summed total, and this module doesn't compute one itself (that
   *  would be silently wrong the instant cache tokens are involved). */
  total_tokens: number | null;
  cache_creation_input_tokens: number | null;
  cache_read_input_tokens: number | null;
  stop_reason: string | null;
  truncated: boolean;
}

function numberOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
}

/** The request body's top-level `model` field — see the module-level
 *  rationale above for why this, and never the response, is the source. */
function extractRequestModel(rawBody: string): string | null {
  try {
    const parsed = JSON.parse(rawBody) as Record<string, unknown>;
    const model = parsed['model'];
    return typeof model === 'string' && model ? model : null;
  } catch {
    return null;
  }
}

/** Provider-shaped usage accumulated from an SSE stream — `model` is
 *  deliberately absent here (always merged in from the request by the
 *  caller, `extractUsageMetadata`), so this stays a pure accumulator over
 *  `message_start`/`message_delta` (Anthropic) or the trailing usage chunk
 *  (OpenAI, only present when the client opted in). */
function extractSseUsageMetadata(trimmed: string): Omit<ProxyUsageMetadata, 'model' | 'truncated'> | null {
  let sawOpenAI = false;
  let sawAnthropic = false;
  let openaiInputTokens: number | null = null;
  let openaiOutputTokens: number | null = null;
  let openaiTotalTokens: number | null = null;
  let openaiFinishReason: string | null = null;
  let anthropicInputTokens: number | null = null;
  let anthropicOutputTokens: number | null = null;
  let anthropicCacheCreation: number | null = null;
  let anthropicCacheRead: number | null = null;
  let anthropicStopReason: string | null = null;

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
    const rec = asRecord(obj);
    if (!rec) continue;

    const choices = rec['choices'];
    if (Array.isArray(choices)) {
      sawOpenAI = true;
      if (choices.length > 0) {
        const finishReason = asRecord(choices[0])?.['finish_reason'];
        if (typeof finishReason === 'string') openaiFinishReason = finishReason;
      }
      const usage = asRecord(rec['usage']);
      if (usage) {
        // OpenAI only emits this on the final chunk when
        // stream_options.include_usage was set — overwrite is safe since
        // it's a one-shot cumulative total, never a running delta.
        openaiInputTokens = numberOrNull(usage['prompt_tokens']);
        openaiOutputTokens = numberOrNull(usage['completion_tokens']);
        openaiTotalTokens = numberOrNull(usage['total_tokens']);
      }
      continue;
    }

    const type = rec['type'];
    if (type === 'message_start') {
      sawAnthropic = true;
      const usage = asRecord(asRecord(rec['message'])?.['usage']);
      if (usage) {
        anthropicInputTokens = numberOrNull(usage['input_tokens']);
        anthropicCacheCreation = numberOrNull(usage['cache_creation_input_tokens']);
        anthropicCacheRead = numberOrNull(usage['cache_read_input_tokens']);
        // A small placeholder output_tokens sometimes rides along here too
        // (e.g. 1) — message_delta below carries the real cumulative total
        // and overwrites it; only fall back to this if message_delta never
        // arrives (an aborted stream).
        if (anthropicOutputTokens === null) anthropicOutputTokens = numberOrNull(usage['output_tokens']);
      }
      continue;
    }
    if (type === 'message_delta') {
      sawAnthropic = true;
      const stopReason = asRecord(rec['delta'])?.['stop_reason'];
      if (typeof stopReason === 'string') anthropicStopReason = stopReason;
      const outputTokens = numberOrNull(asRecord(rec['usage'])?.['output_tokens']);
      if (outputTokens !== null) anthropicOutputTokens = outputTokens;
      continue;
    }
    // message_stop / content_block_* / ping — no usage payload, ignored.
  }

  if (sawAnthropic) {
    return {
      provider: 'anthropic',
      input_tokens: anthropicInputTokens,
      output_tokens: anthropicOutputTokens,
      total_tokens: null,
      cache_creation_input_tokens: anthropicCacheCreation,
      cache_read_input_tokens: anthropicCacheRead,
      stop_reason: anthropicStopReason,
    };
  }
  if (sawOpenAI) {
    return {
      provider: 'openai',
      input_tokens: openaiInputTokens,
      output_tokens: openaiOutputTokens,
      total_tokens: openaiTotalTokens,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      stop_reason: openaiFinishReason,
    };
  }
  return null;
}

/** Public entry point — see the interface doc above for the full field
 *  rationale. Mirrors `extractResponseTurn`'s own whole-JSON-then-SSE
 *  detection order and per-shape branching, on the SAME accumulated
 *  request/response body buffers (already fully reassembled — see
 *  `createProxyCaptureTee` below). */
export function extractUsageMetadata(reqBody: string, resBody: string): ProxyUsageMetadata | null {
  const model = extractRequestModel(reqBody);
  const trimmed = resBody.trim();
  if (!trimmed) return null;

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;

    const choices = parsed['choices'];
    if (Array.isArray(choices)) {
      const usage = asRecord(parsed['usage']);
      const finishReason = choices.length > 0 ? asRecord(choices[0])?.['finish_reason'] : null;
      const stopReason = typeof finishReason === 'string' ? finishReason : null;
      return {
        provider: 'openai',
        model,
        input_tokens: usage ? numberOrNull(usage['prompt_tokens']) : null,
        output_tokens: usage ? numberOrNull(usage['completion_tokens']) : null,
        total_tokens: usage ? numberOrNull(usage['total_tokens']) : null,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
        stop_reason: stopReason,
        truncated: stopReason === 'length',
      };
    }

    const content = parsed['content'];
    if (Array.isArray(content)) {
      const usage = asRecord(parsed['usage']);
      const stopReasonRaw = parsed['stop_reason'];
      const stopReason = typeof stopReasonRaw === 'string' ? stopReasonRaw : null;
      return {
        provider: 'anthropic',
        model,
        input_tokens: usage ? numberOrNull(usage['input_tokens']) : null,
        output_tokens: usage ? numberOrNull(usage['output_tokens']) : null,
        total_tokens: null,
        cache_creation_input_tokens: usage ? numberOrNull(usage['cache_creation_input_tokens']) : null,
        cache_read_input_tokens: usage ? numberOrNull(usage['cache_read_input_tokens']) : null,
        stop_reason: stopReason,
        truncated: stopReason === 'max_tokens',
      };
    }

    return null;
  } catch {
    // Not whole-buffer JSON — fall through to SSE parsing below.
  }

  const sse = extractSseUsageMetadata(trimmed);
  if (!sse) return null;
  return {
    ...sse,
    model,
    truncated: sse.provider === 'anthropic' ? sse.stop_reason === 'max_tokens' : sse.stop_reason === 'length',
  };
}

function buildProxyEnvelope(
  turns: ProxyTurn[],
  clientVersion: string,
  usage: ProxyUsageMetadata | null,
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
    // Omitted (not null) when extraction found no recognized provider shape
    // — see ProxyCaptureEnvelope.proxy_usage doc for why that distinction
    // matters against CanonicalIngestSchema's `.optional()` field.
    ...(usage != null ? { proxy_usage: usage } : {}),
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

      // Usage extraction runs independent of the relevance gate above — it's
      // exchange-level telemetry, not turn content, so it's computed once on
      // the full (pre-gate) bodies regardless of which individual turns
      // survived gating.
      const usage = extractUsageMetadata(reqBody, resBody);
      const envelope = buildProxyEnvelope(gated, opts.clientVersion, usage);
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
