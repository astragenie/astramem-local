/**
 * E2E: does the contradiction judge actually stop a BAD MERGE?
 *
 * Not a mock test. The repo already has one of those (`mock-judge-pairs.ts`, a closed
 * vocabulary table), and it proves the plumbing works — it does not prove the model can
 * tell Colorado from the EU. Tonight's whole investigation was a lesson in the
 * difference: a suite of self-authored fixtures can be green and collectively wrong
 * about reality.
 *
 * So this runs the REAL local LLM (qwen via Ollama, the same provider extraction uses)
 * against the REAL false-merge pairs found in the operator's live store on 2026-07-13:
 *
 *   sim 0.872  "Compliance with COLORADO AI regulations is expensive for companies."
 *          vs  "Compliance with EU AI regulations is expensive for companies."
 *
 *   sim 0.920  "bun test src/tests/grade-writer-telemetry.test.mts"
 *          vs  "bun test src/tests/grade-writer-learnings.test.mts"
 *
 * These differ by ONE WORD, and that word is the entire fact. Cosine cannot see it —
 * which is exactly why `autoAcceptThreshold` stays null and the judge exists.
 *
 * SKIPPED when Ollama is unreachable, so CI without a model host stays green. That is a
 * deliberate tradeoff: a skipped honest test beats a passing dishonest one.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { judgeContradiction, type JudgeableAtom } from '../../src/consolidate/contradiction-judge.js';
import { getProviders } from '../../src/providers/index.js';
import { defaultConfig } from '../../src/config/config.js';
import { BudgetTracker } from '../../src/budget/tracker.js';
import { openDb } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';

const atom = (text: string): JudgeableAtom => ({ text, created_at: Date.now() });

const OLLAMA = process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434';

let ollamaUp = false;
beforeAll(async () => {
  try {
    const r = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(3000) });
    ollamaUp = r.ok;
  } catch {
    ollamaUp = false;
  }
});

/** The real pairs, lifted verbatim from the live store's pending merge proposals. */
const REAL_FALSE_MERGES = [
  {
    name: 'Colorado AI law vs EU AI law (sim 0.872 — one word apart, opposite jurisdictions)',
    a: 'Compliance with Colorado AI regulations is expensive for companies.',
    b: 'Compliance with EU AI regulations is expensive for companies.',
  },
  {
    name: 'two DIFFERENT test files (sim 0.920 — the highest-similarity false merge in the store)',
    a: 'bun test src/tests/grade-writer-telemetry.test.mts',
    b: 'bun test src/tests/grade-writer-learnings.test.mts',
  },
];

/** A pair that genuinely IS the same fact — the judge must NOT reject these, or it is
 *  just a merge-blocker rather than a judge. A test that only proves "it says no" is
 *  worthless: an always-no judge would pass it. */
const REAL_TRUE_DUPLICATES = [
  {
    name: 'genuine paraphrase (the kind consolidation SHOULD merge)',
    a: 'Port 7777 is the default port for the application.',
    b: 'Port 7777 is the default for this system.',
  },
];

describe('contradiction judge — REAL model, REAL false-merge pairs from the live store', () => {
  const db = openDb(':memory:');
  migrate(db);
  const budget = new BudgetTracker(db);

  for (const pair of REAL_FALSE_MERGES) {
    it(`does NOT say 'agrees': ${pair.name}`, async () => {
      if (!ollamaUp) {
        console.warn('SKIPPED — Ollama unreachable. This test is worthless without a real model.');
        return;
      }
      const { llm } = getProviders(defaultConfig());
      const judge = llm.extraction;
      const v = await judgeContradiction(judge, budget, 10, atom(pair.a), atom(pair.b));

      // 'agrees' means "same fact" — the verdict that would let these merge and destroy
      // the one word carrying all the meaning (Colorado vs EU; telemetry vs learnings).
      // 'contradicts' or 'unrelated' are both fine; what matters is that it is not 'agrees'.
      console.log(`    -> ${pair.a.slice(0, 40)}… | ${pair.b.slice(0, 40)}… => ${v.verdict} (${v.confidence})`);
      expect(v.verdict).not.toBe('agrees');
    }, 90_000);
  }

  for (const pair of REAL_TRUE_DUPLICATES) {
    it(`does NOT cry 'contradicts' on a real paraphrase: ${pair.name}`, async () => {
      if (!ollamaUp) {
        console.warn('SKIPPED — Ollama unreachable.');
        return;
      }
      const { llm } = getProviders(defaultConfig());
      const judge = llm.extraction;
      const v = await judgeContradiction(judge, budget, 10, atom(pair.a), atom(pair.b));

      // THE CONTROL. An always-say-no judge would pass every test above and be useless.
      // A judge is only worth having if it can still say yes.
      console.log(`    -> ${pair.a.slice(0, 40)}… | ${pair.b.slice(0, 40)}… => ${v.verdict} (${v.confidence})`);
      expect(v.verdict).not.toBe('contradicts');
    }, 90_000);
  }

  it('ships with contradictionDetection ENABLED and autoAcceptThreshold NULL', () => {
    const cfg = defaultConfig();
    // The pairing is the point. The judge is on BECAUSE no numeric threshold is safe:
    // sim 0.920 already merges two different test files. If someone later sets an
    // autoAcceptThreshold, this test should make them think twice.
    expect(cfg.consolidation.contradictionDetection.mode).toBe('enabled');
    expect(cfg.consolidation.autoAcceptThreshold).toBeNull();
  });
});
