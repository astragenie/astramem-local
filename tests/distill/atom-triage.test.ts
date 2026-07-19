import { describe, it, expect, vi } from 'vitest';
import {
  triageBatch,
  AtomTriageRunTracker,
  ATOM_TRIAGE_MARKER,
  CORRECTED_TYPE_LABELS,
  CORRECTED_TYPE_CONFIDENCE_GATE,
} from '../../src/distill/atom-triage.js';
import type { LLMProvider, ChatMsg, ChatOpts } from '../../src/contracts/llm.js';

function makeProvider(
  responder: (messages: ChatMsg[], opts?: ChatOpts) => string,
): LLMProvider {
  return {
    name: 'ollama',
    model: 'test-triage-model',
    async chat(messages, opts) {
      return { text: responder(messages, opts), usage: { in: 1, out: 1, usd: 0 } };
    },
    async health() {
      return { ok: true, model: 'test-triage-model', latency_ms: 0 };
    },
  };
}

function makeThrowingProvider(message: string): LLMProvider {
  return {
    name: 'ollama',
    model: 'test-triage-model',
    async chat() {
      throw new Error(message);
    },
    async health() {
      return { ok: true, model: 'test-triage-model', latency_ms: 0 };
    },
  };
}

describe('triageBatch', () => {
  it('returns an empty Map for an empty atom list without calling the provider', async () => {
    let called = false;
    const provider = makeProvider(() => {
      called = true;
      return JSON.stringify({ verdicts: [] });
    });
    const result = await triageBatch(provider, []);
    expect(result.size).toBe(0);
    expect(called).toBe(false);
  });

  it('parses a well-formed batch response into a Map keyed by index', async () => {
    const provider = makeProvider(() =>
      JSON.stringify({
        verdicts: [
          { index: 3, verdict: 'junk', confidence: 0.9 },
          { index: 7, verdict: 'keep', confidence: 0.5 },
        ],
      }),
    );
    const result = await triageBatch(provider, [
      { index: 3, text: 'query for topic X returned nothing' },
      { index: 7, text: 'the team chose PostgreSQL for ACID guarantees' },
    ]);
    expect(result.get(3)).toEqual({ index: 3, verdict: 'junk', confidence: 0.9 });
    expect(result.get(7)).toEqual({ index: 7, verdict: 'keep', confidence: 0.5 });
    expect(result.size).toBe(2);
  });

  it('embeds the stable marker in the system prompt so mock providers can route on it', async () => {
    let seenSystem = '';
    const provider = makeProvider((messages) => {
      seenSystem = messages.find((m) => m.role === 'system')?.content ?? '';
      return JSON.stringify({ verdicts: [] });
    });
    await triageBatch(provider, [{ index: 0, text: 'x' }]);
    expect(seenSystem).toContain(ATOM_TRIAGE_MARKER);
  });

  it('requests json + a schema hint', async () => {
    let seenOpts: ChatOpts | undefined;
    const provider = makeProvider((_messages, opts) => {
      seenOpts = opts;
      return JSON.stringify({ verdicts: [] });
    });
    await triageBatch(provider, [{ index: 0, text: 'x' }]);
    expect(seenOpts?.json).toBe(true);
    expect(seenOpts?.jsonSchema).toBeTruthy();
  });

  it('fails open (empty Map) when the response is not valid JSON at all, logging a warning — never throws', async () => {
    const log = vi.fn();
    const provider = makeProvider(() => 'not json at all');
    const result = await triageBatch(provider, [{ index: 0, text: 'x' }], { log });
    expect(result.size).toBe(0);
    // JSON.parse itself throws for non-JSON text, caught by the same
    // fail-open catch block a thrown/rejected chat() call hits below —
    // both surface as "batch call failed", not "unparsable batch response"
    // (that message is for well-formed JSON with the wrong shape — see the
    // next test).
    expect(log).toHaveBeenCalledWith(expect.stringContaining('batch call failed'));
  });

  it("fails open (empty Map) when the response is valid JSON but the wrong shape (no 'verdicts' array), logging a warning", async () => {
    const log = vi.fn();
    const provider = makeProvider(() => JSON.stringify({ foo: 'bar' }));
    const result = await triageBatch(provider, [{ index: 0, text: 'x' }], { log });
    expect(result.size).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('unparsable'));
  });

  it('fails open (empty Map) on a thrown/rejected chat() call, logging the provider error — never throws', async () => {
    const log = vi.fn();
    const provider = makeThrowingProvider('connection refused');
    const result = await triageBatch(provider, [{ index: 0, text: 'x' }], { log });
    expect(result.size).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('connection refused'));
  });

  it('a single malformed verdict entry is dropped without discarding the rest of the batch', async () => {
    const provider = makeProvider(() =>
      JSON.stringify({
        verdicts: [
          { index: 0, verdict: 'not-a-real-label', confidence: 0.9 }, // invalid enum
          { index: 1, verdict: 'keep', confidence: 0.5 }, // valid
          { index: 2, verdict: 'junk', confidence: 2.0 }, // confidence out of [0,1]
        ],
      }),
    );
    const result = await triageBatch(provider, [
      { index: 0, text: 'a' },
      { index: 1, text: 'b' },
      { index: 2, text: 'c' },
    ]);
    expect(result.has(0)).toBe(false);
    expect(result.get(1)).toEqual({ index: 1, verdict: 'keep', confidence: 0.5 });
    expect(result.has(2)).toBe(false);
  });
});

