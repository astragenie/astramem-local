---
type: handoff
feature: FEAT-547
slice: SLICE-441
from_agent: crew:fullstack-dev
to_agent: crew:reviewer (then crew:validator if scope requires)
worktree: C:\work\mega\astramemory-local-wt547
branch: feat/547-triage-v2
base: 51052874 (wave-1 merged tip, FEAT-551 evidence-gate already in stage-8)
tip_sha: c04c29fbd5cc7d355c56758978a353f1b97eebd1
created: 2026-07-18T03:54:45Z
---

## Objective

Extend FEAT-533's batched atom-triage tier (`src/distill/atom-triage.ts`,
shipped `mode: off`) from a single keep/junk verdict to three verdicts per
atom in the SAME batched LLM call: keep/junk (unchanged), `corrected_type`
(optional 7-class re-label, confidence-gated), and `evidence_supported`
(optional semantic evidence-support flag, queryable, never mutates/deletes).

## Owner

crew:fullstack-dev (this handoff). Coexists with FEAT-551's evidence-gated
sweeper already in `src/distill/stages/08-embed-index.ts` — read and did not
disturb it; the two gates run at their own established positions (Phase A
survivor filter vs. Phase B/C triage application) with no interaction.

## Allowed scope (per dispatch)

- `src/distill/atom-triage.ts` — schema/prompt/verdict extension.
- `src/distill/stages/08-embed-index.ts` — application/gating logic, coexisting
  with FEAT-551's evidence-gate block.
- New migration (054) extending FEAT-533's triage tables + a new `memories`
  column, mirroring the "extend, don't fork" pattern.
- `scripts/eval/extraction-bench/{run-bench.mts,lib/daemon-runner.ts}` —
  `--triage-model` flag (wiring + smoke only, no live LLM per constraint).
- Tests for all of the above, asserting real DB rows.

## Forbidden / out of scope (explicitly, per FEAT-547 spec)

- No new atoms, no rewriting atom text (labels/flags only).
- No default-mode flip — `distill.atomTriage.mode` stays `'off'` in
  `defaultConfig()`, untouched by this slice.
- AC-3's live phi-vs-qwen2.5:7b A/B bench run — measurement lane, NOT built
  here (GPU busy / no live LLM constraint). Only the `--triage-model` flag
  itself and its wiring were built + smoke-tested with mocks.

## Deliverable / what changed

**Core (`src/distill/atom-triage.ts`)**
- `CORRECTED_TYPE_LABELS` — the closed 7-class taxonomy (`decision|fact|
  lesson|command|todo|note|event`), matching `AtomSchema.type`
  (`src/distill/prompts/extract.ts`), NOT the wider 10-value `MEMORY_TYPES`.
- `CORRECTED_TYPE_CONFIDENCE_GATE = 0.8` — named constant per AC-2.
- `TriageVerdict`/`TriageVerdictSchema` — both new fields optional; a
  response omitting either parses unchanged (AC-1); a single malformed entry
  (bad `corrected_type` label, non-boolean `evidence_supported`) drops on its
  own without discarding sibling verdicts in the same batch (AC-6, reusing
  the existing per-entry safeParse loop — no new code needed there).
- `TriageableAtom.evidence?` — an atom's evidence quote now rides along in
  the batch call (`[index] text [evidence: "..."]`) so the model has
  something concrete to judge `evidence_supported` against; omitted
  entirely for an atom with none.
- `SYSTEM_PROMPT` — updated to describe both optional verdict fields,
  instructing the model to omit rather than guess.
- `maxTokens` budget bumped (40 -> 70 per atom) for the larger verdict shape.

**Application (`src/distill/stages/08-embed-index.ts`)**
- `correctedTypeApplied` / `evidenceSupportedApplied` gates computed per
  survivor: BOTH only ever apply in `atomTriageMode === 'enabled'`.
  `corrected_type` additionally requires `verdict.confidence >=
  CORRECTED_TYPE_CONFIDENCE_GATE`; `evidence_supported` additionally requires
  the atom to actually carry an `evidence` quote (defense in depth against a
  provider ignoring the "omit for no-evidence atoms" prompt instruction).
- `insertWithCreateEvent`'s `type`/`evidence_supported` fields use these
  gates — `'dry-run'` and `'off'` never override either (AC-5: dry-run logs,
  never rewrites).
- Post-insert observability block widened: a `'dry-run'` non-keep verdict OR
  either v2 signal is logged to `triage_guard_drops`; an `'enabled'`-mode
  `'keep'` verdict that carried an applied v2 signal is ALSO logged there
  (audit trail of what was actually applied — the early junk-drop branch in
  `'enabled'` mode already logs its own case and never reaches this point).

**Storage**
- `migrations/054-atom-triage-v2.sql` — extends `triage_guard_drops` with
  nullable `corrected_type TEXT` / `evidence_supported INTEGER` columns;
  adds nullable `memories.evidence_supported INTEGER` (tri-state, same
  convention as `consent_disclosed`). SCHEMA_VERSION auto-derives from the
  migrations directory — no hand-maintained bump needed. Self-heals via the
  existing `ALTER TABLE ... ADD COLUMN` regex scan
  (`src/storage/migration-self-heal.ts`) with zero extra wiring.
- `src/storage/triage-guard-log.ts` — `TriageGuardDropRow`/
  `recordTriageGuardDrops` extended with `correctedType?`/
  `evidenceSupported?`, both optional/nullable, backward-compatible call
  shape.
