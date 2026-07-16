/**
 * Stage 4 was shredding personal conversations with a coding-agent compressor.
 *
 * The conversational EXTRACTION profile shipped. A conversational COMPACTION
 * profile never did. So every conversational transcript was compressed by a
 * prompt whose entire PRESERVE list is "file paths, commands, error messages,
 * stderr" — none of which exist in a chat between two people — and whose REMOVE
 * list ("thinking-out-loud", "acknowledgment phrases", "false starts") describes
 * most of what a personal conversation IS.
 *
 * MEASURED on five real turns. Compaction deleted, before extraction ever ran:
 *   - Alice          (a named person, mentioned in passing)
 *   - the sister     (a relationship)
 *   - Portland       (a place)
 *   - the move       (a life event)
 *   - summer camp in June (a dated plan)
 *   - EVERY SPEAKER NAME
 *
 * That last one is fatal by construction: the extraction prompt REQUIRES every
 * fact be attributed to a named person and forbids "she started her new job".
 * Compaction had already deleted the names, so extraction could only drop the
 * atom or GUESS — and it guessed wrong.
 *
 * Nothing errored. Fewer atoms is not a failure. The compactor "succeeded" on
 * every call. (ADR-015: success and failure indistinguishable.)
 *
 * The ROOT CAUSE was an ordering bug: pipeline.ts resolved the profile AFTER the
 * compact() call. The profile could not reach stage 4 even in principle.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  compact,
  compactSystemPrompt,
  shouldCompact,
  compactionDecisionFor,
  chunkAlreadyFits,
  COMPACTION_FITS_THRESHOLD_CHARS,
  type CompactResult,
} from '../../src/distill/stages/04-compact.js';
import { BudgetTracker } from '../../src/budget/tracker.js';
import { openDb } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import type { Chunk } from '../../src/distill/stages/03-chunk.js';
import type { LLMProvider } from '../../src/contracts/index.js';

// Small: well BELOW COMPACTION_FITS_THRESHOLD_CHARS (800) — used everywhere
// size is irrelevant (categorical mode/profile skip, or the size gate itself
// under test) or to prove mode:'always' overrides the size heuristic too.
const chunks: Chunk[] = [
  { index: 0, text: 'Caroline: I went to the LGBTQ support group on May 7.\nMelanie: Tell Alice I said hi.' },
  { index: 1, text: 'Melanie: My kids are excited for summer camp in June.' },
];

// Large: comfortably ABOVE COMPACTION_FITS_THRESHOLD_CHARS (800) — #284 Bug 2
// requires "keep it conservative", so the oversized fixture used to prove
// engineering-under-auto still compacts is sized with real headroom (~1200
// chars, 1.5x the threshold), not a hair's-breadth over it.
const LARGE_FILLER =
  'Caroline: I went to the LGBTQ support group on May 7 and it was a really meaningful afternoon spent listening to other people share their stories. ';
const largeChunks: Chunk[] = [
  { index: 0, text: LARGE_FILLER.repeat(8) },
  { index: 1, text: LARGE_FILLER.repeat(8) },
];

/** BudgetTracker needs a real DB — only the COMPACTING paths reach it (the skip
 *  path never checks a budget, because it never spends anything). */
function realBudget(): BudgetTracker {
  const db = openDb(':memory:');
  migrate(db);
  return new BudgetTracker(db);
}

function fakeProvider(): LLMProvider & { calls: number; lastSystem: string } {
  const p = {
    calls: 0,
    lastSystem: '',
    name: 'fake',
    model: 'fake',
    async chat(messages: Array<{ role: string; content: string }>) {
      p.calls++;
      p.lastSystem = messages[0]?.content ?? '';
      return { text: 'COMPRESSED', usage: { usd: 0 } };
    },
  } as unknown as LLMProvider & { calls: number; lastSystem: string };
  return p;
}

