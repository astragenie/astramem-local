/**
 * ADR-015 rule 6, applied to redaction classification: "a canary that can
 * only ever go green is decoration." src/ingest/spool-schema-guard.ts
 * protects every field CanonicalIngestSchema defines as structural (never
 * redacted) and redacts everything else — but the boundary between
 * "content" and "structural" for a field the schema DOES define is a
 * hand-maintained judgment call (CONTENT_FIELD_PATHS /
 * KNOWN_STRUCTURAL_FIELD_PATHS), because "this string is user-authored
 * prose" is semantic, not something Zod's type system encodes. A new
 * schema field landing in neither list would silently do one of two bad
 * things depending on which list it should have been in — leak a new
 * content field in plaintext, or (in a differently-shaped design) destroy
 * a new structural identifier. This test converts "someone forgot" from a
 * silent failure into a red build with a clear message: it enumerates
 * every leaf field the schema ACTUALLY defines (via the same runtime Zod
 * introspection `redactSpooledEnvelope` uses — never a second, hand-copied
 * list that could itself drift) and asserts the two classification lists'
 * union covers it exactly.
 */
import { describe, it, expect } from 'vitest';
import {
  collectLeafPaths,
  CANONICAL_ENVELOPE_SHAPE,
  CONTENT_FIELD_PATHS,
  KNOWN_STRUCTURAL_FIELD_PATHS,
} from '../../src/ingest/spool-schema-guard.js';

describe('spool-schema-guard classification completeness', () => {
  it('every leaf field CanonicalIngestSchema defines is explicitly classified as content or structural', () => {
    const actualLeaves = collectLeafPaths(CANONICAL_ENVELOPE_SHAPE);
    const classified = new Set([...CONTENT_FIELD_PATHS, ...KNOWN_STRUCTURAL_FIELD_PATHS]);

    const unclassified = actualLeaves.filter(p => !classified.has(p));
    expect(
      unclassified,
      unclassified.length > 0
        ? `Unclassified schema field(s): ${unclassified.join(', ')}. Add each to CONTENT_FIELD_PATHS ` +
          '(free text a human/model produced — always redact) or KNOWN_STRUCTURAL_FIELD_PATHS (an ' +
          'identifier/enum/timestamp/version the daemon interprets — never redact) in ' +
          'src/ingest/spool-schema-guard.ts. A field in neither is a silent plaintext-leak risk.'
        : undefined,
    ).toEqual([]);
  });

  it('the classification lists contain no stale entries — a path that no longer exists in the schema', () => {
    // The inverse drift direction: a field removed or renamed in the
    // schema should also be caught, or the lists quietly stop meaning
    // anything precise.
    const actualLeaves = new Set(collectLeafPaths(CANONICAL_ENVELOPE_SHAPE));
    const claimed = [...CONTENT_FIELD_PATHS, ...KNOWN_STRUCTURAL_FIELD_PATHS];
    const stale = claimed.filter(p => !actualLeaves.has(p));
    expect(stale, `Stale classification entries no longer present in the schema: ${stale.join(', ')}`).toEqual([]);
  });

  it('the two lists do not overlap — a field cannot be simultaneously always-redact and never-redact', () => {
    const overlap = [...CONTENT_FIELD_PATHS].filter(p => KNOWN_STRUCTURAL_FIELD_PATHS.has(p));
    expect(overlap, `Field(s) claimed as BOTH content and structural: ${overlap.join(', ')}`).toEqual([]);
  });

  it('proves the completeness check actually fires: a synthetic new field on a copy of the shape is correctly detected as unclassified', () => {
    // This is the test-of-the-test — it demonstrates the mechanism above
    // is not a tautology. Without this, "the completeness test passes"
    // could just mean collectLeafPaths and the classification lists were
    // built by copy-pasting each other, never actually cross-checking
    // against the live schema.
    const syntheticShape = {
      ...CANONICAL_ENVELOPE_SHAPE,
      brand_new_unclassified_field: CANONICAL_ENVELOPE_SHAPE['session_id']!,
    };
    const leaves = collectLeafPaths(syntheticShape);
    const classified = new Set([...CONTENT_FIELD_PATHS, ...KNOWN_STRUCTURAL_FIELD_PATHS]);

    expect(leaves).toContain('brand_new_unclassified_field');
    expect(classified.has('brand_new_unclassified_field')).toBe(false);
    // i.e.: if this synthetic field were added to the REAL schema and
    // nobody updated the classification lists, the first test in this
    // file would fail exactly like this one demonstrates it can.
  });
});
