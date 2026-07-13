/**
 * FEAT-456 SLICE-1 AC-8: accuracy regression floor for the contradiction
 * judge's mock branch. contracts/fixtures/eval/contradiction-judge-pairs.json
 * is a CLOSED, deterministic labeled pair-set (mirrored in
 * src/consolidate/mock-judge-pairs.ts, kept in lockstep by
 * tests/hygiene/mock-judge-vocab-fixture-lockstep.test.ts) — every pair run
 * through `judgeContradiction()` with the mock provider must return exactly
 * its labeled verdict, so this is a hard 100% floor, not a statistical one.
 *
 * A real-provider accuracy eval against this same labeled set (measuring an
 * actual Ollama-backed judge, not the mock) is a natural v1.x follow-up once
 * a non-mock judge is exercised in CI (design §3.3) — out of scope here
 * since CI has no live Ollama.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { judgeContradiction } from '../../src/consolidate/contradiction-judge.js';
import { makeMockProviders } from '../../src/pipeline/mock-providers.js';
import { BudgetTracker } from '../../src/budget/tracker.js';
import { openDb } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';

const FIXTURE_PATH = join(process.cwd(), 'contracts', 'fixtures', 'eval', 'contradiction-judge-pairs.json');

interface FixturePair {
  id: string;
  textA: string;
  textB: string;
  verdict: 'agrees' | 'refines' | 'contradicts' | 'unrelated';
  confidence: number;
}
interface FixtureFile { pairs: FixturePair[] }

function loadFixturePairs(): FixturePair[] {
  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as FixtureFile;
  return fixture.pairs;
}

describe('contradiction judge mock accuracy floor (FEAT-456 AC-8)', () => {
  const fixturePairs = loadFixturePairs();
  const judgeProvider = makeMockProviders().llm.extraction;
  const db = openDb(':memory:');
  migrate(db);
  const budget = new BudgetTracker(db);

  it.each(fixturePairs.map(p => [p.id, p] as const))(
    'pair %s returns its labeled verdict',
    async (_id, pair) => {
      const verdict = await judgeContradiction(
        judgeProvider,
        budget,
        10,
        { text: pair.textA, created_at: 1_000 },
        { text: pair.textB, created_at: 2_000 },
      );
      expect(verdict.verdict).toBe(pair.verdict);
      expect(verdict.confidence).toBe(pair.confidence);
    },
  );

  it('every fixture pair is exercised at least once (non-empty fixture)', () => {
    expect(fixturePairs.length).toBeGreaterThan(0);
  });
});
