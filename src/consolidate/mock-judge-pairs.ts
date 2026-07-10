/**
 * FEAT-456 SLICE-1: closed, deterministic (textA, textB) -> verdict lookup
 * table backing the contradiction judge's mock branch in
 * src/pipeline/mock-providers.ts — mirrors the FEAT-414
 * MOCK_EXTRACTION_VOCAB pattern (design §3.2), not keyword heuristics
 * (too fragile/ambiguous for a 4-way classification).
 *
 * Single source of truth shared with
 * contracts/fixtures/eval/contradiction-judge-pairs.json (the labeled
 * fixture used by tests/eval/contradiction-judge-eval.test.ts) — the two
 * are kept in lockstep by
 * tests/hygiene/mock-judge-vocab-fixture-lockstep.test.ts, same shape as
 * tests/hygiene/mock-vocab-fixture-lockstep.test.ts. Edit exactly one
 * array here and mirror it in the fixture — drift between the two is a
 * failing test, not silence.
 *
 * TEST-ONLY: exclusively reachable via ASTRA_MEMORY_MOCK_PROVIDERS=1
 * (CI/test only — real serving never sets it). Not a production code path.
 */

import type { JudgeVerdictLabel } from './contradiction-judge.js';

export interface MockJudgePair {
  id: string;
  textA: string;
  textB: string;
  verdict: JudgeVerdictLabel;
  confidence: number;
}

export const MOCK_JUDGE_PAIRS: readonly MockJudgePair[] = [
  {
    id: 'P1', textA: 'Port 7777 is the default.', textB: 'The default port is 7777.',
    verdict: 'agrees', confidence: 0.9,
  },
  {
    id: 'P2', textA: 'Default port is 7777.', textB: 'Default port is now 8888.',
    verdict: 'contradicts', confidence: 0.92,
  },
  {
    id: 'P3', textA: 'Uses mxbai-embed-large (1024-dim).', textB: 'Uses mxbai-embed-large, 1024-dim, verified at boot.',
    verdict: 'refines', confidence: 0.85,
  },
  {
    id: 'P4', textA: 'Config lives in %APPDATA%\\Astramem.', textB: 'Ollama must be running locally.',
    verdict: 'unrelated', confidence: 0.8,
  },
  {
    id: 'P5', textA: 'The daemon binds to port 7777.', textB: 'The daemon now binds to port 9999.',
    verdict: 'contradicts', confidence: 0.95,
  },
  {
    id: 'P6', textA: 'SQLite is the storage engine.', textB: 'The storage engine is SQLite.',
    verdict: 'agrees', confidence: 0.88,
  },
  {
    id: 'P7', textA: 'mxbai-embed-large is 1024-dim.', textB: 'mxbai-embed-large is 1024-dim and matches the schema default.',
    verdict: 'refines', confidence: 0.82,
  },
  {
    id: 'P8', textA: 'Deploys run at midnight.', textB: 'Ollama must be running for embeddings.',
    verdict: 'unrelated', confidence: 0.75,
  },
] as const;

/**
 * Order-independent exact-text lookup: sorts the two candidate texts so
 * caller argument order never matters, matching how the pair-scan visits
 * (a, b) in an arbitrary, insertion-derived order. Returns `undefined` for
 * an unlisted pair — the mock branch's caller falls back to
 * `{ verdict: 'unrelated', confidence: 0.5 }` (safe default; never
 * fabricates a contradiction the fixture didn't ask for).
 */
export function findMockJudgePair(textA: string, textB: string): MockJudgePair | undefined {
  const [x, y] = [textA, textB].sort();
  return MOCK_JUDGE_PAIRS.find(p => {
    const [px, py] = [p.textA, p.textB].sort();
    return px === x && py === y;
  });
}