// ─── FEAT-547: atom-triage v2 — corrected_type / evidence_supported ─────────

describe('triageBatch — FEAT-547 v2 multi-verdict', () => {
  it('CORRECTED_TYPE_CONFIDENCE_GATE is exported as a named constant (AC-2)', () => {
    expect(CORRECTED_TYPE_CONFIDENCE_GATE).toBe(0.8);
  });

  it('parses corrected_type + evidence_supported when the provider supplies both (AC-1)', async () => {
    const provider = makeProvider(() =>
      JSON.stringify({
        verdicts: [
          { index: 0, verdict: 'keep', confidence: 0.9, corrected_type: 'event', evidence_supported: true },
        ],
      }),
    );
    const result = await triageBatch(provider, [{ index: 0, text: 'the deadline moved to Friday', evidence: 'moved to Friday' }]);
    expect(result.get(0)).toEqual({
      index: 0, verdict: 'keep', confidence: 0.9, corrected_type: 'event', evidence_supported: true,
    });
  });

  it('a response omitting BOTH optional fields parses successfully with them left undefined — backward-compatible (AC-1)', async () => {
    const provider = makeProvider(() =>
      JSON.stringify({ verdicts: [{ index: 0, verdict: 'keep', confidence: 0.5 }] }),
    );
    const result = await triageBatch(provider, [{ index: 0, text: 'x' }]);
    const verdict = result.get(0);
    expect(verdict).toEqual({ index: 0, verdict: 'keep', confidence: 0.5 });
    expect(verdict?.corrected_type).toBeUndefined();
    expect(verdict?.evidence_supported).toBeUndefined();
  });

  it('a verdict entry with an invalid corrected_type label is dropped on its own — sibling entries still land (AC-6)', async () => {
    const provider = makeProvider(() =>
      JSON.stringify({
        verdicts: [
          { index: 0, verdict: 'keep', confidence: 0.9, corrected_type: 'not-a-real-type' }, // invalid enum
          { index: 1, verdict: 'keep', confidence: 0.9, corrected_type: 'fact' }, // valid
        ],
      }),
    );
    const result = await triageBatch(provider, [
      { index: 0, text: 'a' },
      { index: 1, text: 'b' },
    ]);
    expect(result.has(0)).toBe(false);
    expect(result.get(1)).toEqual({ index: 1, verdict: 'keep', confidence: 0.9, corrected_type: 'fact' });
  });

  it('a verdict entry with a non-boolean evidence_supported is dropped on its own — sibling entries still land (AC-6)', async () => {
    const provider = makeProvider(() =>
      JSON.stringify({
        verdicts: [
          { index: 0, verdict: 'keep', confidence: 0.9, evidence_supported: 'yes' }, // wrong type
          { index: 1, verdict: 'keep', confidence: 0.9, evidence_supported: false }, // valid
        ],
      }),
    );
    const result = await triageBatch(provider, [
      { index: 0, text: 'a', evidence: 'q1' },
      { index: 1, text: 'b', evidence: 'q2' },
    ]);
    expect(result.has(0)).toBe(false);
    expect(result.get(1)).toEqual({ index: 1, verdict: 'keep', confidence: 0.9, evidence_supported: false });
  });

  it('CORRECTED_TYPE_LABELS is the closed 7-class atom-type taxonomy, not the wider 10-value MEMORY_TYPES union', () => {
    expect(CORRECTED_TYPE_LABELS).toEqual(['decision', 'fact', 'lesson', 'command', 'todo', 'note', 'event']);
  });

  it('an atom with an evidence quote shows it inline in the user content; an atom with none omits the suffix entirely', async () => {
    let seenUser = '';
    const provider = makeProvider((messages) => {
      seenUser = messages.find((m) => m.role === 'user')?.content ?? '';
      return JSON.stringify({ verdicts: [] });
    });
    await triageBatch(provider, [
      { index: 0, text: 'has evidence', evidence: 'the quote' },
      { index: 1, text: 'no evidence' },
    ]);
    expect(seenUser).toContain('[0] has evidence [evidence: "the quote"]');
    expect(seenUser).toContain('[1] no evidence');
    expect(seenUser).not.toContain('[1] no evidence [evidence:');
  });
});

describe('AtomTriageRunTracker', () => {
  it('shouldStop() is false until maxPerRun calls are recorded', () => {
    const tracker = new AtomTriageRunTracker({ maxPerRun: 2, maxWallClockMs: 60_000 }, () => {});
    expect(tracker.shouldStop()).toBe(false);
    tracker.recordCall();
    expect(tracker.shouldStop()).toBe(false);
    tracker.recordCall();
    expect(tracker.shouldStop()).toBe(true);
    expect(tracker.state().capReached).toBe(true);
    expect(tracker.state().wallClockCapReached).toBe(false);
  });

  it('shouldStop() trips on wall-clock elapsed, logged exactly once', () => {
    const log = vi.fn();
    const tracker = new AtomTriageRunTracker({ maxPerRun: 1000, maxWallClockMs: 0 }, log);
    expect(tracker.shouldStop()).toBe(true);
    expect(tracker.shouldStop()).toBe(true);
    expect(tracker.state().wallClockCapReached).toBe(true);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![0]).toContain('wall-clock');
  });
});
