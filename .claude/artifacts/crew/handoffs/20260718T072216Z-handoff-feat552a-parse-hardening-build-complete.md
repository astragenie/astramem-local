# Handoff — FEAT-552 sub-scope A (extraction parsing hardening)

## Objective
Implement AC-A1/A2/A3 of FEAT-552 ("deterministic hardening wave") sub-scope A:
JSON-truncation salvage, duplicate-key pre-parse detection, and the passB
evidence-compliance prompt fix — in isolation, in this worktree
(`C:\work\mega\astramemory-local-wtA`, branch `feat/552a-parse-hardening`,
base `98515925`).

## Owner
crew:fullstack-dev (this build).

## Allowed scope
`src/distill/stages/05-extract.ts`, a new parse util it calls, and
`src/distill/prompts/extract.ts`'s `EXTRACTION_SYSTEM_PROMPT_SPECIFICS_SWEEPER`.
No LLM calls added, no schema/wire changes, no migrations (per FEAT-552's
explicit out-of-scope list).

## Forbidden scope
Sub-scopes B (type-hints module + backfill CLI) and C (command-token merge
guard + fuzzy evidence matching) — separate worktrees per the FEAT-552
3-worktree wave design. Not touched here.

## Deliverable

### AC-A1 — JSON truncation salvage
New module `src/distill/stages/parse-salvage.ts` exports
`salvageTruncatedAtoms(jsonText: string)`: a bracket-depth-aware (not a full
parse) scanner that walks `"atoms":[...]`, collects every atom object that
closes cleanly, and marks a trailing unclosed object as "lost". Wired into
`tryParseAtoms` in `05-extract.ts` as a fallback that only runs AFTER the
normal `JSON.parse` + Zod path has already failed (or after a duplicate-key
detection, AC-A2) — the healthy first-try path never touches it.
`ExtractResult` gained an additive optional `salvage?: { recovered, lost }`
field, set only on the salvage path; a structured `extract_salvage` warn log
(recovered/lost/final_atom_count) is emitted alongside it via the existing
`childLogger({stage:'extract'})`.

### AC-A2 — duplicate-key pre-parse detector
Same module exports `detectDuplicateKey(jsonText: string): string | null` —
a lexer-lite scanner tracking one key-`Set` per open object scope (pushed on
`{`, popped on `}`), flags a string in "key position" (immediately followed
by `:`) that repeats within the SAME scope. Wired in BEFORE `JSON.parse` in
`tryParseAtoms`: a hit logs loudly and skips straight to the salvage
fallback rather than letting `JSON.parse`'s last-key-wins semantics silently
collapse the atom. `salvageTruncatedAtoms` also runs this check on each
individual reconstructed atom object, so a duplicate-keyed atom among
otherwise-clean siblings is excluded (counted as "lost"), not silently
collapsed either.

### AC-A3 — passB evidence-compliance prompt
`EXTRACTION_SYSTEM_PROMPT_SPECIFICS_SWEEPER` (`src/distill/prompts/extract.ts`)
restructured: `"evidence"` is now the FIRST field in the illustrated atom
schema (was 5th), an explicit **"ATOMS WITHOUT A VERBATIM EVIDENCE QUOTE ARE
DISCARDED"** warning was added, and all five non-empty few-shot examples now
carry a verbatim `"evidence"` quote (examples 2, 4, 5 previously omitted it
entirely, directly contradicting the prose rule — the likely root cause of
phi's measured 77% (165/191) evidence-field omission rate). Example 6
(small talk, empty output) is correctly exempt. No per-provider fork; the
shared prompt constant changed in place.

## Changed files
- `src/distill/stages/parse-salvage.ts` (new)
- `src/distill/stages/05-extract.ts` (tryParseAtoms rewritten with
  duplicate-key + salvage fallback; `runAtomFilterPipeline` extracted as a
  shared helper; `ExtractResult.salvage` field added)
- `src/distill/prompts/extract.ts` (sweeper prompt restructured)
- `tests/distill/stages/parse-salvage.test.ts` (new — unit tests for both
  util functions)
- `tests/distill/05-extract.test.ts` (new describe block: salvage recovery,
  byte-identical healthy path, severe-truncation-still-throws, duplicate-key
  detection, and the A1/A2 interplay case)
- `tests/distill/prompts/extract.test.ts` (new describe block: evidence-first
  schema ordering, discard warning present, all few-shot examples carry a
  verbatim evidence quote)

## Evidence
- `bun run build` — clean.
- `bunx vitest run tests/distill/` — **24 files, 556/556 tests passed** (no
  regressions; includes the pre-existing pinned invariant "no inline retry —
  worker owns retry policy", still exactly 1 LLM call per `extractChunk`
  call on every new test).
- `bun run typecheck:tests` (`tsc -p tsconfig.tests.json`) — clean.
- `bun run typecheck:eval` (`tsc -p tsconfig.eval.json`) — clean.
- `npx biome check` on all changed files — clean (exit 0).
- Tip commit: `91189291` on `feat/552a-parse-hardening` (local only, not
  pushed, per dispatch constraint).

## Confidence
High for AC-A1/A2 (deterministic, fully unit- and integration-tested against
hand-built raw-text fixtures reproducing the exact measured collapse/
truncation shapes). Medium-high for AC-A3: the prompt restructuring
addresses the measured contradiction (prose says required, examples showed
it omitted) but the FEAT body itself flags the live re-measure as a
follow-up requiring a GPU lane — this build only proves the string-level
contract via a mock-provider-equivalent prompt-content test, not a live
gate-drop-rate re-measurement.

## Risks / open questions
- AC-A3's "5-fixture mock bench run" gate-drop-rate re-measurement (named in
  FEAT-552's own success metric for A3) was explicitly out of reach here —
  no live LLM per the dispatch's GPU-busy constraint. Recommend a follow-up
  live re-measure once the GPU lane frees up, per the FEAT body's own note.
- `ExtractResult.salvage` is additive and NOT yet persisted to any DB table
  or doctor canary — unlike `relationDropCounts`/`entityDropCounts`/
  `evidenceDropCounts`, which get persisted per FEAT-481/207/485. This was a
  deliberate scope call (AC-A1 only asked for a structured log, not a new
  persisted counter/canary) — flagging as a candidate follow-up FEAT if
  salvage-rate observability in production becomes valuable (mirrors the
  "canary must measure rate, not existence" lesson already in this repo's
  memory).

## Suggested next handoff
Sub-scopes B and C proceed independently in their own sibling worktrees per
the FEAT-552 wave plan. When all three land, the slice-close ceremony
(`/runner:slice complete`) should run once per FEAT-552 (or per sub-scope,
if each is tracked as its own slice) — not performed here, out of this
build's scope.
