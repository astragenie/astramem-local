/**
 * FEAT-476 Phase 0 — parseOtelLogsPayload: Claude Code's native
 * claude_code.api_request OTel log records -> CostEventInput rows,
 * source: 'otel'. Dollar fields (cost_usd/cost_usd_micros) are read from
 * the fixture but must never appear anywhere in the parsed result — see
 * the dedicated assertion below.
 */
import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseOtelLogsPayload, parseOtelLogsFile } from '../../src/capture/otel-ingest.js';

function strAttr(key: string, value: string) {
  return { key, value: { stringValue: value } };
}
function intAttr(key: string, value: number) {
  return { key, value: { intValue: String(value) } };
}

function apiRequestPayload(overrides: { attributes?: any[]; eventName?: string; timeUnixNano?: string } = {}) {
  return {
    resourceLogs: [
      {
        resource: { attributes: [] },
        scopeLogs: [
          {
            logRecords: [
              {
                eventName: overrides.eventName ?? 'claude_code.api_request',
                timeUnixNano: overrides.timeUnixNano ?? '1754476800000000000', // 2025-08-06T08:00:00Z-ish, arbitrary
                attributes: overrides.attributes ?? [
                  strAttr('model', 'claude-sonnet-5'),
                  strAttr('session.id', 'real-session-abc'),
                  strAttr('agent.name', 'builder'),
                  intAttr('input_tokens', 1000),
                  intAttr('output_tokens', 500),
                  intAttr('cache_read_tokens', 200),
                  intAttr('cache_creation_tokens', 50),
                  { key: 'cost_usd', value: { doubleValue: 0.0123 } },
                  intAttr('cost_usd_micros', 12300),
                  strAttr('event.timestamp', '2026-08-01T12:00:00.000Z'),
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

describe('parseOtelLogsPayload', () => {
  it('parses a claude_code.api_request record into a CostEventInput tagged source: otel', () => {
    const [event] = parseOtelLogsPayload(apiRequestPayload());
    expect(event).toBeDefined();
    expect(event!.source).toBe('otel');
    expect(event!.provider).toBe('anthropic');
    expect(event!.model).toBe('claude-sonnet-5');
    expect(event!.sessionKey).toBe('real-session-abc');
    expect(event!.agentRole).toBe('builder');
    expect(event!.inputTokens).toBe(1000);
    expect(event!.outputTokens).toBe(500);
    expect(event!.cacheReadInputTokens).toBe(200);
    expect(event!.cacheCreationInputTokens).toBe(50);
    expect(event!.capturedAtMs).toBe(Date.parse('2026-08-01T12:00:00.000Z'));
  });

  it('never carries a dollar figure anywhere on the parsed result — cost_usd/cost_usd_micros are read and discarded', () => {
    const [event] = parseOtelLogsPayload(apiRequestPayload());
    const serialized = JSON.stringify(event);
    expect(serialized).not.toMatch(/cost_usd|0\.0123|12300/);
  });

  it('infers provider "openai" from a gpt-* model id', () => {
    const [event] = parseOtelLogsPayload(apiRequestPayload({
      attributes: [
        strAttr('model', 'gpt-5.6-sol'),
        strAttr('session.id', 'sess-2'),
        intAttr('input_tokens', 10),
        intAttr('output_tokens', 5),
      ],
    }));
    expect(event!.provider).toBe('openai');
  });

  it('skips a record whose event name is not claude_code.api_request', () => {
    const events = parseOtelLogsPayload(apiRequestPayload({ eventName: 'claude_code.tool_result' }));
    expect(events).toHaveLength(0);
  });

  it('skips a record with no session.id — no usable attribution identity to fabricate', () => {
    const events = parseOtelLogsPayload(apiRequestPayload({
      attributes: [strAttr('model', 'claude-sonnet-5'), intAttr('input_tokens', 1)],
    }));
    expect(events).toHaveLength(0);
  });

  it('leaves token fields null when the OTel record does not carry them (never coerced to 0)', () => {
    const [event] = parseOtelLogsPayload(apiRequestPayload({
      attributes: [strAttr('model', 'claude-sonnet-5'), strAttr('session.id', 'sess-3')],
    }));
    expect(event!.inputTokens).toBeNull();
    expect(event!.outputTokens).toBeNull();
    expect(event!.cacheReadInputTokens).toBeNull();
  });

  it('falls back to timeUnixNano when event.timestamp is absent', () => {
    const [event] = parseOtelLogsPayload(apiRequestPayload({
      attributes: [strAttr('model', 'claude-sonnet-5'), strAttr('session.id', 'sess-4')],
      timeUnixNano: '1754476800000000000',
    }));
    expect(event!.capturedAtMs).toBe(1754476800000);
  });

  it('tolerates a payload with no resourceLogs at all', () => {
    expect(parseOtelLogsPayload({})).toEqual([]);
    expect(parseOtelLogsPayload(null)).toEqual([]);
    expect(parseOtelLogsPayload('garbage')).toEqual([]);
  });
});

describe('parseOtelLogsFile', () => {
  it('reads + parses a JSON file from disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'otel-ingest-test-'));
    const file = join(dir, 'export.json');
    writeFileSync(file, JSON.stringify(apiRequestPayload()));
    const events = parseOtelLogsFile(file);
    expect(events).toHaveLength(1);
    rmSync(dir, { recursive: true, force: true });
  });
});
