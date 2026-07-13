# Review: SLICE-432 — Prompt architecture + extractProfile config/envelope surface

**Reviewer:** independent correctness review (uncommitted working tree)
**Scope:** FEAT-479 AC-2, AC-3, AC-4 (config surface, envelope surface, per-run prompt resolution + precedence)
**Verdict: PASS** (one MEDIUM test-coverage gap, one LOW scope note, one LOW cosmetic nit — none blocking)

## Commands run

```
bunx tsc --noEmit -p .                                                          # exit 0, no output
bunx vitest run tests/config/ tests/distill/ tests/server/ \
  tests/storage/migrate.test.ts tests/storage/upgrade-path.test.ts              # 53 files, 725 tests, all passed
```

## AC-2 — byte-identical default, per-run resolution

Confirmed at both the pure-function and pipeline-wiring level:

- `resolveExtractionPrompt(profile, envOverride)` (`src/distill/prompts/extract.ts:196`) is a stateless function with no module-level cache. The old `ACTIVE_EXTRACTION_PROMPT` constant (resolved once at module load) is fully removed from `src/distill/stages/05-extract.ts`.
- `runPipeline` (`src/distill/pipeline.ts:132`) computes `resolvedExtractProfile` fresh inside the function body on every call: `ctx.extractProfile ?? ctx.config?.distill.extractProfile ?? 'engineering'`.
- `tests/distill/prompts/extract.test.ts:14-18` asserts `resolveExtractionPrompt(undefined/null/'engineering', undefined)` returns **the exact same object reference** as `EXTRACTION_SYSTEM_PROMPT` (`.toBe`, not `.toEqual`) — this is a real byte-identity proof, not just a content-equality check.
- `defaultConfig()` ships `extractProfile: 'engineering'`; `applyExtractProfileGovernance` falls back to `'engineering'` on any unrecognized value and logs a warning (`src/config/config.ts:650-668`), mirroring the existing `durabilityGate` governance pattern. Both the pure function and the real `loadConfig`/`loadConfigFromDisk` boot paths are tested (`tests/config/config.test.ts`, `tests/config/loader.test.ts:367-389` — real config.yaml string parsed through `loadConfigFromDisk`).

AC-2 is solid.

## AC-3 — envelope field, additive, no wire break

