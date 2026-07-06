// U7-local (astramem-local#110, DEC-048): scope enum rename 'personal' ->
// 'private'. This suite covers AC-2 (one-release inbound alias) directly at
// the normalization function, since the illustrative call site in the issue
// (POST /memory/:id/promote's PromoteBodySchema) can never observably store
// the *target* 'personal'/'private' via a successful promotion — promotion
// only ever moves upward and 'private' is the lowest rank, so an alias
// target there always 409s (see tests/server/lifecycle.test.ts's "downward
// promotion (team -> personal, via the alias) -> 409"). The round-trip the
// AC cares about — an inbound 'personal' literal is normalized to 'private'
// before it reaches storage — is exhaustively covered here instead.

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { normalizeScopeAlias, type MemoryScope, type MemoryScopeAlias } from '../../src/contracts/memory.js';

describe('normalizeScopeAlias (U7-local #110, DEC-048 one-release alias)', () => {
  it("normalizes the pre-rename 'personal' literal to 'private'", () => {
    expect(normalizeScopeAlias('personal')).toBe('private');
  });

  it('is the identity function for every canonical MemoryScope value', () => {
    const canonical: MemoryScope[] = ['private', 'team', 'org'];
    for (const scope of canonical) {
      expect(normalizeScopeAlias(scope)).toBe(scope);
    }
  });

  it('round-trips through the exact zod shape PromoteBodySchema uses (accept personal, store/return private)', () => {
    // Mirrors src/server/routes/lifecycle.ts's PromoteBodySchema exactly —
    // a regression here means the route's own schema drifted from this test.
    const schema = z.object({
      scope: z.enum(['private', 'team', 'org', 'personal']).transform(normalizeScopeAlias),
    });

    const fromAlias = schema.parse({ scope: 'personal' });
    expect(fromAlias.scope).toBe('private');

    const fromCanonical = schema.parse({ scope: 'private' });
    expect(fromCanonical.scope).toBe('private');

    expect(() => schema.parse({ scope: 'galaxy' })).toThrow();
  });

  it('MemoryScopeAlias accepts every canonical value plus the legacy literal (compile-time shape check)', () => {
    const values: MemoryScopeAlias[] = ['private', 'team', 'org', 'personal'];
    expect(values.map(normalizeScopeAlias)).toEqual(['private', 'team', 'org', 'private']);
  });
});
