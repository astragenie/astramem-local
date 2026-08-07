/**
 * FEAT-476 Phase 0 — cost_events + price_versions storage layer.
 * Covers AC-1 (derived at read time, no stored $ column), AC-2 (correction
 * vs new-price-version distinction), AC-3 (unknown-usage), AC-4 (unpriced
 * model), AC-6 (dedup, OTel preferred), AC-7 (slice attribution buckets),
 * AC-8 (cache read/write as distinct line items + cache-hit ratio +
 * truncated count).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import {
  recordCostEvent, computeDedupKey, findPriceVersion, addPriceVersion, correctPriceVersion,
  costReport, listCostEvents, type CostEventInput,
} from '../../src/storage/cost-events.js';
import type { WorkflowStateWindow } from '../../src/storage/slice-attribution.js';

function makeDb(): DB {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

function baseInput(overrides: Partial<CostEventInput> = {}): CostEventInput {
  return {
    source: 'proxy',
    capturedAtMs: Date.parse('2026-08-01T12:00:00.000Z'),
    provider: 'anthropic',
    model: 'claude-sonnet-5',
    inputTokens: 1000,
    outputTokens: 500,
    cacheReadInputTokens: null,
    cacheCreationInputTokens: null,
    stopReason: 'end_turn',
    truncated: false,
    sessionKey: 'proxy-abc123',
    agentRole: null,
    ...overrides,
  };
}

describe('cost_events schema (migration 064) — dollar amounts never stored', () => {
  it('AC-1: cost_events has no dollar/usd column at all', () => {
    const db = makeDb();
    const cols = db.prepare("PRAGMA table_info('cost_events')").all() as { name: string }[];
    const names = cols.map(c => c.name);
    expect(names).not.toContain('amount_usd');
    expect(names.some(n => /usd|dollar|cost/i.test(n))).toBe(false);
  });

  it('AC-1: price_versions has no pre-computed dollar total either — only rates', () => {
    const db = makeDb();
    const cols = db.prepare("PRAGMA table_info('price_versions')").all() as { name: string }[];
    const names = cols.map(c => c.name);
    expect(names).toContain('input_rate');
    expect(names).toContain('output_rate');
    expect(names.some(n => n === 'amount_usd' || n === 'total_usd')).toBe(false);
  });

  it('seeds real Anthropic + OpenAI price_versions rows (data, not code constants)', () => {
    const db = makeDb();
    const rows = db.prepare("SELECT provider, model, tier FROM price_versions WHERE source = 'config'").all() as { provider: string }[];
    expect(rows.length).toBeGreaterThan(10);
    expect(rows.some(r => r.provider === 'anthropic')).toBe(true);
    expect(rows.some(r => r.provider === 'openai')).toBe(true);
  });
});

describe('recordCostEvent / computeDedupKey — AC-6 dedup + OTel preference', () => {
  let db: DB;
  beforeEach(() => { db = makeDb(); });

  it('inserts a brand-new row on first delivery', () => {
    const res = recordCostEvent(db, baseInput());
    expect(res).toEqual({ inserted: true, preferred: true });
    expect(listCostEvents(db)).toHaveLength(1);
  });

  it('re-delivering the identical exchange from the SAME source is an idempotent no-op', () => {
    recordCostEvent(db, baseInput());
    const res = recordCostEvent(db, baseInput());
    expect(res).toEqual({ inserted: false, preferred: false });
    expect(listCostEvents(db)).toHaveLength(1);
  });

  it('AC-6: an otel row for the SAME exchange replaces an existing proxy row (richer attribution wins)', () => {
    recordCostEvent(db, baseInput({ source: 'proxy', sessionKey: 'proxy-xyz', agentRole: null }));
    const res = recordCostEvent(db, baseInput({ source: 'otel', sessionKey: 'real-session-42', agentRole: 'builder' }));
    expect(res).toEqual({ inserted: false, preferred: true });

    const rows = listCostEvents(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.source).toBe('otel');
    expect(rows[0]!.sessionKey).toBe('real-session-42');
    expect(rows[0]!.agentRole).toBe('builder');
  });

  it('AC-6: a LATER proxy row for an exchange already claimed by otel does not displace it', () => {
    recordCostEvent(db, baseInput({ source: 'otel', sessionKey: 'real-session-42', agentRole: 'builder' }));
    const res = recordCostEvent(db, baseInput({ source: 'proxy', sessionKey: 'proxy-xyz', agentRole: null }));
    expect(res).toEqual({ inserted: false, preferred: false });

    const rows = listCostEvents(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.source).toBe('otel');
  });

  it('two DIFFERENT exchanges (different token counts) never collide', () => {
    recordCostEvent(db, baseInput({ inputTokens: 1000 }));
    recordCostEvent(db, baseInput({ inputTokens: 1001 }));
    expect(listCostEvents(db)).toHaveLength(2);
  });

  it('computeDedupKey hashes null token fields as a distinct sentinel — an unknown-usage row never collides with a real one at the same time-bucket', () => {
    const withUsage = computeDedupKey({ provider: 'anthropic', model: 'claude-sonnet-5', capturedAtMs: 1000, inputTokens: 0, outputTokens: 0, cacheReadInputTokens: null, cacheCreationInputTokens: null });
    const withoutUsage = computeDedupKey({ provider: 'anthropic', model: 'claude-sonnet-5', capturedAtMs: 1000, inputTokens: null, outputTokens: null, cacheReadInputTokens: null, cacheCreationInputTokens: null });
    expect(withUsage).not.toBe(withoutUsage);
  });

  it('time-bucketing tolerates small clock skew between the two ingest paths for the same exchange', () => {
    const a = computeDedupKey({ provider: 'anthropic', model: 'claude-sonnet-5', capturedAtMs: 1_000_000, inputTokens: 10, outputTokens: 5, cacheReadInputTokens: null, cacheCreationInputTokens: null });
    const b = computeDedupKey({ provider: 'anthropic', model: 'claude-sonnet-5', capturedAtMs: 1_000_900, inputTokens: 10, outputTokens: 5, cacheReadInputTokens: null, cacheCreationInputTokens: null });
    expect(a).toBe(b); // within the same 5s bucket
  });
});

describe('findPriceVersion — AC-4 prefix match + honest miss', () => {
  let db: DB;
  beforeEach(() => { db = makeDb(); });

  it('resolves a date-suffixed real model id against a seeded prefix', () => {
    const price = findPriceVersion(db, { provider: 'anthropic', model: 'claude-sonnet-5-20260815', atMs: Date.now() });
    expect(price).not.toBeNull();
    expect(price!.model).toBe('claude-sonnet-5');
  });

  it('AC-4: returns null (never a guessed default) for a completely unknown model', () => {
    const price = findPriceVersion(db, { provider: 'anthropic', model: 'claude-nonexistent-model-9000', atMs: Date.now() });
    expect(price).toBeNull();
  });

  it('longest-prefix-wins disambiguates two seeded rows that share a common prefix', () => {
    const db2 = makeDb();
    addPriceVersion(db2, {
      provider: 'test', model: 'foo', tier: 'standard', effectiveFrom: 0, effectiveTo: null,
      inputRate: 0.000001, outputRate: 0.000002, cacheReadMultiplier: 1, cacheWriteMultiplier: 1,
    });
    addPriceVersion(db2, {
      provider: 'test', model: 'foo-bar', tier: 'standard', effectiveFrom: 0, effectiveTo: null,
      inputRate: 0.00001, outputRate: 0.00002, cacheReadMultiplier: 1, cacheWriteMultiplier: 1,
    });
    const price = findPriceVersion(db2, { provider: 'test', model: 'foo-bar-20260101', atMs: Date.now() });
    expect(price!.model).toBe('foo-bar');
  });
});

describe('AC-2: price correction vs genuine new price version', () => {
  let db: DB;
  beforeEach(() => { db = makeDb(); });

  it('correcting an existing row changes ALL historical figures computed against its window', () => {
    const id = addPriceVersion(db, {
      provider: 'testco', model: 'test-model', tier: 'standard', effectiveFrom: 0, effectiveTo: null,
      inputRate: 0.000001, outputRate: 0.000002, cacheReadMultiplier: 1, cacheWriteMultiplier: 1,
    });
    recordCostEvent(db, baseInput({
      provider: 'testco', model: 'test-model', inputTokens: 1_000_000, outputTokens: 1_000_000,
      capturedAtMs: Date.parse('2026-01-01T00:00:00.000Z'),
    }));

    const before = costReport(db, { workflowStateWindows: [] });
    expect(before.totalUsd).toBeCloseTo(0.000001 * 1_000_000 + 0.000002 * 1_000_000, 6); // 1.0 + 2.0

    // A typo fix: the input rate was always supposed to be 0.000002, not 0.000001.
    correctPriceVersion(db, id, { inputRate: 0.000002 });
    const after = costReport(db, { workflowStateWindows: [] });
    expect(after.totalUsd).toBeCloseTo(0.000002 * 1_000_000 + 0.000002 * 1_000_000, 6); // 2.0 + 2.0
    expect(after.totalUsd).toBeGreaterThan(before.totalUsd);

    const corrected = db.prepare('SELECT source FROM price_versions WHERE id = ?').get(id) as { source: string };
    expect(corrected.source).toBe('manual-correction');
  });

  it('adding a genuinely NEW price version leaves historical figures before its effective_from untouched', () => {
    addPriceVersion(db, {
      provider: 'testco', model: 'test-model2', tier: 'standard', effectiveFrom: 0, effectiveTo: null,
      inputRate: 0.000001, outputRate: 0.000001, cacheReadMultiplier: 1, cacheWriteMultiplier: 1,
    });
    recordCostEvent(db, baseInput({
      provider: 'testco', model: 'test-model2', inputTokens: 1_000_000, outputTokens: 0,
      capturedAtMs: Date.parse('2026-01-01T00:00:00.000Z'),
    }));

    const before = costReport(db, { workflowStateWindows: [] });
    expect(before.totalUsd).toBeCloseTo(1.0, 6);

    // A REAL price change, effective from 2026-06-01 onward — the January
    // event predates it and must be unaffected.
    addPriceVersion(db, {
      provider: 'testco', model: 'test-model2', tier: 'standard',
      effectiveFrom: Date.parse('2026-06-01T00:00:00.000Z'), effectiveTo: null,
      inputRate: 0.00005, outputRate: 0.00005, cacheReadMultiplier: 1, cacheWriteMultiplier: 1,
    });
    const after = costReport(db, { workflowStateWindows: [] });
    expect(after.totalUsd).toBeCloseTo(1.0, 6); // unchanged — Jan event still prices at the old rate
  });
});

describe('costReport — AC-3 (unknown usage) / AC-4 (unpriced) / AC-8 (cache + truncated)', () => {
  let db: DB;
  beforeEach(() => { db = makeDb(); });

  it('AC-3: a row with both token counts absent is excluded from totals and counted as unknown-usage, never $0', () => {
    recordCostEvent(db, baseInput({ inputTokens: null, outputTokens: null }));
    const report = costReport(db, { workflowStateWindows: [] });
    expect(report.unknownUsageCount).toBe(1);
    expect(report.totalUsd).toBe(0);
    expect(report.rows[0]!.status).toBe('unknown-usage');
  });

  it('AC-4: an unpriced model is named, excluded from totals, and never priced at zero or a guessed default', () => {
    recordCostEvent(db, baseInput({ model: 'totally-unknown-model-xyz', inputTokens: 100, outputTokens: 100 }));
    const report = costReport(db, { workflowStateWindows: [] });
    expect(report.unpricedModels['totally-unknown-model-xyz']).toBe(1);
    expect(report.totalUsd).toBe(0);
    expect(report.rows[0]!.status).toBe('unpriced');
    expect(report.rows[0]!.totalCostUsd).toBeNull();
  });

  it('AC-8: cache read and cache write are distinct line items, never summed into one number', () => {
    recordCostEvent(db, baseInput({
      model: 'claude-sonnet-5', inputTokens: 1000, outputTokens: 500,
      cacheReadInputTokens: 2000, cacheCreationInputTokens: 300,
    }));
    const report = costReport(db, { workflowStateWindows: [] });
    expect(report.cache.readCostUsd).toBeGreaterThan(0);
    expect(report.cache.writeCostUsd).toBeGreaterThan(0);
    // Anthropic seed: read multiplier 0.1, write multiplier 1.25, input rate 0.000002.
    expect(report.cache.readCostUsd).toBeCloseTo(2000 * 0.000002 * 0.1, 8);
    expect(report.cache.writeCostUsd).toBeCloseTo(300 * 0.000002 * 1.25, 8);
  });

  it('AC-8: cache-hit ratio derives from cache-read vs non-cache-input tokens; null when no cache data exists at all', () => {
    const noCache = costReport(db, { workflowStateWindows: [] });
    expect(noCache.cache.hitRatio).toBeNull();

    recordCostEvent(db, baseInput({ inputTokens: 100, cacheReadInputTokens: 900, cacheCreationInputTokens: 0 }));
    const withCache = costReport(db, { workflowStateWindows: [] });
    expect(withCache.cache.hitRatio).toBeCloseTo(900 / (900 + 100), 6);
  });

  it('AC-8: a row with stop_reason max_tokens/length is counted as a truncated reply', () => {
    recordCostEvent(db, baseInput({ stopReason: 'max_tokens', truncated: true }));
    recordCostEvent(db, baseInput({ inputTokens: 1, stopReason: 'end_turn', truncated: false }));
    const report = costReport(db, { workflowStateWindows: [] });
    expect(report.truncatedCount).toBe(1);
  });
});

describe('costReport — AC-7 slice attribution buckets', () => {
  let db: DB;
  beforeEach(() => { db = makeDb(); });

  const windows: WorkflowStateWindow[] = [
    { sliceId: 'SLICE-441', startedAtMs: Date.parse('2026-08-01T10:00:00Z'), endedAtMs: Date.parse('2026-08-01T11:00:00Z') },
  ];
  const overlapping: WorkflowStateWindow[] = [
    { sliceId: 'SLICE-441', startedAtMs: Date.parse('2026-08-01T10:00:00Z'), endedAtMs: Date.parse('2026-08-01T11:00:00Z') },
    { sliceId: 'SLICE-442', startedAtMs: Date.parse('2026-08-01T10:30:00Z'), endedAtMs: Date.parse('2026-08-01T11:30:00Z') },
  ];

  it('exactly one window contains captured_at -> attributed to that slice', () => {
    recordCostEvent(db, baseInput({ capturedAtMs: Date.parse('2026-08-01T10:30:00Z') }));
    const report = costReport(db, { workflowStateWindows: windows });
    expect(report.rows[0]!.sliceBucket).toBe('slice');
    expect(report.rows[0]!.sliceId).toBe('SLICE-441');
    expect(report.bySlice['SLICE-441']).toBeDefined();
  });

  it('zero windows contain captured_at -> unattributed, still summed into totals', () => {
    recordCostEvent(db, baseInput({ capturedAtMs: Date.parse('2026-01-01T00:00:00Z') }));
    const report = costReport(db, { workflowStateWindows: windows });
    expect(report.rows[0]!.sliceBucket).toBe('unattributed');
    expect(report.bySlice['unattributed']).toBeDefined();
    expect(report.bySlice['unattributed']!.usd).toBeCloseTo(report.totalUsd, 8);
  });

  it('more than one window contains captured_at -> ambiguous (N candidates), never guessed, still summed into totals', () => {
    recordCostEvent(db, baseInput({ capturedAtMs: Date.parse('2026-08-01T10:45:00Z') }));
    const report = costReport(db, { workflowStateWindows: overlapping });
    expect(report.rows[0]!.sliceBucket).toBe('ambiguous');
    expect(report.rows[0]!.ambiguousCandidates).toBe(2);
    expect(report.bySlice['ambiguous (2 candidates)']).toBeDefined();
  });
});

describe('costReport — agent role reporting (proxy-only capture marked explicitly)', () => {
  it('a proxy-sourced row with agent_role null is reported under "role unknown (proxy-only capture)", never silently omitted', () => {
    const db = makeDb();
    recordCostEvent(db, baseInput({ source: 'proxy', agentRole: null }));
    const report = costReport(db, { workflowStateWindows: [] });
    expect(report.byAgentRole['role unknown (proxy-only capture)']).toBeDefined();
  });

  it('an otel-sourced row with a real agent.name is grouped under that role', () => {
    const db = makeDb();
    recordCostEvent(db, baseInput({ source: 'otel', agentRole: 'builder', sessionKey: 'real-session-1' }));
    const report = costReport(db, { workflowStateWindows: [] });
    expect(report.byAgentRole['builder']).toBeDefined();
  });
});

describe('costReport — long-context named-gap warning', () => {
  it('flags (never excludes) a turn whose input tokens hit the long-context threshold', () => {
    const db = makeDb();
    recordCostEvent(db, baseInput({ inputTokens: 250_000, outputTokens: 100 }));
    const report = costReport(db, { workflowStateWindows: [] });
    expect(report.longContextWarningCount).toBe(1);
    expect(report.rows[0]!.status).toBe('priced'); // still priced, just flagged
    expect(report.rows[0]!.longContextWarning).toBe(true);
  });
});