- `CanonicalIngestSchema.extract_profile` is `z.enum(['engineering','conversational']).optional()` (`src/server/routes/ingest.ts:105`) — additive, garbage value → 400, confirmed by test (`tests/server/ingest.test.ts`, new "invalid value... returns 400" case, ran green).
- Migration 028 (`migrations/028-extract-profile.sql`) is a single additive nullable `ALTER TABLE transcripts ADD COLUMN extract_profile TEXT` — no CHECK constraint (validated at the zod boundary, same rationale as 026's `proxy_usage_json`), consistent with the 022/024/025/026 pattern. `SCHEMA_VERSION` bumped 27→28 (`src/server/lib/wire-meta.ts:136`); grepped the whole tree for hardcoded `27` stragglers — none found. Every test asserting the schema-version constant was updated (`migrate.test.ts`, `upgrade-path.test.ts`, `atom-v3.test.ts`, `entities.test.ts`, `entity-relations.test.ts`, `entity-validity.test.ts`, `version.test.ts`, `ingest-e2e.test.ts`) and all pass, including `upgrade-path.test.ts`'s populated-DB (schema-v12 fixture) upgrade path reaching v28.
- Same `CanonicalIngestSchema` instance runs on both the direct `/ingest/transcript` route and the spool-drain worker (confirmed by code comment at `ingest.ts:333` and the shared parse call) — so the wire-level plumbing is identical for both producers.
- **Gap worth flagging (LOW, non-blocking):** the only envelope *builder* in the repo for the auto_capture/hook_close spool path, `buildClaudeEnvelope` (`src/capture/claude.ts:136`), has no parameter for `extract_profile` at all — every Claude-hook-captured transcript can only ever get `extract_profile = NULL` on the transcripts row, regardless of intent. AC-3 is satisfied as literally written (wire schema supports it, additive, no break), and the config-level `distill.extractProfile` default still lets an operator flip the whole daemon to `'conversational'` globally. But per-transcript override is unreachable from the one capture path this repo ships a builder for — only a caller that speaks the wire protocol directly could ever set it today. Worth a one-line note to the operator/design doc if per-ingest granularity from hook-tap captures was the intended use case (conversational profile's most natural consumer is exactly casual hook-captured chat).

## AC-4 — env var still wins

- `resolveExtractionPrompt` checks `envOverride === 'v2'` first, before the profile branch — confirmed by both the pure-function tests (`tests/distill/prompts/extract.test.ts:31-37`, env wins over both `'engineering'` and `'conversational'`) and the stage-level test (`tests/distill/05-extract.test.ts`, env=v2 set mid-test, called with an explicit `'conversational'` profile, asserts `EXTRACTION_SYSTEM_PROMPT_V2` was sent). Preserves the exact pre-existing `ASTRA_EXTRACT_PROMPT=v2` a/b lever semantics.

## Per-job resolution / no cross-job caching

No caching exists to fail — `resolveExtractionPrompt` takes profile + env as plain arguments with no closures over prior calls. `tests/distill/05-extract.test.ts`'s four sequential tests in one process (no-arg default → explicit `'conversational'` → env=v2 override → two-chunk array call) exercise back-to-back calls with different resolved prompts in the same process, which is the practical version of "two transcripts in one worker get different prompts."

**Gap (MEDIUM, non-blocking):** there is no test at the `distillHandler` → `PipelineContext` → `runPipeline` integration layer that inserts two transcripts with *different* `extract_profile` DB column values and asserts the actual system prompt sent to the LLM differs between them end-to-end. The scaffolding for exactly this was added — `tests/pipeline/handlers/distill.test.ts`'s `insertCanonicalTranscript` helper gained an `extractProfile` parameter (default `null`), and the file imports `EXTRACTION_SYSTEM_PROMPT` and `EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL_PENDING` — but neither import is ever referenced again in the file body (grepped: only appear in the import statement), and every call site of `insertCanonicalTranscript` omits the new parameter (stays `null`). So the wiring in `src/pipeline/handlers/distill.ts:47` (`extractProfile: transcript.extract_profile ?? null`) that carries the column into `PipelineContext` is exercised by no test — it's correct by code inspection and by the fact the two adjacent layers (HTTP route → DB column, and pipeline → LLM call) are each independently well-tested, but the middle link connecting them was scaffolded and then left unasserted. Recommend closing this before the slice is called fully done, or explicitly deferring with a comment.

## Precedence placement / architecture

- Config, envelope, pipeline threading, and prompt-registry stub (`EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL_PENDING`) all match design doc §3.2 exactly: "Replaces module-load env-var prompt selection with per-run resolution (`ASTRA_EXTRACT_PROMPT` kept as override)."
- The `EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL_PENDING` alias-to-engineering-prompt placeholder is deliberately self-documenting and has an explicit pinning test (`tests/distill/prompts/extract.test.ts:28`, `expect(EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL_PENDING).toBe(EXTRACTION_SYSTEM_PROMPT)`) that will fail the moment SLICE-434 lands real content — good design, confirmed zero behavior change today and an informative future failure.

## Scope

Diff file list matches the slice's declared architecture/plumbing scope exactly: `src/config/{config,loader,writer}.ts`, `src/distill/pipeline.ts`, `src/distill/prompts/extract.ts`, `src/distill/stages/05-extract.ts`, `src/pipeline/handlers/distill.ts`, `src/server/lib/wire-meta.ts`, `src/server/routes/ingest.ts`, `migrations/028-extract-profile.sql`, plus matching test files. No AtomSchema cap bump (correctly deferred to SLICE-433 per the AC scope mapping), no relations[] field, no prompt-content changes. Other modified files in git status (`grades.jsonl`, `learnings.jsonl`, `slice-progress.md`, `workflow-state.json`, `grade-trend.json`, checkpoint-cadence/cost-hygiene state) are loop-harness bookkeeping, not code scope.

## Minor nit (LOW, cosmetic)

`tests/storage/entity-relations.test.ts:103`'s test title still says `'DB max schema version is 27 after migration'` while the assertion (correctly) now checks `28`. Pre-existing drift pattern in this file family (`atom-v3.test.ts`/`entities.test.ts` titles already said "26" while checking 27, before this diff) — not introduced by this slice for those two, but this one specifically was in sync before (27/27) and is now out of sync (title 27, value 28) as a side effect of the mechanical bump. Cosmetic only, doesn't affect correctness.

## Findings summary

| Severity | Location | Finding |
|---|---|---|
| MEDIUM | `tests/pipeline/handlers/distill.test.ts` | Imports `EXTRACTION_SYSTEM_PROMPT`/`EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL_PENDING` and adds an `extractProfile` param to the transcript-insert helper, but never exercises either — no end-to-end test proves the transcripts.extract_profile column actually reaches the LLM call via distillHandler → PipelineContext → runPipeline. |
| LOW | `src/capture/claude.ts:136` (`buildClaudeEnvelope`) | No parameter for `extract_profile` — every hook-captured transcript is permanently NULL on that column; per-transcript override is unreachable from this repo's one shipped capture-envelope builder. Config-level default still covers the global-toggle use case. Worth confirming intent with design, not a defect against AC-3 as scoped. |
| LOW | `tests/storage/entity-relations.test.ts:103` | Test title says "27" while asserting 28 (mechanical version-bump side effect). Cosmetic. |

No correctness bugs found in the shipped code paths. `tsc --noEmit` clean, all 725 targeted tests pass.
