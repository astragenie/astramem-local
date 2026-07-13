import { describe, it, expect } from 'vitest';
import {
  resolveExtractionPrompt,
  AtomSchema,
  EXTRACTION_SYSTEM_PROMPT,
  EXTRACTION_SYSTEM_PROMPT_V2,
  EXTRACTION_SYSTEM_PROMPT_V3,
  EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL,
} from '../../../src/distill/prompts/extract.js';

/** chars/4 token estimate — mirrors src/providers/llm/ollama.ts's
 * CHARS_PER_TOKEN heuristic and src/distill/stages/03-chunk.ts's own
 * ~800-token chunk target (800 tokens * 4 chars/token = 3200 chars). */
const CHARS_PER_TOKEN = 4;

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

// Issue #205 (AC-1): atom-level valid_at/invalid_at, mirroring the pattern
// AtomEntitySchema/AtomRelationSchema already had — generalized to the
// atom's own claim. Both fields are optional strings (no ISO-8601 format
// validation at the schema layer, same posture as the entity-level fields —
// malformed values are handled defensively downstream by parseIsoToMs in
// src/distill/stages/08-embed-index.ts, resolving to `null`/unbounded).
describe('AtomSchema.valid_at / invalid_at (issue #205 AC-1)', () => {
  it('accepts an atom with both valid_at and invalid_at set', () => {
    const atom = { ...makeAtom('a bounded fact with a stated start and end'), valid_at: '2026-01-01T00:00:00.000Z', invalid_at: '2026-04-01T00:00:00.000Z' };
    const result = AtomSchema.safeParse(atom);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.valid_at).toBe('2026-01-01T00:00:00.000Z');
      expect(result.data.invalid_at).toBe('2026-04-01T00:00:00.000Z');
    }
  });

  it('accepts an atom with only invalid_at (a fact bounded on its end only)', () => {
    const atom = { ...makeAtom('a fact bounded only by a stated end'), invalid_at: '2026-04-01T00:00:00.000Z' };
    const result = AtomSchema.safeParse(atom);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.valid_at).toBeUndefined();
      expect(result.data.invalid_at).toBe('2026-04-01T00:00:00.000Z');
    }
  });

  it('accepts an atom with neither field — the conservative default for an unbounded fact', () => {
    const result = AtomSchema.safeParse(makeAtom('an unbounded fact, still true'));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.valid_at).toBeUndefined();
      expect(result.data.invalid_at).toBeUndefined();
    }
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

  it("profile 'conversational' (no override) resolves to the real SLICE-434 conversational prompt — NOT the engineering v1/v3 prompt", () => {
    expect(resolveExtractionPrompt('conversational', undefined)).toBe(
      EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL,
    );
    // SLICE-432/433 shipped a deliberate tripwire here: the pending-marker
    // constant was byte-identical to EXTRACTION_SYSTEM_PROMPT (v1) until this
    // slice landed real content. Now that it has, the constant MUST diverge
    // from both engineering prompts — a regression back to aliasing either
    // one would silently ship engineering-profile output under the
    // conversational label.
    expect(EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL).not.toBe(EXTRACTION_SYSTEM_PROMPT);
    expect(EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL).not.toBe(EXTRACTION_SYSTEM_PROMPT_V2);
    expect(EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL).not.toBe(EXTRACTION_SYSTEM_PROMPT_V3);
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

  // Temporal-grounding fix (2026-07-13): the injected "Observation date"
  // line (05-extract.ts's callExtract) is now the authoritative anchor the
  // date-grounding rule points at first, falling back to an in-transcript
  // anchor, falling back to keeping the original relative phrasing.
  it('states date grounding against the injected "Observation date" line first', () => {
    expect(EXTRACTION_SYSTEM_PROMPT_V3).toMatch(/Observation date/);
    expect(EXTRACTION_SYSTEM_PROMPT_V3).toMatch(/keep the original relative phrasing/);
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
  });

  // FEAT-481 (SLICE-435): entity-to-entity `relations[]` field, engineering
  // profile only (design doc §2.5). States the closed predicate enum
  // verbatim, the same-atom no-hallucination rule, and possessor
  // qualification — the actual filtering/dropping enforcement lives in
  // src/distill/stages/05-extract.ts, not in this prompt text.
  it('states the relations[] field and the closed 11-value predicate enum verbatim', () => {
    expect(EXTRACTION_SYSTEM_PROMPT_V3).toMatch(/"relations"/);
    for (const predicate of [
      'uses', 'depends_on', 'replaces', 'supersedes', 'mentions',
      'relates_to', 'part_of', 'owned_by', 'assigned_to', 'created_by', 'other',
    ]) {
      expect(EXTRACTION_SYSTEM_PROMPT_V3).toContain(predicate);
    }
  });

  it('states the same-atom no-hallucination guard and possessor qualification', () => {
    expect(EXTRACTION_SYSTEM_PROMPT_V3).toMatch(/MUST each be a name that ALSO appears in this/);
    expect(EXTRACTION_SYSTEM_PROMPT_V3).toMatch(/Possessor qualification/);
    expect(EXTRACTION_SYSTEM_PROMPT_V3).toMatch(/Prefer omission over guessing/);
  });

  it('includes at least one few-shot example pairing entities[] with relations[]', () => {
    expect(EXTRACTION_SYSTEM_PROMPT_V3).toMatch(/"relations":\[\{"subject"/);
  });

  // Issue #205 (AC-4): atom-level valid_at/invalid_at guidance — conservative
  // by construction, omit-by-default, distinguished from the pre-existing
  // "Final state only" same-session-correction rule.
  it('states the atom-level validity JSON fields in the output shape', () => {
    expect(EXTRACTION_SYSTEM_PROMPT_V3).toMatch(/"valid_at": "<ISO-8601 date-time, only if the source text states when THIS ATOM'S OWN fact started/);
    expect(EXTRACTION_SYSTEM_PROMPT_V3).toMatch(/"invalid_at": "<ISO-8601 date-time, only if the source text states when THIS ATOM'S OWN fact stopped/);
  });

  it('states the conservative omit-by-default rule and the hallucination-is-worse-than-omission warning', () => {
    expect(EXTRACTION_SYSTEM_PROMPT_V3).toMatch(/Atom-level validity \(issue #205\)/);
    expect(EXTRACTION_SYSTEM_PROMPT_V3).toMatch(/Omit BOTH by default/);
    expect(EXTRACTION_SYSTEM_PROMPT_V3).toMatch(/a hallucinated invalid_at is WORSE than none/);
  });

  it('distinguishes atom-level validity from the "Final state only" same-session-correction rule', () => {
    expect(EXTRACTION_SYSTEM_PROMPT_V3).toMatch(/This is NOT the same situation as the "Final\nstate only" rule below/);
    expect(EXTRACTION_SYSTEM_PROMPT_V3).toMatch(/bound it with invalid_at instead of dropping it/);
  });

  it('includes the Postgres -> Kafka few-shot example and its omit-by-default negative counter-example', () => {
    expect(EXTRACTION_SYSTEM_PROMPT_V3).toMatch(/"invalid_at":"2026-04-01"/);
    expect(EXTRACTION_SYSTEM_PROMPT_V3).toMatch(/"valid_at":"2026-04-01"/);
    expect(EXTRACTION_SYSTEM_PROMPT_V3).toMatch(/NEGATIVE COUNTER-EXAMPLE/);
  });

  // FEAT-479's conversational profile (SLICE-434) is NOT extended with
  // relations[] — design doc §2.5 scopes the prompt addition to the shared
  // engineering skeleton only; no direction to also add it to the
  // conversational profile.
  it('does NOT add relations[] to the conversational profile', () => {
    expect(EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL).not.toMatch(/"relations"/);
    expect(EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL).not.toMatch(/relations\[\]/);
  });

  it('includes a negative (WRONG vs RIGHT) example demonstrating the contextless-trivia failure mode', () => {
    expect(EXTRACTION_SYSTEM_PROMPT_V3).toMatch(/NEGATIVE EXAMPLE/);
    expect(EXTRACTION_SYSTEM_PROMPT_V3).toMatch(/WRONG/);
    expect(EXTRACTION_SYSTEM_PROMPT_V3).toMatch(/RIGHT/);
  });

  it('the JSON schema hint reflects the new 1000-char cap, not the old 500-char one', () => {
    expect(EXTRACTION_SYSTEM_PROMPT_V3).toMatch(/5-1000 chars/);
  });

  // FEAT-481 (SLICE-435) context-budget check — same standing rule the
  // conversational profile's own describe block below applies (SLICE-433's
  // truncation bug): the real prompt + an 800-token chunk + the 2500
  // maxTokens output budget must fit within Ollama's 16384 num_ctx cap, with
  // room left for NUM_CTX_SLACK_TOKENS (512). Added relations[] guidance
  // grows this prompt further on top of SLICE-433's already-large v3 body —
  // this test is the tripwire if a future addition pushes it over budget.
  it('fits the Ollama NUM_CTX_CAP (16384) alongside an 800-token chunk and maxTokens 2500, even with relations[] guidance added (SLICE-435 context-budget rule)', () => {
    const NUM_CTX_CAP = 16384;
    const MAX_TOKENS = 2500;
    const SLACK_TOKENS = 512;
    const CHUNK_TOKENS = 800;

    const promptTokens = EXTRACTION_SYSTEM_PROMPT_V3.length / CHARS_PER_TOKEN;
    const estimatedTotal = promptTokens + CHUNK_TOKENS + MAX_TOKENS + SLACK_TOKENS;

    expect(estimatedTotal).toBeLessThanOrEqual(NUM_CTX_CAP);
  });
});

// FEAT-479 (D3 §3.2) AC-9/AC-10 (SLICE-434): mem0/Graphiti-pattern
// conversational profile — content assertions mirror the V3-content
// describe block above, but check the profile-specific rules this prompt
// adds instead (liberal extraction, possessor qualification, banned
// abstractions, conditional date grounding) rather than the engineering
// richness rule, which this profile explicitly does NOT apply.
describe('EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL content', () => {
  it('states the mem0-pattern liberal-extraction posture and the 15-80 word self-contained-sentence shape', () => {
    expect(EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL).toMatch(/mem0 pattern/);
    expect(EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL).toMatch(/15-80 words?/);
    expect(EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL).toMatch(/Self-containment/);
  });

  it('states pronoun resolution and exact proper-noun preservation', () => {
    expect(EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL).toMatch(/Resolve every pronoun/);
    expect(EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL).toMatch(/Preserve proper nouns EXACTLY/);
  });

  it('states Graphiti-pattern possessor qualification explicitly', () => {
    expect(EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL).toMatch(/Possessor qualification/);
    expect(EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL).toMatch(/Graphiti pattern/);
  });

  // Issue #205 (AC-4): atom-level valid_at/invalid_at guidance, conversational
  // profile — same conservative omit-by-default posture as the engineering
  // (V3) prompt, phrased for personal-life timelines rather than technical ones.
  it('states the atom-level validity JSON fields in the output shape', () => {
    expect(EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL).toMatch(/"valid_at": "<ISO-8601 date-time, only if the source text states when THIS ATOM'S OWN fact started/);
    expect(EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL).toMatch(/"invalid_at": "<ISO-8601 date-time, only if the source text states when THIS ATOM'S OWN fact stopped/);
  });

  it('states the conservative omit-by-default rule and the hallucination-is-worse-than-omission warning', () => {
    expect(EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL).toMatch(/Atom-level validity \(issue #205\)/);
    expect(EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL).toMatch(/Omit both by default/);
    expect(EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL).toMatch(/hallucinated invalid_at is worse than none/);
  });

  it('includes the life-timeline few-shot example and its omit-by-default negative counter-example', () => {
    expect(EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL).toMatch(/"invalid_at":"2025-07-13"/);
    expect(EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL).toMatch(/"valid_at":"2025-07-13"/);
    expect(EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL).toMatch(/NEGATIVE COUNTER-EXAMPLE/);
  });

  // UPDATE (temporal-grounding fix, 2026-07-13): captured_at IS now threaded
  // into the extraction call (05-extract.ts's extractChunk `sessionDateIso`
  // param, injected as an "Observation date: ..." line by callExtract — see
  // extract.ts's doc comment above EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL).
  // The prompt now points at that injected line FIRST, falling back to the
  // old conditional wording only when no sessionDateIso was available.
  it('states date grounding against the injected "Observation date" line first, falling back to the old conditional wording when no anchor was threaded', () => {
    expect(EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL).toMatch(/Date grounding/);
    expect(EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL).toMatch(/Observation date/);
    expect(EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL).toMatch(/if the transcript states or implies/);
    expect(EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL).toMatch(/keep the original relative phrasing/);
  });

  it('states the banned-abstractions negative list (vague summaries, meta-commentary, sentiment padding)', () => {
    expect(EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL).toMatch(/Banned abstractions/);
    expect(EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL).toMatch(/Vague summaries/);
    expect(EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL).toMatch(/Meta-commentary/);
    expect(EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL).toMatch(/Sentiment padding/);
  });

  it('explicitly does NOT apply the engineering profile\'s 300-800-char richness rule — conversational atoms stay atomic/short regardless of type', () => {
    expect(EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL).toMatch(/do NOT apply the engineering profile/);
    expect(EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL).not.toMatch(/300-800 characters/);
  });

  it('carries over the shared 7-type JSON output shape (same AtomSchema/EntityKindSchema contract validates every profile)', () => {
    for (const marker of ['"decision"', '"fact"', '"lesson"', '"command"', '"todo"', '"note"', '"event"']) {
      expect(EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL).toContain(marker);
    }
  });

  it('includes at least 3 few-shot examples plus a negative (WRONG vs RIGHT) example', () => {
    const exampleCount = (EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL.match(/^\d+\. /gm) ?? []).length;
    expect(exampleCount).toBeGreaterThanOrEqual(3);
    expect(EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL).toMatch(/NEGATIVE EXAMPLE/);
    expect(EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL).toMatch(/WRONG/);
    expect(EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL).toMatch(/RIGHT/);
  });

  // SLICE-433's context-budget standing rule (the v3 prompt's own truncation
  // bug — see ollama-llm.test.ts's "num_ctx sizing" describe block and
  // src/providers/llm/ollama.ts's NUM_CTX_CAP) applies to every extraction
  // profile, not just engineering: the real prompt + a real 800-token chunk
  // + the 2500 maxTokens output budget must fit within the 16384 num_ctx
  // cap, with room left for ollama.ts's own NUM_CTX_SLACK_TOKENS (512).
  it('fits the Ollama NUM_CTX_CAP (16384) alongside an 800-token chunk and maxTokens 2500 (SLICE-433 context-budget rule)', () => {
    const NUM_CTX_CAP = 16384;
    const MAX_TOKENS = 2500;
    const SLACK_TOKENS = 512;
    const CHUNK_TOKENS = 800;

    const promptTokens = EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL.length / CHARS_PER_TOKEN;
    const estimatedTotal = promptTokens + CHUNK_TOKENS + MAX_TOKENS + SLACK_TOKENS;

    expect(estimatedTotal).toBeLessThanOrEqual(NUM_CTX_CAP);
  });
});
