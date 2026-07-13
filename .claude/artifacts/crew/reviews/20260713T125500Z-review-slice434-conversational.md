# Review: SLICE-434 (FEAT-479) — conversational extraction profile

**Reviewer:** independent review agent (dispatched by team-lead)
**Worktree reviewed:** `C:\work\mega\astramemory-local\.claude\worktrees\agent-ab8140f0f8a2dfc43` (branch `worktree-agent-ab8140f0f8a2dfc43`, based on `main` @ d751403), all changes uncommitted working-tree diff.
**Verdict: PASS**

## Scope verified

`git diff --stat` in the worktree:

```
 README.md                                  |   9 ++
 docs/configuration.md                      |  37 +++++
 src/cli/doctor.ts                          |   1 +
 src/config/config.ts                       |  25 ++-
 src/distill/prompts/extract.ts             | 134 +++++++++++++---
 src/doctor/checks.ts                       |  39 +++++
 tests/distill/05-extract.test.ts           |   8 +-
 tests/distill/prompts/extract.test.ts      | 103 +++++++++++--
 tests/pipeline/handlers/distill.test.ts    |   4 +-
 11 files changed, 486 insertions(+), 44 deletions(-)
```

Plus new untracked `tests/doctor/extract-profile-check.test.ts`. `.claude/state/*` diffs are automatic crew bookkeeping, out of review scope.

`git diff -- src/redact/` in the worktree returned **empty** — redaction module is confirmed untouched (AC-10).

## AC-9 (prompt content)

Read `EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL` in full (`src/distill/prompts/extract.ts`). All required elements are present as **explicit imperative instructions**, not just few-shot implication:

