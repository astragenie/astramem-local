/**
 * tests/distill/cost-cap.test.ts
 *
 * Opt-in distill compact()+extract() cost cap (`config.distill.costCap`,
 * `src/distill/cost-cap.ts`). Mirrors the coverage shape of
 * `consolidation.contradictionDetection`'s maxPerRun/maxWallClockMs tests
 * (tests/consolidate/consolidate.test.ts) for the sibling cap this reuses
 * the shape of.
 *
 * Two things this suite must prove:
 *  1. ENABLED path: call-count cap and wall-clock cap each stop further
 *     compact()/extract() LLM calls, gracefully (no thrown error, no failed
 *     job) — remaining chunks simply contribute nothing.
 *  2. DISABLED path (the shipped beta default) is a byte-identical no-op —
 *     no call is counted, no chunk is skipped, results are unchanged from
 *     never having a tracker at all.
 */
import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { DistillCostCapTracker, resolveDistillCostCap } from '../../src/distill/cost-cap.js';
import { compact, compactChunk } from '../../src/distill/stages/04-compact.js';
import { extract, extractChunk } from '../../src/distill/stages/05-extract.js';
import { BudgetTracker } from '../../src/budget/tracker.js';
import { defaultConfig, type Config } from '../../src/config/config.js';
import type { LLMProvider, ChatMsg, ChatOpts, ChatResult, LLMHealth } from '../../src/contracts/index.js';

function makeCountingLLM(text: string): { llm: LLMProvider; callCount: () => number } {
  let calls = 0;
  const llm: LLMProvider = {
    name: 'ollama' as const,
    model: 'test-model',
    async chat(_msgs: ChatMsg[], _opts?: ChatOpts): Promise<ChatResult> {
      calls++;
      return { text, usage: { in: 10, out: 5, usd: 0 } };
    },
    async health(): Promise<LLMHealth> {
      return { ok: true, model: 'test-model', latency_ms: 0 };
    },
  };
  return { llm, callCount: () => calls };
}

const VALID_EXTRACTION_JSON = JSON.stringify({
  atoms: [{ type: 'fact', text: 'port 7777 is the default daemon port', importance: 0.6, confidence: 0.9 }],
});

describe('resolveDistillCostCap', () => {
  it('resolves to disabled when config.distill.costCap is undefined', () => {
    const cfg = { ...defaultConfig(), distill: { ...defaultConfig().distill, costCap: undefined } } as Config;
    expect(resolveDistillCostCap(cfg)).toEqual({ enabled: false });
  });

  it('resolves to disabled for the shipped default (enabled: false)', () => {
    expect(resolveDistillCostCap(defaultConfig())).toEqual({ enabled: false });
  });

  it('resolves an explicit opt-in with limits', () => {
    const cfg = {
      ...defaultConfig(),
      distill: { ...defaultConfig().distill, costCap: { enabled: true, maxCallsPerJob: 5, maxWallClockMs: 1000 } },
    } as Config;
    expect(resolveDistillCostCap(cfg)).toEqual({ enabled: true, maxCallsPerJob: 5, maxWallClockMs: 1000 });
  });

  it('treats enabled: true with no limits as enabled but unbounded (never trips)', () => {
    const cfg = {
      ...defaultConfig(),
      distill: { ...defaultConfig().distill, costCap: { enabled: true } },
    } as Config;
    expect(resolveDistillCostCap(cfg)).toEqual({ enabled: true, maxCallsPerJob: undefined, maxWallClockMs: undefined });
  });
});

describe('DistillCostCapTracker — disabled (pure no-op)', () => {
  it('shouldStop() is always false and recordCall() keeps no counter when disabled', () => {
    const tracker = new DistillCostCapTracker({ enabled: false }, () => {});
    expect(tracker.shouldStop()).toBe(false);
    tracker.recordCall();
    tracker.recordCall();
    expect(tracker.shouldStop()).toBe(false);
    expect(tracker.state()).toEqual({ callsExecuted: 0, capReached: false, wallClockCapReached: false });
  });
});

describe('DistillCostCapTracker — enabled', () => {
  it('shouldStop() trips once maxCallsPerJob calls have been recorded', () => {
    const tracker = new DistillCostCapTracker({ enabled: true, maxCallsPerJob: 2 }, () => {});
    expect(tracker.shouldStop()).toBe(false);
    tracker.recordCall();
    expect(tracker.shouldStop()).toBe(false);
    tracker.recordCall();
    expect(tracker.shouldStop()).toBe(true);
    expect(tracker.state()).toEqual({ callsExecuted: 2, capReached: true, wallClockCapReached: false });
  });

  it('shouldStop() trips once maxWallClockMs has elapsed', async () => {
    const tracker = new DistillCostCapTracker({ enabled: true, maxWallClockMs: 20 }, () => {});
    expect(tracker.shouldStop()).toBe(false);
    await new Promise((r) => setTimeout(r, 30));
    expect(tracker.shouldStop()).toBe(true);
    expect(tracker.state().wallClockCapReached).toBe(true);
    expect(tracker.state().capReached).toBe(false);
  });

  it('logs the trip exactly once even across repeated shouldStop() checks', () => {
    const logged: string[] = [];
    const tracker = new DistillCostCapTracker({ enabled: true, maxCallsPerJob: 1 }, (m) => logged.push(m));
    tracker.recordCall();
    tracker.shouldStop();
    tracker.shouldStop();
    tracker.shouldStop();
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain('call-count');
  });

  it('enabled with no limits configured never trips', () => {
    const tracker = new DistillCostCapTracker({ enabled: true }, () => {});
    tracker.recordCall();
    tracker.recordCall();
    tracker.recordCall();
    expect(tracker.shouldStop()).toBe(false);
  });
});

