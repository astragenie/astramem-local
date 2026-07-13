import { describe, it, expect } from 'vitest';
import {
  resolveExtractionPrompt,
  AtomSchema,
  EXTRACTION_SYSTEM_PROMPT,
  EXTRACTION_SYSTEM_PROMPT_V2,
  EXTRACTION_SYSTEM_PROMPT_V3,
  EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL_PENDING,
} from '../../../src/distill/prompts/extract.js';

function makeAtom(text: string) {
  return { type: 'lesson' as const, text, importance: 0.5, confidence: 0.5 };
}

// SLICE-433 AC-7: cap bumped 500 -> 1000 so the v3 300-800 char rich-shape
// target is never schema-rejected or silently truncated. memories.text is a
// plain SQLite TEXT column (migrations/001-init.sql) — no migration needed.
describe('AtomSchema.text cap (SLICE-433 AC-7)', () => {
  it('accepts a 900-char text (within the new 1000 cap, above the old 500 one)', () => {
    const text = 'x'.repeat(900);
    expect(AtomSchema.safeParse(makeAtom(text)).success).toBe(true);
  });

  it('accepts exactly 1000 chars (the new boundary)', () => {
    expect(AtomSchema.safeParse(makeAtom('x'.repeat(1000))).success).toBe(true);
  });

  it('rejects 1001 chars (over the new cap)', () => {
    expect(AtomSchema.safeParse(makeAtom('x'.repeat(1001))).success).toBe(false);
  });

  it('still rejects under 5 chars (unchanged lower bound)', () => {
    expect(AtomSchema.safeParse(makeAtom('hi')).success).toBe(false);
  });
});

// FEAT-479 (D3 §3.2) AC-2/AC-3/AC-4, updated by SLICE-433 AC-5/AC-6/AC-8:
// resolveExtractionPrompt is the single choke point for the extraction-
// prompt precedence chain. Precedence (highest first): ASTRA_EXTRACT_PROMPT
// =v2 env override > =v1 env override (SLICE-433 rollback lever) > profile
// === 'conversational' > engineering default, which SLICE-433 replaced with
// v3 (see resolveExtractionPrompt's doc comment for the replace-vs-flag
// rationale). These assertions were DELIBERATELY designed to fail once
// SLICE-433 landed its default swap — this is that update, pinning v3 as
// the new default rather than treating the old v1-default test as a
// regression to revert.
describe('resolveExtractionPrompt', () => {
  it('SLICE-433 default: no profile, no env override -> the v3 engineering-rich prompt (replaces v1 as default)', () => {
    expect(resolveExtractionPrompt(undefined, undefined)).toBe(EXTRACTION_SYSTEM_PROMPT_V3);
    expect(resolveExtractionPrompt(null, undefined)).toBe(EXTRACTION_SYSTEM_PROMPT_V3);
    expect(resolveExtractionPrompt('engineering', undefined)).toBe(EXTRACTION_SYSTEM_PROMPT_V3);
  });

  it("SLICE-433 rollback lever: ASTRA_EXTRACT_PROMPT=v1 resolves to the original (pre-SLICE-433) engineering prompt verbatim", () => {
    expect(resolveExtractionPrompt('engineering', 'v1')).toBe(EXTRACTION_SYSTEM_PROMPT);
    expect(resolveExtractionPrompt(undefined, 'v1')).toBe(EXTRACTION_SYSTEM_PROMPT);
    // v1 override wins even under the conversational profile — same
    // "regardless of profile" semantics the v2 override already had.
    expect(resolveExtractionPrompt('conversational', 'v1')).toBe(EXTRACTION_SYSTEM_PROMPT);
  });

  it("profile 'conversational' (no override) resolves to the SLICE-434 pending-marker constant (not yet the real conversational prompt, and NOT v3)", () => {
    expect(resolveExtractionPrompt('conversational', undefined)).toBe(
      EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL_PENDING,
    );
    // Today this is still textually identical to the OLD (pre-SLICE-433) v1
    // engineering prompt — SLICE-434 owns replacing it with real
    // conversational-profile content, and SLICE-433 deliberately left it
    // pointed at v1 rather than v3 so the two prompt rewrites stay
    // independently reviewable. Asserted explicitly so this test starts
    // failing the moment SLICE-434 diverges the constant, as a reminder to
    // revisit this assertion rather than silently passing.
    expect(EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL_PENDING).toBe(EXTRACTION_SYSTEM_PROMPT);
    expect(EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL_PENDING).not.toBe(EXTRACTION_SYSTEM_PROMPT_V3);
  });

  it("AC-4: ASTRA_EXTRACT_PROMPT=v2 wins over profile 'engineering'", () => {
    expect(resolveExtractionPrompt('engineering', 'v2')).toBe(EXTRACTION_SYSTEM_PROMPT_V2);
  });

  it("AC-4: ASTRA_EXTRACT_PROMPT=v2 wins over profile 'conversational' too — existing override semantics, regardless of profile", () => {
    expect(resolveExtractionPrompt('conversational', 'v2')).toBe(EXTRACTION_SYSTEM_PROMPT_V2);
  });

  it("v2 wins over v1 is not a real conflict (env var holds one value), but v2 still wins over 'engineering' with no ambiguity", () => {
    expect(resolveExtractionPrompt('engineering', 'v2')).not.toBe(EXTRACTION_SYSTEM_PROMPT);
    expect(resolveExtractionPrompt('engineering', 'v2')).not.toBe(EXTRACTION_SYSTEM_PROMPT_V3);
  });

  it('an unset/other env override value falls through to profile resolution unaffected (default is now v3)', () => {
    expect(resolveExtractionPrompt('engineering', undefined)).toBe(EXTRACTION_SYSTEM_PROMPT_V3);
    expect(resolveExtractionPrompt('engineering', '')).toBe(EXTRACTION_SYSTEM_PROMPT_V3);
    expect(resolveExtractionPrompt('engineering', 'not-a-real-value')).toBe(EXTRACTION_SYSTEM_PROMPT_V3);
  });
});

