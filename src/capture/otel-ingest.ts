/**
 * FEAT-476 Phase 0 — parses Claude Code's native OTel export
 * (`claude_code.api_request` log records) into `CostEventInput` rows
 * (src/storage/cost-events.ts), tagged `source: 'otel'`.
 *
 * This is the PREFERRED ingest path per the FEAT-476 spec: unlike the proxy
 * tee (src/capture/proxy.ts, body-only visibility, no real session
 * correlator), Claude Code's own OTel export carries a real `session.id`
 * and `agent.name` directly on the event — richer attribution, which is why
 * `recordCostEvent` (src/storage/cost-events.ts) always prefers an 'otel'
 * row over a 'proxy' row on a dedup collision (AC-6).
 *
 * Attribute names below are Claude Code's own documented OTel schema
 * (event name `claude_code.api_request`; attributes `model`, `session.id`,
 * `agent.name`, `input_tokens`, `output_tokens`, `cache_read_tokens`,
 * `cache_creation_tokens`, `cost_usd`/`cost_usd_micros`, `event.timestamp`).
 * `cost_usd`/`cost_usd_micros` are read and DISCARDED, never persisted —
 * this ledger never stores a dollar amount as a column, on any table,
 * regardless of what a provider or the OTel emitter itself claims the cost
 * was (FEAT-476 spec, "Data model decision" section). Anthropic's own
 * `stop_reason` is NOT part of Claude Code's documented event schema, so
 * `stopReason`/`truncated` are always `null`/`false` for OTel-sourced rows
 * in Phase 0 — a named, honest gap (the OTel path currently cannot detect a
 * truncated reply the way the proxy tee's response-body parse can), not a
 * silent one.
 *
 * Ingest surface (Phase 0 scope decision): a CLI-driven FILE ingest
 * (`astramem-local cost otel-ingest --file <path>`, src/cli/cost.ts) that
 * reads a standard OTLP/HTTP-JSON logs export payload from disk — the exact
 * shape an OTel Collector's file exporter writes, or that Claude Code's own
 * `OTEL_EXPORTER_OTLP_PROTOCOL=http/json` export produces when pointed at a
 * capturing endpoint. A live HTTP OTLP receiver endpoint (so Claude Code can
 * point `OTEL_EXPORTER_OTLP_ENDPOINT` directly at this daemon) is a
 * reasonable fast-follow but is NOT built in this slice — it would need new
 * config surface, auth wiring, and app.ts route registration disproportionate
 * to a "1-2 week internal tool" Phase 0 (see FEAT-476 spec's own scoping
 * note); the file-ingest path already exercises the full parse/dedup/report
 * contract end to end and is directly usable with an OTel Collector's file
 * exporter today.
 */
import { readFileSync } from 'node:fs';
import type { CostEventInput } from '../storage/cost-events.js';

interface OtlpAnyValue {
  stringValue?: string;
  intValue?: string | number;
  doubleValue?: number;
  boolValue?: boolean;
}

interface OtlpKeyValue {
  key?: string;
  value?: OtlpAnyValue;
}

interface OtlpLogRecord {
  eventName?: string;
  timeUnixNano?: string | number;
  attributes?: OtlpKeyValue[];
}

interface OtlpScopeLogs {
  logRecords?: OtlpLogRecord[];
}

interface OtlpResourceLogs {
  scopeLogs?: OtlpScopeLogs[];
}

interface OtlpLogsPayload {
  resourceLogs?: OtlpResourceLogs[];
}

const API_REQUEST_EVENT_NAME = 'claude_code.api_request';

function flattenAttributes(attrs: OtlpKeyValue[] | undefined): Map<string, string | number | boolean> {
  const out = new Map<string, string | number | boolean>();
  if (!Array.isArray(attrs)) return out;
  for (const kv of attrs) {
    if (!kv || typeof kv.key !== 'string' || !kv.value) continue;
    const v = kv.value;
    if (typeof v.stringValue === 'string') out.set(kv.key, v.stringValue);
    else if (v.intValue !== undefined) out.set(kv.key, typeof v.intValue === 'string' ? Number(v.intValue) : v.intValue);
    else if (typeof v.doubleValue === 'number') out.set(kv.key, v.doubleValue);
    else if (typeof v.boolValue === 'boolean') out.set(kv.key, v.boolValue);
  }
  return out;
}

