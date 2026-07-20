import { describe, it, expect } from 'vitest';
import {
  resolveExtractionPrompt,
  AtomSchema,
  EXTRACTION_SYSTEM_PROMPT,
  EXTRACTION_SYSTEM_PROMPT_V2,
  EXTRACTION_SYSTEM_PROMPT_V3,
  EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL,
  EXTRACTION_SYSTEM_PROMPT_SPECIFICS_SWEEPER,
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

  // WS4 (2026-07-13, LoCoMo score plan): the full-sample run proved a
  // resolved date written as ISO-8601 into `text` scores ~0 on the LoCoMo
  // scorer even when exactly correct (normalizeAnswer strips hyphens,
  // collapsing "2023-05-14" into one glued token) — 93% of the 115 ISO-dated
  // temporal answers in that run scored EXACTLY 0. `text` is prose read by
  // people/other models later, not the machine-parsed `valid_at`/
  // `invalid_at` fields, which correctly stay ISO-8601 (see the schema
  // description tests above/below — untouched by this fix). This test pins
  // the natural-language instruction so a future edit can't silently
  // reintroduce the ISO-8601 wording into the `text` grounding rule.
  it('instructs natural-language dates (not ISO-8601) for the grounded text field', () => {
    expect(EXTRACTION_SYSTEM_PROMPT_V3).toMatch(/natural-language\s+absolute date/);
    expect(EXTRACTION_SYSTEM_PROMPT_V3).not.toMatch(/resolve "yesterday".*to an absolute ISO-8601/s);
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

  // UPDATE (retrieval-overhaul Phase 6, 2026-07-20): this used to assert the
  // OPPOSITE — that the conversational profile deliberately did NOT get
  // relations[]. Codex's architecture review measured that omission as the
  // direct cause of the entity graph being near-empty (LoCoMo/personal
  // transcripts are overwhelmingly conversational-profile), so P6a extends
  // this profile with the SAME closed predicate enum the engineering (V3)
  // prompt already uses — see EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL's own
  // "Relations" section.
  it('adds relations[] to the conversational profile using the same closed predicate enum', () => {
    expect(EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL).toMatch(/"relations"/);
    for (const predicate of [
      'uses', 'depends_on', 'replaces', 'supersedes', 'mentions',
      'relates_to', 'part_of', 'owned_by', 'assigned_to', 'created_by', 'other',
    ]) {
      expect(EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL).toContain(predicate);
    }
    expect(EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL).toMatch(/MUST each be a name that ALSO appears in this/);
    expect(EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL).toMatch(/Possessor qualification/);
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

  // WS4 (2026-07-13, LoCoMo score plan) — same fix and same rationale as the
  // EXTRACTION_SYSTEM_PROMPT_V3 test above: this is the profile actually
  // used by the LoCoMo eval, and the full-sample run's own stored atoms
  // (241/2488, 9.7%) had an ISO-shaped date baked into `text` as a direct
  // result of this instruction's old "ISO-8601 form (YYYY-MM-DD)" wording.
  it('instructs natural-language dates (not ISO-8601) for the grounded text field', () => {
    expect(EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL).toMatch(/natural-language form/);
    expect(EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL).not.toMatch(/ISO-8601 form \(YYYY-MM-DD\) directly into the atom's text/);
  });

  it('states the banned-abstractions negative list (vague summaries, meta-commentary, sentiment padding)', () => {
    expect(EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL).toMatch(/Banned abstractions/);
    expect(EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL).toMatch(/Vague summaries/);
    expect(EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL).toMatch(/Meta-commentary/);
    expect(EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL).toMatch(/Sentiment padding/);
  });

  // WS3 (LoCoMo score plan, astramemory-local#269) — the sentiment-padding
  // carve-out's OPERATIVE test must be encoded in the rule itself, not just
  // demonstrated in an example. A prior draft of this fix wrote the rule as
  // "skip a mood with no named cause", which reads as "any mood WITH a named
  // cause survives" — a reviewer caught that this would let "the user was
  // frustrated with the build" (own mood, named cause) back in. The fix
  // makes the dividing line explicit: whose life the reaction is about, not
  // whether a cause is named. This test checks the PROMPT TEXT for that
  // exact boundary, not just the "Sentiment padding" label's presence —
  // the label-only check above passes whether the carve-out is narrow,
  // broad, or fully reverted, so it caught nothing about the boundary
  // itself. Live model-behavior coverage for this same boundary lives in
  // fx45 (scripts/eval/extraction-bench/fixtures-conversational/), run via
  // the extraction bench — this test can only check the instruction text,
  // not whether a model actually follows it.
  it('encodes "whose life" (not "named cause") as the sentiment-padding operative test, and gives an own-mood-with-named-cause counter-example', () => {
    expect(EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL).toMatch(/is NOT ["']does this mood have a named cause/);
    expect(EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL).toMatch(/frustrated with the build/);
    expect(EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL).toMatch(/whose life the reaction is about/);
    // The old wording is a strict prefix of "no named cause" alone with
    // nothing narrowing it further inline — assert the rule doesn't ship
    // with ONLY that phrase and no "whose life" framing anywhere near it.
    expect(EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL).not.toMatch(/skip a standalone mood observation with no named cause \(a person's own passing feeling, unattached to any specific event\)\. This does NOT cover/);
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

// invalid_at extraction gap (measured 2026-07-15: 0.14-0.5% fire rate,
// dominant failure mode a genuine prompt gap — see
// .claude/artifacts/crew/handoffs/20260715T050404Z-handoff-invalid-at-
// measure-sample-near-zero-rate-is-a-prompt-schema-.md). Real "used to X, no
// longer Y" cessations (drums, video games, a pet given up) never get
// invalid_at because the prompt required a literal ISO-8601 date the source
// text never states. FIX CHOSEN: approach (B), not (A) — the atom's own TEXT
// carries the cessation instead of the bitemporal field, because (1)
// invalid_at earns ZERO LoCoMo/retrieval points (the harness never sets
// as_of; only atom TEXT is read), and (2) approach (A)'s tempting shortcut —
// anchoring invalid_at to the capture/observation date "since the fact must
// be false by now" — is explicitly wrong modeling: a dateless cessation
// became false at an UNKNOWN PAST point, not at capture time, and baking in
// the capture date would be a subtler form of the exact hallucination class
// CLAUDE.md already warns against. Approach B has strictly LOWER hallucination
// surface than A: it touches only prose, never the bitemporal field, so
// there is no new way for a bound to be wrong.
describe('conversational prompt — dateless full-stop ("used to X, no longer Y") pattern', () => {
  it('names the dateless full-stop pattern and instructs writing cessation into text, not a bound', () => {
    expect(EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL).toMatch(/Dateless full-stop pattern/);
    expect(EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL).toMatch(/do NOT set\s+invalid_at for them/);
    expect(EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL).toMatch(/write\s+the\s+cessation directly into the atom's "text"/);
  });

  // The exact hazard this fix must not reintroduce: treating "the fact must
  // be false by now, so bound it to today" as conservative. It is not — it
  // silently claims a precise, false invalidation date for an event whose
  // real timing is unknown.
  it('explicitly forbids anchoring invalid_at to the capture/observation date for a dateless cessation', () => {
    expect(EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL).toMatch(/do NOT set invalid_at to the\s+observation\/capture date/i);
    expect(EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL).toMatch(/an unresolvable past point is not the same as today/);
  });

  it('distinguishes partial continuation from a full stop, and forbids treating a hedge as cessation', () => {
    expect(EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL).toMatch(/PARTIAL continuation/);
    expect(EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL).toMatch(/no\s+cessation language and no bound at all/);
  });

  it('includes both unambiguous-cessation few-shots (drums, dog) with invalid_at omitted', () => {
    expect(EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL).toMatch(/John used to play the drums/);
    expect(EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL).toMatch(/has not played them in years/);
    expect(EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL).toMatch(/Joanna used to have a dog named Tilly/);
    expect(EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL).toMatch(/gave her up after discovering she was allergic/);
    // Neither few-shot atom sets invalid_at — the point of the fix.
    expect(EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL).not.toMatch(/John used to play the drums[^}]*"invalid_at"/);
    expect(EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL).not.toMatch(/Joanna used to have a dog named Tilly[^}]*"invalid_at"/);
  });

  it('includes the partial-continuation WRONG/RIGHT counter-example (hiking) and its wrong atom has no invalid_at either', () => {
    expect(EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL).toMatch(/used to hike a lot when I was younger/);
    expect(EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL).toMatch(/still hikes when he can/);
    expect(EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL).toMatch(
      /"text":"Sergey used to hike a lot but no longer hikes\."/,
    );
  });

  // AtomSchema itself must still validate these text-only atoms (no
  // valid_at/invalid_at) exactly like any other unbounded fact — this is a
  // prompt-only fix, no schema or guard change.
  it('an atom with cessation encoded only in text (no invalid_at) still validates against AtomSchema', () => {
    const atom = makeAtom(
      'John used to play the drums all the time back in high school, but has not played them in years.',
    );
    const result = AtomSchema.safeParse(atom);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.valid_at).toBeUndefined();
      expect(result.data.invalid_at).toBeUndefined();
    }
  });
});

describe('conversational prompt — the exhaustiveness checklist is MECHANICAL, not an exhortation', () => {
  // WHY THIS TEST EXISTS.
  //
  // The prompt already said "capture EVERY durable personal fact... bias toward
  // extracting". A frontier model can act on that. A 4B model measurably cannot:
  // on the SAME prompt and the SAME LoCoMo conversations, codex extracted 7.7
  // atoms/session and qwen3.5:4b extracted 2.2 — a 3.5x deficit, with 93%
  // precision. It was not hallucinating. It simply was not finding things.
  //
  // "Bias toward extracting" is a vibe. "If you have fewer than 3, re-read" is a
  // check the model can actually execute. mem0 (prompts.py:907-915) and cognee
  // ("every single verb is an event") independently converged on the same trick:
  // convert exhaustiveness into a MECHANICAL RULE the model cannot quietly skip.
  //
  // This test exists so nobody later "tidies" these lines back into encouragement.
  // The specificity IS the feature.

  it('gives an EXPECTED COUNT, not an aspiration', () => {
    // A model can check itself against a number. It cannot check itself against
    // "be thorough".
    expect(EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL).toMatch(/5-15 atoms/);
    expect(EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL).toMatch(/FEWER THAN 3/);
  });

  it('gives a RE-READ trigger — a concrete action, not a feeling', () => {
    expect(EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL).toMatch(/re-read the transcript/i);
  });

  it('names first-topic-dominance and forbids it', () => {
    // The specific failure mode: the model spends all its attention on whatever
    // the conversation opened with. Naming an anti-pattern beats praising the
    // virtue it violates.
    expect(EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL).toMatch(/FIRST-TOPIC DOMINANCE/i);
  });

  it('sweeps the categories explicitly — each "yes" is a dropped fact', () => {
    expect(EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL).toMatch(/SWEEP THE CATEGORIES/i);
  });

  it('states the ASYMMETRY that justifies erring toward extraction', () => {
    // A marginal fact kept costs almost nothing. A real fact dropped is gone
    // forever — nothing downstream can recover it. That asymmetry is the whole
    // argument, and the model should be told it, not left to infer it.
    expect(EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL).toMatch(/gone forever/i);
  });

  it('does NOT weaken the existing anti-junk guards — recall must not cost precision', () => {
    // Pushing recall is only safe because precision was 93%. If a future edit
    // trades these away for more atoms, the pool fills with junk — and because
    // fuse.ts normalises over the candidate pool, junk actively perturbs ranking
    // rather than merely wasting space.
    expect(EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL).toMatch(/Banned abstractions/);
    expect(EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL).toMatch(/Vague summaries/);
    expect(EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL).toMatch(/Meta-commentary/);
  });
});

// Dual-pass extraction (opt-in, distill.extractionPasses: 2) — review fix
// (2026-07-14): the sweeper's #1 extraction category is DATES/TIMES, so it
// must carry the SAME date-grounding rule V3/CONVERSATIONAL both have.
// callExtract prepends the "Observation date: ..." line to pass B's user
// message exactly like pass A (05-extract.ts's promptOverride path is
// prompt-agnostic) — a sweeper that doesn't know what that line means would
// emit unresolved relative dates or bare ISO dates straight into `text`,
// which scores 0 on the LoCoMo temporal category (see the WS4 test above,
// same underlying finding).
describe('EXTRACTION_SYSTEM_PROMPT_SPECIFICS_SWEEPER content (dual-pass extraction)', () => {
  it('carries the 2026-07-18 brevity instruction (clerk speed tuning) — at most 8 atoms, compact text, no re-emission', () => {
    expect(EXTRACTION_SYSTEM_PROMPT_SPECIFICS_SWEEPER).toMatch(/BE BRIEF AND SELECTIVE/);
    expect(EXTRACTION_SYSTEM_PROMPT_SPECIFICS_SWEEPER).toMatch(/at MOST 8 atoms per chunk/);
    expect(EXTRACTION_SYSTEM_PROMPT_SPECIFICS_SWEEPER).toMatch(/Do NOT re-emit/);
  });

  it('states the same date-grounding rule V3/CONVERSATIONAL carry', () => {
    expect(EXTRACTION_SYSTEM_PROMPT_SPECIFICS_SWEEPER).toMatch(/Ground relative dates/);
    expect(EXTRACTION_SYSTEM_PROMPT_SPECIFICS_SWEEPER).toMatch(/Observation date/);
    expect(EXTRACTION_SYSTEM_PROMPT_SPECIFICS_SWEEPER).toMatch(/keep the original relative phrasing/);
  });

  it('instructs natural-language dates (not ISO-8601) for the grounded text field, mirroring V3', () => {
    expect(EXTRACTION_SYSTEM_PROMPT_SPECIFICS_SWEEPER).toMatch(/natural-language\s+absolute date/);
    expect(EXTRACTION_SYSTEM_PROMPT_SPECIFICS_SWEEPER).not.toMatch(/resolve "yesterday".*to an absolute ISO-8601/s);
  });

  it('its own few-shot example demonstrates a relative-date resolution, not an echoed-back relative phrase', () => {
    // The worked example resolves "last week" (given "Observation date:
    // 2026-07-10" prepended to the input, same shape callExtract produces)
    // into a natural-language absolute date INSIDE the atom's own text.
    expect(EXTRACTION_SYSTEM_PROMPT_SPECIFICS_SWEEPER).toMatch(/Observation date: 2026-07-10/);
    expect(EXTRACTION_SYSTEM_PROMPT_SPECIFICS_SWEEPER).toMatch(/accident on 3 July 2026/);
    // The OUTPUT atom text must not simply echo the unresolved relative
    // phrase back (the exact anti-pattern flagged in review).
    expect(EXTRACTION_SYSTEM_PROMPT_SPECIFICS_SWEEPER).not.toMatch(
      /"text":"Melanie's son got into an accident last week/,
    );
  });

  it('still names DATES/TIMES as its own category 1 — the rule above is not decoration', () => {
    expect(EXTRACTION_SYSTEM_PROMPT_SPECIFICS_SWEEPER).toMatch(/1\. DATES\/TIMES/);
  });
});

// FEAT-552 AC-A3: measured basis — phi omitted the "evidence" field 77%
// (165/191 gate drops) with the pre-fix prompt, which listed "evidence"
// fifth in the illustrated schema and — worse — showed THREE of its six
// few-shot examples emitting atoms with NO "evidence" field at all, directly
// contradicting the prose rule that it's required for every atom. This
// suite pins the fix: evidence-first schema ordering, an explicit discard
// warning, and every non-empty few-shot example actually demonstrating a
// verbatim evidence quote (so the examples reinforce the rule instead of
// undermining it).
describe('EXTRACTION_SYSTEM_PROMPT_SPECIFICS_SWEEPER evidence-compliance restructuring (FEAT-552 AC-A3)', () => {
  it('lists "evidence" as the FIRST field in the illustrated atom schema', () => {
    const schemaBlock = EXTRACTION_SYSTEM_PROMPT_SPECIFICS_SWEEPER.match(/\{\s*"atoms":\s*\[\s*\{([\s\S]*?)\}\s*\]\s*\}/);
    expect(schemaBlock).not.toBeNull();
    const firstFieldMatch = schemaBlock![1]!.match(/"(\w+)"\s*:/);
    expect(firstFieldMatch).not.toBeNull();
    expect(firstFieldMatch![1]).toBe('evidence');
  });

  it('states the explicit discard warning for atoms without a verbatim evidence quote', () => {
    expect(EXTRACTION_SYSTEM_PROMPT_SPECIFICS_SWEEPER).toMatch(
      /ATOMS WITHOUT A VERBATIM EVIDENCE QUOTE ARE DISCARDED/,
    );
  });

  it('every non-empty few-shot example atom carries a non-empty "evidence" field', () => {
    // Scope to the worked-examples section only (after the schema/prose,
    // whose illustrated "evidence" placeholder is not itself an example) so
    // nested entities[] braces inside an example atom don't confuse a
    // brace-counting regex. Six numbered examples; #6 deliberately emits
    // "atoms":[] and is exempt — there is nothing to quote for an empty
    // output. A prior version of this prompt had examples 2, 4, and 5
    // silently omit "evidence" despite the prose demanding it on every atom
    // — exactly the mixed signal the measured 77% omission rate points at.
    const examplesIdx = EXTRACTION_SYSTEM_PROMPT_SPECIFICS_SWEEPER.indexOf('Examples (illustrative only');
    expect(examplesIdx).toBeGreaterThan(-1);
    const examplesSection = EXTRACTION_SYSTEM_PROMPT_SPECIFICS_SWEEPER.slice(examplesIdx);

    const evidenceValues = [...examplesSection.matchAll(/"evidence":"([^"]*)"/g)].map((m) => m[1]!);
    // One evidence quote per non-empty numbered example (1 through 5).
    expect(evidenceValues.length).toBeGreaterThanOrEqual(5);
    for (const value of evidenceValues) {
      expect(value.length).toBeGreaterThan(0);
    }
  });

  it('example 6 (small talk) still legitimately emits no atoms at all — not a missed evidence case', () => {
    expect(EXTRACTION_SYSTEM_PROMPT_SPECIFICS_SWEEPER).toMatch(/hey how's it going\?[\s\S]*?"atoms":\[\]/);
  });
});
