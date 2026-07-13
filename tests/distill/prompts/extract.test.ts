import { describe, it, expect } from 'vitest';
import {
  resolveExtractionPrompt,
  EXTRACTION_SYSTEM_PROMPT,
  EXTRACTION_SYSTEM_PROMPT_V2,
  EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL_PENDING,
} from '../../../src/distill/prompts/extract.js';

// FEAT-479 (D3 §3.2) AC-2/AC-3/AC-4: resolveExtractionPrompt is the single
// choke point for the extraction-prompt precedence chain. Precedence
// (highest first): ASTRA_EXTRACT_PROMPT=v2 env override > profile ===
// 'conversational' > engineering default (v1).
describe('resolveExtractionPrompt', () => {
  it('AC-2 byte-identical default: no profile, no env override -> the exact pre-FEAT-479 v1 prompt object', () => {
    expect(resolveExtractionPrompt(undefined, undefined)).toBe(EXTRACTION_SYSTEM_PROMPT);
    expect(resolveExtractionPrompt(null, undefined)).toBe(EXTRACTION_SYSTEM_PROMPT);
    expect(resolveExtractionPrompt('engineering', undefined)).toBe(EXTRACTION_SYSTEM_PROMPT);
  });

  it("profile 'conversational' resolves to the SLICE-434 pending-marker constant (not yet the real conversational prompt)", () => {
    expect(resolveExtractionPrompt('conversational', undefined)).toBe(
      EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL_PENDING,
    );
    // Today this is textually identical to the engineering prompt (SLICE-434
    // hasn't landed its own text yet) — asserted explicitly so this test
    // starts failing the moment SLICE-434 diverges the constant, as a
    // reminder to revisit this assertion rather than silently passing.
    expect(EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL_PENDING).toBe(EXTRACTION_SYSTEM_PROMPT);
  });

  it("AC-4: ASTRA_EXTRACT_PROMPT=v2 wins over profile 'engineering'", () => {
    expect(resolveExtractionPrompt('engineering', 'v2')).toBe(EXTRACTION_SYSTEM_PROMPT_V2);
  });

  it("AC-4: ASTRA_EXTRACT_PROMPT=v2 wins over profile 'conversational' too — existing override semantics, regardless of profile", () => {
    expect(resolveExtractionPrompt('conversational', 'v2')).toBe(EXTRACTION_SYSTEM_PROMPT_V2);
  });

  it('an unset/other env override value falls through to profile resolution unaffected', () => {
    expect(resolveExtractionPrompt('engineering', undefined)).toBe(EXTRACTION_SYSTEM_PROMPT);
    expect(resolveExtractionPrompt('engineering', '')).toBe(EXTRACTION_SYSTEM_PROMPT);
    expect(resolveExtractionPrompt('engineering', 'v1')).toBe(EXTRACTION_SYSTEM_PROMPT);
  });
});
