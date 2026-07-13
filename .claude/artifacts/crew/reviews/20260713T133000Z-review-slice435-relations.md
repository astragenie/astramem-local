# Review: SLICE-435 (FEAT-479 AC-11 / FEAT-481 SLICE-428 shared-schema half)

**Reviewer:** independent review agent
**Target:** worktree `C:\work\mega\astramemory-local\.claude\worktrees\agent-a228998ae6d15f8fb` (uncommitted, based on `main@a8744ac`)
**Verdict: PASS**

## Scope reviewed

6 files, +822/-20 (per `git diff --stat`):
- `src/distill/prompts/extract.ts` — `RELATION_PREDICATES`, `AtomRelationSchema`, `AtomSchema.relations?`, v3 prompt relations block + few-shots
- `src/distill/stages/05-extract.ts` — `filterAtomRelations` pre-parse filter
- `src/distill/stages/08-embed-index.ts` — name→id resolution + `EntityRelationRepo.insert` wiring
- `tests/distill/prompts/extract.test.ts`, `tests/distill/05-extract.test.ts`, `tests/distill/08-embed-index.test.ts`

Reference: `docs/specs/FEAT-481-design.md` §§0.1, 1, 2.1–2.5, 3, 6; `.claude/artifacts/loop/ai-loop/slices/pending/SLICE_435_*.md` AC-11.

## Findings by check

**1. AC-11 predicate enum exactness — PASS.** `RELATION_PREDICATES` (`extract.ts`) is `['uses', 'depends_on', 'replaces', 'supersedes', 'mentions', 'relates_to', 'part_of', 'owned_by', 'assigned_to', 'created_by']` plus `'other'` — byte-identical, same order, to the design doc §0.1/§2.4 list (which is itself verified against cloud's `IExtractionPipeline.cs` allow-list). No drift.

**2. No-hallucination guard / drop-not-coerce — PASS.** `filterAtomRelations` (`05-extract.ts:169-232`) checks, in order: object shape, missing subject/object/predicate, predicate membership in the closed set, `subject !== object`, then same-atom entity-name membership via `normalizeEntityName` on both sides. An unknown predicate is filtered out (`VALID_RELATION_PREDICATES.has(predicate)`), never remapped to `'other'` — the in-code comment correctly argues this diverges from `coerceEntityKinds`'s coerce-to-`'other'` behavior because `'other'` is already a real enum value here, and the design doc §2.3 ("a malformed triple ... is dropped from the array") supports drop-not-coerce. One bad relation never sinks the atom (`AtomSchema.safeParse` runs on the atom after filtering, not per-relation), and all seven drop paths log at `debug`, never throw. Confirmed by 9 targeted tests in `05-extract.test.ts` (unknown predicate, hallucinated subject, hallucinated object, self-relation, mixed valid+invalid in one atom, `'other'` accepted, case/whitespace normalization) — all pass.

**3. Stage-8 wiring — PASS.** Both `filterAtomRelations` (stage 5) and the stage-8 resolution loop (`08-embed-index.ts:241-242`) import `normalizeEntityName` from the same module (`src/entity/normalize.ts`), so there is no normalization-mismatch risk between the two stages. The `entityIdByName` map is built in the same loop that already upserts entities for this atom — no second lookup pass. `EntityRelationRepo.insert`'s dedup guard (atomic `INSERT...SELECT...WHERE NOT EXISTS`) is untouched by this diff (confirmed via `git diff` — zero changes to `src/storage/entity-relations.ts`). `evidenceMemoryId` is set to the atom's own `memoryId` from `insertWithCreateEvent`. Fallback chains are sane: `sourceExcerpt` falls back `relation.evidence ?? mem.evidence ?? mem.text.slice(0,500)` (matches design §2.1/§1); `confidence` falls back to the atom's own `mem.confidence` rather than the schema's `0.5` default — a defensible choice (a real per-atom signal beats a blind constant) though not explicitly specified in the design doc; `validFrom` falls back to `ctx.capturedAtMs ?? Date.now()`, the same expression used for the memory row's own `valid_from` a few lines above, so relation and memory timestamps agree. Unresolvable endpoints (`!subjectId || !objectId`) `continue` rather than throw, confirmed by the "skipped without throwing (defensive)" test.

**4. Additive compatibility — PASS.** `relations` flows through `AtomSchema` → `ReducedAtom` (extends `Atom`) → `NormalizedMemory` (extends `ReducedAtom`) via TypeScript's `extends` chain, so no edits were needed to `06-reduce.ts`/`07-memory-normalize.ts` — confirmed no diff on those files. A dedicated test proves an atom with no `relations` field is byte-identical to today (`relations` is `undefined`, not `[]`). The conversational prompt (`EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL`) is untouched (`git diff` shows zero occurrences of `CONVERSATIONAL` in the extract.ts diff), and a test explicitly asserts it contains no `"relations"` / `relations[]` text, consistent with design doc §2.5 scoping the addition to the engineering profile only.

**5. Context budget — PASS.** The updated tripwire test (`extract.test.ts`) computes `EXTRACTION_SYSTEM_PROMPT_V3.length / CHARS_PER_TOKEN + 800 + 2500 + 512` against a `16384` cap using the real, live prompt string (not a hardcoded/tautological number) — ran it in isolation and it passes, alongside the pre-existing SLICE-433 tripwire for the conversational prompt. The `16384`/`4`/`512` constants are duplicated from `src/providers/llm/ollama.ts` rather than imported, but that duplication pattern is pre-existing (SLICE-433's sibling test already does this) — not something this slice introduced, so not flagged as a new issue.

**6. Real test run:**
```
bunx tsc --noEmit -p .          → clean, no output
bunx vitest run tests/distill/ tests/storage/entity-relations.test.ts tests/mcp/entity-relations-conformance.test.ts
  Test Files  14 passed (14)
  Tests       235 passed (235)
  Duration    2.27s
```

**7. Supersession untouched — PASS.** `src/storage/memory-events.ts:307` already has `DELETE FROM entity_relations WHERE evidence_memory_id = ?` wired into `supersede()`'s transaction (landed in an earlier slice, SLICE-1/427 per the design doc) — confirmed via `git diff` that this file has zero changes in this worktree. This slice correctly did not need to touch it.

## Minor observations (non-blocking)

- `confidence: relation.confidence ?? mem.confidence` means the `entity_relations.confidence` column's own `DEFAULT 0.5` is effectively unreachable from this call site (every atom always has a `confidence`). Intentional and reasonable, just worth knowing if a future caller expects the schema default to ever apply here.
- Context-budget test constants (`CHARS_PER_TOKEN`, `NUM_CTX_CAP`, `NUM_CTX_SLACK_TOKENS`) are hand-duplicated in the test file rather than imported from `src/providers/llm/ollama.ts`. Pre-existing pattern, not introduced by this slice — low-value drift risk if `ollama.ts`'s constants ever change without the test being updated in lockstep.

## Verdict

**PASS.** No HIGH or MEDIUM findings. Predicate enum matches the design doc verbatim, the no-hallucination guard is correctly drop-not-coerce with consistent normalization across stages 5 and 8, additive compatibility is verified by tests (not just by inspection), the context-budget tripwire is a real computation, and supersession/erase cascade wiring was correctly left untouched. Real `tsc`/`vitest` output confirms everything above compiles and passes.