describe('compactSystemPrompt — the conversational half that never shipped', () => {
  it('uses the CODING-AGENT compressor for engineering (unchanged)', () => {
    const p = compactSystemPrompt('engineering');
    expect(p).toMatch(/AI coding agent sessions/);
    expect(p).toMatch(/file paths and commands/);
  });

  it('uses a FACT-SURVIVAL prompt for conversational — not a summarizer', () => {
    const p = compactSystemPrompt('conversational');
    expect(p).toMatch(/Your job is NOT to summarize/i);
    expect(p).not.toMatch(/AI coding agent sessions/);
  });

  it('the conversational prompt DEMANDS speaker labels survive', () => {
    // This is the one that broke everything. Extraction is required to attribute
    // every fact to a named person; it CANNOT recover a name compaction deleted.
    const p = compactSystemPrompt('conversational');
    expect(p).toMatch(/EVERY SPEAKER LABEL/i);
    expect(p).toMatch(/CANNOT recover a name you deleted/i);
  });

  it('the conversational prompt protects PASSING mentions — "tell Alice I said hi"', () => {
    // A passing mention is a durable fact. The engineering compressor treated it
    // as an acknowledgment phrase and deleted it.
    const p = compactSystemPrompt('conversational');
    expect(p).toMatch(/only mentioned in passing/i);
    expect(p).toMatch(/A passing mention IS a durable fact/i);
  });

  it('the conversational prompt biases toward KEEPING — under-keeping is irreversible', () => {
    const p = compactSystemPrompt('conversational');
    expect(p).toMatch(/WHEN IN DOUBT, KEEP THE LINE/i);
    expect(p).toMatch(/under-keeping is irreversible/i);
  });

  it('defaults to engineering when the profile is absent (byte-identical pre-fix behavior)', () => {
    expect(compactSystemPrompt(undefined)).toBe(compactSystemPrompt('engineering'));
    expect(compactSystemPrompt(null)).toBe(compactSystemPrompt('engineering'));
  });
});

describe('shouldCompact — compaction is a BANDWIDTH optimisation, and locally there is no bandwidth', () => {
  // Stage 3 already caps chunks at MAX_CHUNK_CHARS (3200, ~800 tokens) against an
  // extraction num_ctx sized up to 16384. Compaction saves a few hundred tokens
  // out of a budget 20x larger — while costing ONE LLM CALL PER CHUNK and, on
  // conversational content, destroying facts.
  it('auto: SKIPS for conversational', () => {
    expect(shouldCompact({ profile: 'conversational', mode: 'auto' })).toBe(false);
  });

  it('auto: RUNS for engineering (real redundancy: repeated tool output, false starts)', () => {
    expect(shouldCompact({ profile: 'engineering', mode: 'auto' })).toBe(true);
  });

  it('auto is the default, and an absent profile still compacts (pre-fix behavior preserved)', () => {
    expect(shouldCompact()).toBe(true);
    expect(shouldCompact({})).toBe(true);
  });

  it('never: skips even for engineering', () => {
    expect(shouldCompact({ profile: 'engineering', mode: 'never' })).toBe(false);
  });

  it('always: runs even for conversational (escape hatch back to pre-fix behavior)', () => {
    expect(shouldCompact({ profile: 'conversational', mode: 'always' })).toBe(true);
  });
});

describe('compact() — the skip path makes ZERO LLM calls and passes the raw chunk through', () => {
  it('conversational: no provider call at all, empty text => pipeline falls back to the RAW chunk', async () => {
    const provider = fakeProvider();
    const budget = realBudget();

    const out: CompactResult[] = await compact(
      chunks, provider, budget, 1, 1, undefined,
      { profile: 'conversational', mode: 'auto' },
    );

    // THE POINT: not one LLM call. A 17-chunk session used to pay 17 of these.
    expect(provider.calls).toBe(0);

    // Empty text is not a bug — pipeline.ts already does
    // `r.text || chunks[r.index]?.text`, so extraction reads the ORIGINAL chunk
    // with every speaker label and passing mention intact. The passthrough path
    // already existed; it was simply never reachable.
    expect(out.map(r => r.text)).toEqual(['', '']);
    expect(out.map(r => r.index)).toEqual([0, 1]);
  });

  it('engineering: still calls the provider, with the CODING-AGENT prompt (oversized chunks, unaffected by the #284 Bug 2 size gate)', async () => {
    const provider = fakeProvider();
    const budget = realBudget();

    await compact(largeChunks, provider, budget, 1, 1, undefined, { profile: 'engineering', mode: 'auto' });

    expect(provider.calls).toBe(2);
    expect(provider.lastSystem).toMatch(/AI coding agent sessions/);
  });

  it('mode:always on conversational uses the CONVERSATIONAL prompt, not the engineering one', async () => {
    // If someone forces compaction on for a conversation, they must at least get
    // the prompt that does not shred it.
    const provider = fakeProvider();
    const budget = realBudget();

    await compact(chunks, provider, budget, 1, 1, undefined, { profile: 'conversational', mode: 'always' });

    expect(provider.calls).toBe(2);
    expect(provider.lastSystem).toMatch(/Your job is NOT to summarize/i);
    expect(provider.lastSystem).not.toMatch(/AI coding agent sessions/);
  });

  it('no opts at all: byte-identical to pre-fix behavior (compacts, engineering prompt; oversized chunks so #284 Bug 2 does not interfere)', async () => {
    const provider = fakeProvider();
    const budget = realBudget();

    await compact(largeChunks, provider, budget, 1);

    expect(provider.calls).toBe(2);
    expect(provider.lastSystem).toMatch(/AI coding agent sessions/);
  });
});