function stringAttr(attrs: Map<string, string | number | boolean>, key: string): string | null {
  const v = attrs.get(key);
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function numberAttr(attrs: Map<string, string | number | boolean>, key: string): number | null {
  const v = attrs.get(key);
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Provider is not an attribute Claude Code's OTel export carries directly
 *  — inferred from the `model` id's own naming convention (this
 *  environment's own model ids: `claude-*` / `gpt-*`), matching the
 *  Anthropic-and-OpenAI-only Phase 0 scope (FEAT-476 non-goals). A model id
 *  matching neither prefix yields `null` — surfaced honestly as an
 *  unrecognized provider rather than guessed, same posture as everything
 *  else in this ledger. */
function inferProvider(model: string | null): string | null {
  if (!model) return null;
  if (model.startsWith('claude')) return 'anthropic';
  if (model.startsWith('gpt')) return 'openai';
  return null;
}

/**
 * Parse one already-JSON-decoded OTLP logs export payload into
 * `CostEventInput` rows — pure, no I/O. Only `claude_code.api_request`
 * records are extracted; every other event name (or a record missing the
 * `model`/token attributes entirely) is silently skipped, not an error —
 * an OTel export stream legitimately carries many other Claude Code event
 * types this ledger has no use for.
 */
export function parseOtelLogsPayload(payload: unknown): CostEventInput[] {
  const results: CostEventInput[] = [];
  if (!payload || typeof payload !== 'object') return results;
  const resourceLogs = (payload as OtlpLogsPayload).resourceLogs;
  if (!Array.isArray(resourceLogs)) return results;

  for (const rl of resourceLogs) {
    const scopeLogsList = rl?.scopeLogs;
    if (!Array.isArray(scopeLogsList)) continue;
    for (const scopeLogs of scopeLogsList) {
      const records = scopeLogs?.logRecords;
      if (!Array.isArray(records)) continue;
      for (const record of records) {
        const attrs = flattenAttributes(record.attributes);
        const eventName = record.eventName ?? stringAttr(attrs, 'event.name');
        const isApiRequest = eventName === API_REQUEST_EVENT_NAME || eventName === 'api_request';
        if (!isApiRequest) continue;

        const model = stringAttr(attrs, 'model');
        const sessionId = stringAttr(attrs, 'session.id');
        // A record with no session.id has no usable attribution identity at
        // all in this schema — skip rather than fabricate one (an OTel row
        // synthesizing its own random session key would defeat the entire
        // point of preferring this path over the proxy tee, AC-6's
        // rationale).
        if (!sessionId) continue;

        const capturedAtMs = resolveCapturedAtMs(record, attrs);

        results.push({
          source: 'otel',
          capturedAtMs,
          provider: inferProvider(model) ?? 'unknown',
          model,
          inputTokens: numberAttr(attrs, 'input_tokens'),
          outputTokens: numberAttr(attrs, 'output_tokens'),
          cacheReadInputTokens: numberAttr(attrs, 'cache_read_tokens'),
          cacheCreationInputTokens: numberAttr(attrs, 'cache_creation_tokens'),
          // Not part of Claude Code's documented api_request schema — named
          // gap, see module doc.
          stopReason: null,
          truncated: false,
          sessionKey: sessionId,
          agentRole: stringAttr(attrs, 'agent.name'),
        });
      }
    }
  }
  return results;
}

function resolveCapturedAtMs(record: OtlpLogRecord, attrs: Map<string, string | number | boolean>): number {
  const eventTimestamp = stringAttr(attrs, 'event.timestamp');
  if (eventTimestamp) {
    const parsed = Date.parse(eventTimestamp);
    if (!Number.isNaN(parsed)) return parsed;
  }
  const timeUnixNano = record.timeUnixNano;
  if (timeUnixNano !== undefined) {
    const nanos = typeof timeUnixNano === 'string' ? BigInt(timeUnixNano) : BigInt(Math.trunc(timeUnixNano));
    return Number(nanos / 1_000_000n);
  }
  return Date.now();
}

/** CLI-facing convenience: read + parse a JSON file from disk (see module
 *  doc for why this is the Phase 0 ingest surface). Throws on a missing or
 *  non-JSON file — the CLI command surfaces that directly to the operator
 *  rather than silently reporting zero events ingested. */
export function parseOtelLogsFile(path: string): CostEventInput[] {
  const raw = readFileSync(path, 'utf8');
  const parsed = JSON.parse(raw);
  return parseOtelLogsPayload(parsed);
}
