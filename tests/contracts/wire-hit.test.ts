// issue #352B: `correction_pending` is a LOCAL-ONLY SearchHit field (the
// corrected-atom marker) — the canonical astramem-retrieval-result@1 hit
// shape is `additionalProperties: false` and has no such property (see
// contracts/schemas/retrieval-result.v1.schema.json), so toWireHit() must
// strip it exactly like it already strips the internal `source` fusion-leg
// indicator and `reranked`/`rerank_score`. tests/contracts/conformance.test.ts
// covers the schema-validation angle end-to-end; this file pins the
// exclusion behavior directly against toWireHit() in isolation.

import { describe, it, expect } from 'vitest';
import { toWireHit } from '../../src/contracts/wire-hit.js';
import type { SearchHit } from '../../src/search/search.js';

function baseHit(overrides: Partial<SearchHit> = {}): SearchHit {
  return {
    id: 'a1111111-1111-4111-8111-111111111111',
    type: 'fact',
    text: 'the default port is 7777',
    score: 0.5,
    source: 'fts',
    scope: 'private',
    importance: 0.5,
    confidence: 0.5,
    created_at: '2026-07-16T00:00:00.000Z',
    explanation: { final: 0.5, signals: {} },
    ...overrides,
  };
}

describe('toWireHit — issue #352B correction_pending exclusion', () => {
  it('strips correction_pending from the canonical wire hit', () => {
    const hit = baseHit({
      correction_pending: { proposal_id: 'p1', winner_id: 'w1', confidence: 0.9 },
    });
    const wire = toWireHit(hit) as Record<string, unknown>;
    expect(wire.correction_pending).toBeUndefined();
    expect('correction_pending' in wire).toBe(false);
  });

  it('every other field survives unchanged when correction_pending is absent (no-op case)', () => {
    const hit = baseHit();
    const wire = toWireHit(hit) as Record<string, unknown>;
    expect(wire.id).toBe(hit.id);
    expect(wire.text).toBe(hit.text);
    expect(wire.score).toBe(hit.score);
    expect('correction_pending' in wire).toBe(false);
  });
});