describe('compactionDecisionFor — #284 Bug 2: the SIZE half of the gate', () => {
  // Precedence: mode 'never' beats everything; mode 'always' beats both the
  // profile gate and the size gate; only under 'auto' does profile apply,
  // and only then size.
  it('mode:never skips regardless of profile or size, reason mode-never', () => {
    expect(compactionDecisionFor('tiny', { profile: 'engineering', mode: 'never' }))
      .toEqual({ compact: false, skipReason: 'mode-never' });
    expect(compactionDecisionFor(LARGE_FILLER.repeat(8), { profile: 'engineering', mode: 'never' }))
      .toEqual({ compact: false, skipReason: 'mode-never' });
  });

  it('mode:always compacts regardless of profile or size — no skipReason', () => {
    expect(compactionDecisionFor('tiny', { profile: 'conversational', mode: 'always' }))
      .toEqual({ compact: true });
  });

  it('auto + conversational skips on PROFILE even when the chunk is oversized (profile beats size)', () => {
    expect(compactionDecisionFor(LARGE_FILLER.repeat(8), { profile: 'conversational', mode: 'auto' }))
      .toEqual({ compact: false, skipReason: 'profile' });
  });

  it('auto + engineering + a chunk that already fits: skips on SIZE', () => {
    expect(compactionDecisionFor('short chunk', { profile: 'engineering', mode: 'auto' }))
      .toEqual({ compact: false, skipReason: 'size' });
  });

  it('auto + engineering + an oversized chunk: compacts (unchanged)', () => {
    expect(compactionDecisionFor(LARGE_FILLER.repeat(8), { profile: 'engineering', mode: 'auto' }))
      .toEqual({ compact: true });
  });

  it('chunkAlreadyFits / COMPACTION_FITS_THRESHOLD_CHARS agree at the boundary', () => {
    const atThreshold = 'x'.repeat(COMPACTION_FITS_THRESHOLD_CHARS);
    const overThreshold = 'x'.repeat(COMPACTION_FITS_THRESHOLD_CHARS + 1);
    expect(chunkAlreadyFits(atThreshold)).toBe(true); // <= threshold still fits (headroom, not hair-trigger)
    expect(chunkAlreadyFits(overThreshold)).toBe(false);
  });
});

describe('compact() — #284 Bug 2 size gate, end to end', () => {
  it('auto + engineering + chunk that already fits: SKIPPED, zero LLM calls', async () => {
    const provider = fakeProvider();
    const budget = realBudget();

    // Both fixture chunks are well under COMPACTION_FITS_THRESHOLD_CHARS.
    const out = await compact(chunks, provider, budget, 1, 1, undefined, { profile: 'engineering', mode: 'auto' });

    expect(provider.calls).toBe(0);
    expect(out.map(r => r.text)).toEqual(['', '']);
  });

  it('auto + engineering + oversized chunk: still compacts (unchanged from pre-#284-Bug-2 behavior)', async () => {
    const provider = fakeProvider();
    const budget = realBudget();

    await compact(largeChunks, provider, budget, 1, 1, undefined, { profile: 'engineering', mode: 'auto' });

    expect(provider.calls).toBe(2);
  });

  it('mode:always + a small chunk: still compacts — operator override beats the size heuristic', async () => {
    const provider = fakeProvider();
    const budget = realBudget();

    // Same tiny fixture that size-skips under 'auto' — 'always' must ignore that.
    const out = await compact(chunks, provider, budget, 1, 1, undefined, { profile: 'engineering', mode: 'always' });

    expect(provider.calls).toBe(2);
    expect(out.every(r => r.text === 'COMPRESSED')).toBe(true);
  });
});
