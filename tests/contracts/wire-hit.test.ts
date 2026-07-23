// issue #352B: `correction_pending` is a LOCAL-ONLY SearchHit field (the
// corrected-atom marker) — the canonical astramem-retrieval-result@1 hit
// shape is `additionalProperties: false` and has no such property (see
// contracts/schemas/retrieval-result.v1.schema.json), so toWireHit() must
// strip it exactly like it already strips the internal `source` fusion-leg
// indicator and `reranked`/`rerank_score`. tests/contracts/conformance.test.ts
// covers the schema-validation angle end-to-end against a REAL search()
// response; this file pins the exclusion behavior directly against
// toWireHit() in isolation, including running its output through the actual
// ajv-compiled schema (review finding 3, PR #378) — not just object-key
// inspection, which could pass even if a sibling property name collided.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import type { ValidateFunction } from 'ajv';
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

// Same ajv config as tests/contracts/conformance.test.ts (strict: true,
// strictRequired: false — see that file / contracts/validate.mjs for why).
const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
addFormats(ajv);
let validateEnvelope: ValidateFunction;

beforeAll(() => {
  const schemaPath = join(__dirname, '../../contracts/schemas/retrieval-result.v1.schema.json');
  const schema = JSON.parse(readFileSync(schemaPath, 'utf-8'));
  validateEnvelope = ajv.compile(schema);
});

function envelope(hits: unknown[]): unknown {
  return { schema: 'astramem-retrieval-result@1', hits };
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

  // Review finding 3 (PR #378): prove the strip via the real ajv-compiled
  // schema, not just object-key inspection — a key-inspection assertion
  // alone can't tell "stripped" apart from "renamed to a property the
  // schema happens to also allow."
  it('a hit that HAS correction_pending pre-strip still validates against retrieval-result.v1 after toWireHit()', () => {
    const hit = baseHit({
      correction_pending: { proposal_id: 'p1', winner_id: 'w1', confidence: 0.9 },
    });
    const wire = toWireHit(hit);
    const valid = validateEnvelope(envelope([wire]));
    expect(validateEnvelope.errors).toBeNull();
    expect(valid).toBe(true);
  });

  // The converse: an UNSTRIPPED hit (bypassing toWireHit entirely) MUST fail
  // the closed schema — this is what proves the strip is load-bearing rather
  // than incidental (additionalProperties: false rejects the unknown key).
  it('an unstripped hit (correction_pending left in) fails retrieval-result.v1 (additionalProperties: false)', () => {
    const hit = baseHit({
      correction_pending: { proposal_id: 'p1', winner_id: 'w1', confidence: 0.9 },
    });
    const valid = validateEnvelope(envelope([hit]));
    expect(valid).toBe(false);
    expect(validateEnvelope.errors?.some(e => e.message?.includes('additional properties'))).toBe(true);
  });
});

// Wave-6 (P2 retrieval-overhaul evidence-sufficiency lever, src/search/
// evidence-bundle.ts): `bundled`/`bundle_reason` are LOCAL-ONLY SearchHit
// fields (the evidence-bundling stage's provenance marker), same posture as
// `correction_pending` above — the closed astramem-retrieval-result@1 hit
// shape doesn't declare either property, so toWireHit() must strip both.
// Mirrors the correction_pending block's exact 4-test shape (key-inspection
// strip, no-op-when-absent, ajv-valid-after-strip, ajv-fails-when-unstripped).
describe('toWireHit — Wave-6 bundled/bundle_reason exclusion', () => {
  it('strips bundled/bundle_reason from the canonical wire hit', () => {
    const hit = baseHit({ bundled: true, bundle_reason: 'same_entity' });
    const wire = toWireHit(hit) as Record<string, unknown>;
    expect(wire.bundled).toBeUndefined();
    expect(wire.bundle_reason).toBeUndefined();
    expect('bundled' in wire).toBe(false);
    expect('bundle_reason' in wire).toBe(false);
  });

  it('every other field survives unchanged when bundled/bundle_reason are absent (no-op case)', () => {
    const hit = baseHit();
    const wire = toWireHit(hit) as Record<string, unknown>;
    expect(wire.id).toBe(hit.id);
    expect(wire.text).toBe(hit.text);
    expect(wire.score).toBe(hit.score);
    expect('bundled' in wire).toBe(false);
    expect('bundle_reason' in wire).toBe(false);
  });

  it('a hit that HAS bundled/bundle_reason pre-strip still validates against retrieval-result.v1 after toWireHit()', () => {
    const hit = baseHit({ bundled: true, bundle_reason: 'same_session' });
    const wire = toWireHit(hit);
    const valid = validateEnvelope(envelope([wire]));
    expect(validateEnvelope.errors).toBeNull();
    expect(valid).toBe(true);
  });

  // The converse: an UNSTRIPPED hit (bypassing toWireHit entirely) MUST fail
  // the closed schema — proves the strip is load-bearing, not incidental.
  it('an unstripped hit (bundled/bundle_reason left in) fails retrieval-result.v1 (additionalProperties: false)', () => {
    const hit = baseHit({ bundled: true, bundle_reason: 'same_session' });
    const valid = validateEnvelope(envelope([hit]));
    expect(valid).toBe(false);
    expect(validateEnvelope.errors?.some(e => e.message?.includes('additional properties'))).toBe(true);
  });
});
