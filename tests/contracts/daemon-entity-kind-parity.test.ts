import { describe, it, expect } from 'vitest';
import { ENTITY_KINDS as REAL_ENTITY_KINDS, ACTOR_KINDS as REAL_ACTOR_KINDS } from '../../contracts/wire.js';
import { ENTITY_KINDS, ACTOR_KINDS, type EntityKind } from '../../src/contracts/entity.js';

// ---------------------------------------------------------------------------
// FEAT (atom@2 local writer adoption, 2026-07-09): astramem-local's own
// tsconfig.json scopes rootDir to `src/`, so daemon source cannot `import`
// `contracts/wire.ts` directly (TS6059) — src/contracts/entity.ts is
// therefore a hand-mirrored copy. This test (unlike src/ code) is not
// rootDir-constrained, so it can import BOTH the real contracts/wire.ts and
// the daemon mirror and assert they agree — same pattern as
// recall-filter-parity.test.ts / memory-type-parity.test.ts /
// wire-version-map-parity.test.ts.
// ---------------------------------------------------------------------------

describe('daemon entity-kind parity — contracts/wire.ts <-> src/contracts/entity.ts', () => {
  it('ENTITY_KINDS is byte-identical (order-independent) to the real contracts package', () => {
    expect(new Set(ENTITY_KINDS)).toEqual(new Set(REAL_ENTITY_KINDS));
    expect(ENTITY_KINDS.length).toBe(REAL_ENTITY_KINDS.length);
  });

  it('ACTOR_KINDS is byte-identical to the real contracts package', () => {
    expect(new Set(ACTOR_KINDS)).toEqual(new Set(REAL_ACTOR_KINDS));
  });

  it('has exactly 12 values, no duplicates', () => {
    expect(ENTITY_KINDS.length).toBe(12);
    expect(new Set(ENTITY_KINDS).size).toBe(12);
  });

  it('a value outside the registry is rejected at the type level (compile-time only — runtime sanity via array membership)', () => {
    const bogus = 'person';
    expect((ENTITY_KINDS as readonly string[]).includes(bogus)).toBe(false);
    expect((ENTITY_KINDS as readonly string[]).includes('repo')).toBe(false);
  });

  it('EntityKind type is exported and assignable from every ENTITY_KINDS member', () => {
    const probe: EntityKind[] = [...ENTITY_KINDS];
    expect(probe.length).toBe(12);
  });
});