// SLICE-433 AC-5/AC-6: the v3 prompt states the type-conditioned richness
// rule and self-containment rule EXPLICITLY as instructions, and keeps the
// 7-type taxonomy / priority order / entity contract unchanged from v1/v2.
describe('EXTRACTION_SYSTEM_PROMPT_V3 content', () => {
  it('states the type-conditioned richness rule explicitly (not only via example shape)', () => {
    expect(EXTRACTION_SYSTEM_PROMPT_V3).toMatch(/TYPE-CONDITIONED/);
    expect(EXTRACTION_SYSTEM_PROMPT_V3).toMatch(/300-800 characters/);
    expect(EXTRACTION_SYSTEM_PROMPT_V3).toMatch(/stay atomic and short/);
  });

  it('states the self-containment rule (pronoun resolution, proper nouns, date grounding)', () => {
    expect(EXTRACTION_SYSTEM_PROMPT_V3).toMatch(/Self-containment/);
    expect(EXTRACTION_SYSTEM_PROMPT_V3).toMatch(/Never genericize a proper noun/);
    expect(EXTRACTION_SYSTEM_PROMPT_V3).toMatch(/Ground relative dates/);
  });

  it('carries over the 7-type taxonomy and priority order unchanged from v1/v2', () => {
    for (const marker of [
      '1. command:', '2. todo:', '3. event:', '4. decision:', '5. lesson:', '6. fact:', '7. note:',
    ]) {
      expect(EXTRACTION_SYSTEM_PROMPT_V3).toContain(marker);
    }
  });

  it('carries over the entity-kind contract unchanged from v1/v2', () => {
    for (const kind of ['actor:', 'team:', 'org:', 'project:', 'product:', 'workitem:', 'decision:', 'tech:', 'tool:', 'concept:', 'event:', 'other:']) {
      expect(EXTRACTION_SYSTEM_PROMPT_V3).toContain(kind);
    }
    // FEAT-481's relation triples are explicitly out of scope for this
    // slice (SLICE-435 owns adding a `relations[]` field) — check for that
    // specific addition, not the substring "relations" in general (the
    // unchanged entity contract already legitimately says "relationship").
    expect(EXTRACTION_SYSTEM_PROMPT_V3).not.toMatch(/relations\[\]/);
    expect(EXTRACTION_SYSTEM_PROMPT_V3).not.toMatch(/"relations"/);
  });

  it('includes a negative (WRONG vs RIGHT) example demonstrating the contextless-trivia failure mode', () => {
    expect(EXTRACTION_SYSTEM_PROMPT_V3).toMatch(/NEGATIVE EXAMPLE/);
    expect(EXTRACTION_SYSTEM_PROMPT_V3).toMatch(/WRONG/);
    expect(EXTRACTION_SYSTEM_PROMPT_V3).toMatch(/RIGHT/);
  });

  it('the JSON schema hint reflects the new 1000-char cap, not the old 500-char one', () => {
    expect(EXTRACTION_SYSTEM_PROMPT_V3).toMatch(/5-1000 chars/);
  });
});