- `src/storage/memories.ts` + `src/contracts/memory.ts` — `InsertInput`/
  `Memory.evidence_supported` tri-state (`null`/`true`/`false`), same
  hydration pattern as `consent_disclosed`.

**Bench (`scripts/eval/extraction-bench/`)**
- `--triage-model NAME` (run-bench.mts) threads through to
  `runOllamaCandidate`'s new `opts.triageModel` (daemon-runner.ts), which now
  falls back to the extraction candidate model only when omitted — lets
  AC-3's future phi-vs-qwen2.5:7b-triaging-CODEX's-atoms A/B pin the triage
  model independently. Not exercised against a live daemon in this slice
  (constraint: GPU busy, no live LLM) — wiring only, config-string level.

## Changed files

- `src/distill/atom-triage.ts`
- `src/distill/stages/08-embed-index.ts`
- `src/storage/triage-guard-log.ts`
- `src/storage/memories.ts`
- `src/contracts/memory.ts`
- `migrations/054-atom-triage-v2.sql` (new)
- `scripts/eval/extraction-bench/run-bench.mts`
- `scripts/eval/extraction-bench/lib/daemon-runner.ts`
- `tests/distill/atom-triage.test.ts`
- `tests/distill/08-embed-index.test.ts`
- `tests/storage/triage-guard-log.test.ts` (new)

## Verification evidence

- `bun run build` — clean.
- `npx tsc -p tsconfig.tests.json` — clean.
- `npx tsc -p tsconfig.eval.json` — clean.
- `npx vitest run` (full suite, `ASTRA_SKIP_CONSOLIDATE` unset) —
  **5015 passed, 19 skipped, 0 failed, 380 files** (pre-existing baseline
  referenced as "721+" is exceeded; no regression from this slice's changes).
- Scoped: `npx vitest run tests/distill/ tests/config/` — 740 passed.
- New tests assert real DB rows (`triage_guard_drops.corrected_type`/
  `.evidence_supported`, `memories.type`, `memories.evidence_supported`) —
  not in-memory counters, per the FEAT-551 review-round lesson.

## AC checklist

- **AC-1** (schema backward-compat + per-entry fail-open): PASS —
  `tests/distill/atom-triage.test.ts` ("a response omitting BOTH optional
  fields parses successfully...", "parses corrected_type + evidence_supported
  when the provider supplies both").
- **AC-2** (confidence gate application + evidence_supported flag,
  never-mutate invariant): PASS — `tests/distill/08-embed-index.test.ts`
  ("a corrected_type verdict AT the confidence gate overwrites...",
  "evidence_supported is applied as a queryable flag... on an
  evidence-bearing atom only").
- **AC-3** (live phi-vs-qwen2.5:7b A/B bench measurement): **NOT DONE BY
  DESIGN** — explicit dispatch constraint (GPU busy, no live LLM; measurement
  lane, not this slice's). The `--triage-model` flag itself IS built and
  wired (run-bench.mts + daemon-runner.ts) so the live A/B can run when GPU
  frees up. Follow-up: run
  `bun scripts/eval/extraction-bench/run-bench.mts --atom-triage dry-run
  --triage-model phi4-mini` (and again with `qwen2.5:7b`) against a
  codex-extracted fixture set once the GPU is free.
- **AC-4** (dedicated typeAcc fixture test): PASS —
  `tests/distill/08-embed-index.test.ts` "AC-4: typeAcc over gate-applied
  corrected_type verdicts matches the fixture-derived expectation" — asserts
  the confidence-gate math directly against DB rows, not just recall.
- **AC-5** (mode 'off' byte-identical / 'dry-run' logs-never-rewrites):
  PASS — `tests/distill/08-embed-index.test.ts` "mode 'off': no
  corrected_type/evidence_supported fields are ever requested or parsed" and
  "mode 'dry-run': corrected_type and evidence_supported are LOGGED but never
  applied".
- **AC-6** (single malformed entry drops without discarding batch): PASS —
  `tests/distill/atom-triage.test.ts` "a verdict entry with an invalid
  corrected_type label is dropped on its own..." and the non-boolean
  `evidence_supported` sibling test.

## Confidence level

High for AC-1/2/4/5/6 (direct DB-row + unit-level evidence, full suite green,
zero regressions). AC-3 is explicitly a measurement lane deferred to a
follow-up dispatch once GPU capacity is available — flag/wiring built and
smoke-tested with mocks only, per the dispatch's own constraint.

## Risks / open questions

- `evidence_supported` gate applies whenever the atom has ANY evidence
  string, regardless of extraction pass — this is broader than FEAT-551's
  `extractionSource === 'passB'`-only evidence gate, which is intentional
  (FEAT-547's spec does not scope `evidence_supported` to passB only) but
  worth a second look if a future reviewer expects it scoped identically to
  FEAT-551.
- No new doctor canary was added for `corrected_type`/`evidence_supported`
  application rates — out of scope per dispatch (no mention in the FEAT-547
  spec of a canary requirement), but a natural follow-up once 'enabled' mode
  is ever considered for real traffic (mirrors the existing "Atom triage"
  canary's rate-not-existence discipline).
- `--triage-model` is daemon-HTTP-path only (same constraint `--atom-triage`
  itself already carries) — does not extend to the direct-pipeline
  azure:/openai:/codex: bench branches, which have no triage call at all
  today.

## Suggested next handoff

`crew:reviewer` for independent review of the diff, then `crew:validator` if
the reviewer flags any runnable-behavior surface needing exercise beyond the
unit/integration tests already in place. AC-3's live bench A/B is a separate
follow-up dispatch (measurement lane) once GPU capacity frees up.