- Liberal extraction posture stated as its own labeled paragraph ("Liberal extraction (mem0 pattern)").
- 15-80 word self-contained sentence rule stated explicitly under "Self-containment", with concrete banned/required phrasing pairs ("Never emit... write the real names...").
- Possessor qualification labeled "Possessor qualification (Graphiti pattern)" with a worked example ("Sergey's daughter Alice...").
- Date grounding is conditional, matching the documented limitation (captured_at not threaded in): "if the transcript states or implies an explicit... date... If no such anchor appears anywhere... keep the original relative phrasing." This is honest about the real constraint rather than pretending grounding always works.
- Banned-abstractions negative list has three named categories (vague summaries / meta-commentary / sentiment padding), each with concrete bad-example phrases.
- The negative example (#5) is real and instructive: it shows a WRONG output that is vague, unresolved-pronoun, and meta-commentary, paired with a RIGHT output demonstrating the fix — not a token placeholder.
- Explicitly disclaims the engineering 300-800-char richness rule by name: "do NOT apply the engineering profile's 300-800-character rich-shape rule... every atom here stays atomic, single-valued, and roughly 15-80 words" with a stated rationale (personal facts get superseded, so atomic > rich-paragraph). This directly answers the reviewer brief's question and is not contradictory with the engineering profile's docs elsewhere.

No internal contradictions found. One minor 7B-model risk worth flagging as a **known limitation, not a defect**: the type-priority list (event > decision > todo > command > fact > note > lesson) is clear, but real conversational transcripts will sometimes plausibly match two types (e.g., "decided to move next month" is arguably both `decision` and `event`); the "stop at the first match" instruction resolves this deterministically for the model, so it is not ambiguous as *written*, even though a 7B model may not always apply the priority order consistently. This is the same class of instruction-following risk the engineering v3 prompt already carries and is called out honestly in the builder's own doc comment (see AC-6 below) — acceptable v1 scope.

## AC-10 (redaction unchanged + disclosure)

- `git diff -- src/redact/` empty — confirmed.
- Disclosure present in all four required locations and mutually consistent (same "secrets-only, never non-secret content, stays on-device unless a cloud LLM provider is configured for extraction" framing repeated verbatim in spirit across all four):
  - `src/config/config.ts:320-332` (doc comment on `distill.extractProfile`)
  - `docs/configuration.md` new `### distill.extractProfile` section, "Threat-model difference" paragraph
  - `README.md`, new paragraph under the redaction section
  - `src/doctor/checks.ts` `checkExtractProfile` — informational row, `ok: true` always (verified both in code and via `tests/doctor/extract-profile-check.test.ts`, which asserts `ok === true` for omitted/engineering/conversational and checks the message contains `not redacted` + `on-device` for the conversational case). No double-warn: engineering path returns a plain one-line message with no disclosure noise.

## Wiring / precedence (item 1)

`resolveExtractionPrompt` (`src/distill/prompts/extract.ts:311-320`): `envOverride === 'v2'` > `'v1'` > `profile === 'conversational'` > default `V3`. Matches the required precedence (env > per-transcript profile > config default > default), and per-transcript profile threading into `PipelineContext.extractProfile` is unchanged by this slice (it's `resolveExtractionPrompt`'s second parameter, threaded upstream, out of this diff's scope).

The SLICE-432/433 byte-identity pin for the engineering default is intact and still passing:
```
resolveExtractionPrompt(undefined, undefined) -> toBe(EXTRACTION_SYSTEM_PROMPT_V3)
resolveExtractionPrompt('engineering', undefined) -> toBe(EXTRACTION_SYSTEM_PROMPT_V3)
```
(`tests/distill/prompts/extract.test.ts:53-57`, unmodified by this slice's diff — confirmed via diff above, only the conversational-block tests changed).

## `_PENDING` tripwire replacement (item 2)

The old tripwire (`EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL_PENDING` aliasing `EXTRACTION_SYSTEM_PROMPT` verbatim) was **properly replaced with a real-divergence assertion**, not deleted or weakened:

```ts
expect(EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL).not.toBe(EXTRACTION_SYSTEM_PROMPT);
expect(EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL).not.toBe(EXTRACTION_SYSTEM_PROMPT_V2);
expect(EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL).not.toBe(EXTRACTION_SYSTEM_PROMPT_V3);
```

All three engineering variants are checked to guard against aliasing any of them — stronger than the original two-constant check.

## Context-budget test (item 3)

`tests/distill/prompts/extract.test.ts`, new `EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL content` describe block, last test: computes `promptTokens = EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL.length / CHARS_PER_TOKEN` and asserts `promptTokens + 800 (chunk) + 2500 (maxTokens) + 512 (slack) <= 16384`. Verified this is **not a tautology** by computing the real numbers from the built dist in the worktree:

```
conversational prompt: 9910 chars -> ~2477.5 tokens
estimatedTotal = 2477.5 + 800 + 2500 + 512 = 6289.5
margin to 16384 cap: 10094.5 tokens
```

Real computation, real margin — the assertion would actually fail if the prompt bloated by roughly another 40KB, so it's a meaningful regression guard, not decorative.

The previously-flagged stale `CHARS_PER_TOKEN` constant (`tests/distill/prompts/extract.test.ts:14`) **is wired**, not dead — used directly in the budget computation shown above. Not stale.

## Doctor check pattern (item 4)

`checkExtractProfile` (`src/doctor/checks.ts:1112-1140`) follows `checkDurabilityGateMode`'s established pattern exactly: takes the resolved mode/profile as a plain parameter (not re-reading config), returns `ok: true` unconditionally, wired into `coreChecks` via `opts.extractProfile ?? 'engineering'` (checks.ts:1497), and `DoctorCheckOpts.extractProfile` is optional with the same default-fallback convention as `durabilityGateMode`. Threaded end-to-end: `src/cli/doctor.ts:36` passes `cfg.distill.extractProfile` from `resolveRuntimeConfig` into `getChecks`. `tests/doctor/extract-profile-check.test.ts` is real (not a stub) — three cases (omitted/engineering/conversational), asserting both `ok` and message content.

## Test run (real output, executed in the worktree)

`bunx tsc --noEmit -p .` — **clean, zero errors.**

`bunx vitest run tests/distill/prompts/extract.test.ts tests/distill/05-extract.test.ts tests/pipeline/handlers/distill.test.ts tests/doctor/extract-profile-check.test.ts`:

```
 Test Files  4 passed (4)
      Tests  61 passed (61)
   Duration  1.02s
```

All 61 tests pass across the four touched/new suites. `dist/` was already built in the worktree so no rebuild was needed for tsc; ran a quick `node -e` against `dist/distill/prompts/extract.js` only to independently verify the token-budget numbers above (not part of the vitest run).

## Known limitations (item 6) — assessed as acceptable v1 scope, not blocking

- **7B model only partially honors possessor-qualification / 15-80-word rules on real prose.** This is an inherent LLM-instruction-following limitation, not a defect in the prompt or the wiring — the prompt states the rules unambiguously (verified above), which is the maximum the code layer can do. Acceptable to ship and iterate on with real eval data.
- **Date grounding is conditional because `captured_at` is never threaded into `extractChunk`.** Correctly and honestly documented in three places (the prompt's own doc comment, the prompt text itself, and a dedicated test asserting the conditional phrasing). This is scoped as a named follow-up, not a silent gap — acceptable v1 scope. Recommend a backlog follow-up FEAT to thread `PipelineContext.capturedAtMs` into `extractChunk` so date-grounding can fire unconditionally, but this does not block SLICE-434.

## Verdict

**PASS.** No blocking findings. Wiring, precedence, redaction non-interference, and disclosure are all verified against real test runs and real diffs, not just code reading. The two flagged limitations are honestly documented, scoped as follow-ups, and don't represent regressions or silent gaps.
