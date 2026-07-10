/**
 * FEAT-456 SLICE-1: kills silent drift between src/consolidate/mock-judge-pairs.ts's
 * deterministic (textA, textB) -> verdict table and
 * contracts/fixtures/eval/contradiction-judge-pairs.json — the labeled
 * fixture tests/eval/contradiction-judge-eval.test.ts runs the mock judge
 * against. Same shape as tests/hygiene/mock-vocab-fixture-lockstep.test.ts
 * (FEAT-414): both sides are declared independently (the fixture is JSON,
 * consumable by a future non-mock accuracy eval; the vocab is TS, consumed
 * by the mock provider), so an edit on one side without the other would
 * otherwise silently desync the mock branch from what the fixture claims is
 * labeled. This test asserts every pair in one exists, byte-for-byte, in
 * the other.
 *
 * Pure test-infra hygiene: never runs the mock providers or a daemon.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MOCK_JUDGE_PAIRS, type MockJudgePair } from '../../src/consolidate/mock-judge-pairs.js';

const FIXTURE_PATH = join(process.cwd(), 'contracts', 'fixtures', 'eval', 'contradiction-judge-pairs.json');

interface FixtureFile { pairs: MockJudgePair[] }

function loadFixturePairs(): MockJudgePair[] {
  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as FixtureFile;
  return fixture.pairs;
}

function sortKey(p: MockJudgePair): string {
  return JSON.stringify({ id: p.id, textA: p.textA, textB: p.textB, verdict: p.verdict, confidence: p.confidence });
}

describe('mock-judge-pairs <-> contradiction-judge-pairs.json lockstep (FEAT-456)', () => {
  const fixturePairs = loadFixturePairs();

  it('every MOCK_JUDGE_PAIRS entry has a byte-identical fixture entry', () => {
    const fixtureKeys = new Set(fixturePairs.map(sortKey));
    for (const pair of MOCK_JUDGE_PAIRS) {
      expect(
        fixtureKeys.has(sortKey(pair)),
        `MOCK_JUDGE_PAIRS entry "${pair.id}" has no byte-identical match in ` +
          'contracts/fixtures/eval/contradiction-judge-pairs.json — update the fixture or the ' +
          'vocab in src/consolidate/mock-judge-pairs.ts so they stay in lockstep.',
      ).toBe(true);
    }
  });

  it('every fixture entry has a byte-identical MOCK_JUDGE_PAIRS match', () => {
    const vocabKeys = new Set(MOCK_JUDGE_PAIRS.map(sortKey));
    for (const pair of fixturePairs) {
      expect(
        vocabKeys.has(sortKey(pair)),
        `contradiction-judge-pairs.json entry "${pair.id}" has no byte-identical match in ` +
          'src/consolidate/mock-judge-pairs.ts MOCK_JUDGE_PAIRS — update the vocab or the ' +
          'fixture so they stay in lockstep.',
      ).toBe(true);
    }
  });

  it('every pair id is unique on both sides', () => {
    expect(new Set(MOCK_JUDGE_PAIRS.map(p => p.id)).size).toBe(MOCK_JUDGE_PAIRS.length);
    expect(new Set(fixturePairs.map(p => p.id)).size).toBe(fixturePairs.length);
  });
});
