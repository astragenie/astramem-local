// Wave-6 (P2 retrieval-overhaul evidence-sufficiency lever) —
// src/search/evidence-bundle.ts's pure/no-DB surface.
//
// AC: isEvidenceThin fires when the distinct non-null session count is below
//     minDistinctSessions, and does not fire when it meets or exceeds it.
// AC: resolveEvidenceBundlingOpts(config) is undefined when
//     config.evidenceBundling.enabled is false (the default).
// AC: resolveEvidenceBundlingOpts(config) resolves the configured fields
//     verbatim when enabled.

import { describe, it, expect } from 'vitest';
import { isEvidenceThin, resolveEvidenceBundlingOpts } from '../../src/search/evidence-bundle.js';
import { defaultConfig } from '../../src/config/config.js';

describe('isEvidenceThin', () => {
  it('fires when every hit shares the same single session (distinct count 1 < minDistinctSessions 2)', () => {
    expect(isEvidenceThin(['s1', 's1', 's1'], 2)).toBe(true);
  });

  it('does not fire when hits span exactly minDistinctSessions', () => {
    expect(isEvidenceThin(['s1', 's2'], 2)).toBe(false);
  });

  it('does not fire when hits span MORE than minDistinctSessions', () => {
    expect(isEvidenceThin(['s1', 's2', 's3'], 2)).toBe(false);
  });

  it('null session_id values are excluded from the distinct count, not counted as their own session', () => {
    // Two real hits, both with session_id null (e.g. direct /remember writes,
    // no session attached) — 0 distinct real sessions, always thin regardless
    // of hit count.
    expect(isEvidenceThin([null, null, null], 1)).toBe(true);
  });

  it('minDistinctSessions=1 never fires as long as at least one hit has a real session_id', () => {
    expect(isEvidenceThin(['s1', null], 1)).toBe(false);
  });

  it('an empty hit list is trivially thin for any positive threshold', () => {
    expect(isEvidenceThin([], 1)).toBe(true);
  });
});

describe('resolveEvidenceBundlingOpts', () => {
  it('is undefined when config.evidenceBundling.enabled is false (the shipped default)', () => {
    expect(defaultConfig().evidenceBundling.enabled).toBe(false);
    expect(resolveEvidenceBundlingOpts(defaultConfig())).toBeUndefined();
  });

  it('resolves the configured fields verbatim when enabled', () => {
    const cfg = defaultConfig();
    cfg.evidenceBundling = {
      enabled: true, maxExtra: 3, minDistinctSessions: 4, sameEntity: false, sameSession: true,
    };
    const opts = resolveEvidenceBundlingOpts(cfg);
    expect(opts).toEqual({ maxExtra: 3, minDistinctSessions: 4, sameEntity: false, sameSession: true });
  });
});