describe('compactChunk / extractChunk — costCap integration', () => {
  it('compactChunk skips its LLM call and passes the chunk through raw once the cap has tripped', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const budget = new BudgetTracker(db);
    const { llm, callCount } = makeCountingLLM('compressed');
    const tracker = new DistillCostCapTracker({ enabled: true, maxCallsPerJob: 0 }, () => {});

    const result = await compactChunk({ index: 0, text: 'some content' }, llm, budget, 10.0, undefined, tracker);

    expect(result.text).toBe('');
    expect(callCount()).toBe(0);
  });

  it('extractChunk skips its LLM call and returns zero atoms once the cap has tripped', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const budget = new BudgetTracker(db);
    const { llm, callCount } = makeCountingLLM(VALID_EXTRACTION_JSON);
    const tracker = new DistillCostCapTracker({ enabled: true, maxCallsPerJob: 0 }, () => {});

    const result = await extractChunk(0, 'some chunk text', llm, budget, 10.0, 'engineering', undefined, undefined, tracker);

    expect(result.atoms).toEqual([]);
    expect(callCount()).toBe(0);
  });

  it('a disabled tracker never skips — compactChunk/extractChunk behave exactly as with no tracker at all', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const budget = new BudgetTracker(db);
    const disabled = new DistillCostCapTracker({ enabled: false }, () => {});

    const { llm: compactLlm, callCount: compactCalls } = makeCountingLLM('compressed');
    const withTracker = await compactChunk({ index: 0, text: 'content' }, compactLlm, budget, 10.0, undefined, disabled);
    expect(withTracker.text).toBe('compressed');
    expect(compactCalls()).toBe(1);

    const { llm: extractLlm, callCount: extractCalls } = makeCountingLLM(VALID_EXTRACTION_JSON);
    const extractResult = await extractChunk(0, 'chunk text', extractLlm, budget, 10.0, 'engineering', undefined, undefined, disabled);
    expect(extractResult.atoms).toHaveLength(1);
    expect(extractCalls()).toBe(1);
  });
});

describe('compact() / extract() — costCap stops dispatch across multiple chunks, gracefully', () => {
  it('compact(): only the first maxCallsPerJob chunks call the LLM; the rest pass through raw with no error', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const budget = new BudgetTracker(db);
    const { llm, callCount } = makeCountingLLM('compressed');
    const tracker = new DistillCostCapTracker({ enabled: true, maxCallsPerJob: 2 }, () => {});
    const chunks = [0, 1, 2, 3, 4].map((i) => ({ index: i, text: `chunk ${i}` }));

    const results = await compact(chunks, llm, budget, 10.0, 1, undefined, { costCap: tracker });

    expect(callCount()).toBe(2);
    expect(results.filter((r) => r.text === 'compressed')).toHaveLength(2);
    expect(results.filter((r) => r.text === '')).toHaveLength(3);
    expect(results).toHaveLength(5);
  });

  it('extract(): chunks beyond the cap contribute zero atoms instead of failing the job', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const budget = new BudgetTracker(db);
    const { llm, callCount } = makeCountingLLM(VALID_EXTRACTION_JSON);
    const tracker = new DistillCostCapTracker({ enabled: true, maxCallsPerJob: 1 }, () => {});
    const chunks = [0, 1, 2].map((i) => ({ index: i, text: `chunk ${i}` }));

    const results = await extract(chunks, llm, budget, 10.0, 'engineering', 1, undefined, undefined, tracker);

    expect(callCount()).toBe(1);
    expect(results.filter((r) => r.atoms.length > 0)).toHaveLength(1);
    expect(results.filter((r) => r.atoms.length === 0)).toHaveLength(2);
  });

  it('a SHARED tracker bounds compact()+extract() TOGETHER, matching maxCallsPerJob\'s "combined" semantics', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const budget = new BudgetTracker(db);
    const { llm: compactLlm, callCount: compactCalls } = makeCountingLLM('compressed');
    const { llm: extractLlm, callCount: extractCalls } = makeCountingLLM(VALID_EXTRACTION_JSON);
    const tracker = new DistillCostCapTracker({ enabled: true, maxCallsPerJob: 3 }, () => {});
    const chunks = [0, 1, 2, 3].map((i) => ({ index: i, text: `chunk ${i}` }));

    const compactResults = await compact(chunks, compactLlm, budget, 10.0, 1, undefined, { costCap: tracker });
    expect(compactCalls()).toBe(3); // all 3 of the shared budget spent in compact()

    const extractInput = compactResults.map((r) => ({ index: r.index, text: r.text || `chunk ${r.index}` }));
    const extractResults = await extract(
      extractInput, extractLlm, budget, 10.0, 'engineering', 1, undefined, undefined, tracker,
    );
    // No budget left — extract() makes zero LLM calls of its own.
    expect(extractCalls()).toBe(0);
    expect(extractResults.every((r) => r.atoms.length === 0)).toBe(true);
    expect(tracker.state()).toEqual({ callsExecuted: 3, capReached: true, wallClockCapReached: false });
  });

  it('disabled costCap in CompactOpts/extract() params never skips a chunk (byte-identical to omitting costCap entirely)', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const budget = new BudgetTracker(db);
    const { llm, callCount } = makeCountingLLM('compressed');
    const disabled = new DistillCostCapTracker({ enabled: false }, () => {});
    const chunks = [0, 1, 2].map((i) => ({ index: i, text: `chunk ${i}` }));

    const results = await compact(chunks, llm, budget, 10.0, 1, undefined, { costCap: disabled });

    expect(callCount()).toBe(3);
    expect(results.every((r) => r.text === 'compressed')).toBe(true);
  });
});
