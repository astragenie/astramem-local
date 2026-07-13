---
type: review
created: 2026-07-13T15:15:00Z
reviewer: independent (dispatched by team-lead)
scope: default Ollama LLM model swap qwen2.5:7b/qwen2.5-coder:7b -> qwen3:8b
verdict: NEEDS_FIX
---

# Review — qwen3:8b default swap (uncommitted, main checkout)

## Verdict: NEEDS_FIX

One HIGH-severity fabricated/misattributed benchmark number blocks this. Everything else
in the diff is sound — correct latent-bug fix, correct default propagation, tests/types
clean, honest "not yet benchmarked" framing for qwen3:8b itself. The problem is a
specific, wrong number attached to the *old* model, not the new one.

## [HIGH] Misattributed F1 number for qwen2.5-coder:7b, cited from a source that doesn't exist in this branch

`docs/providers.md:163` and `src/cli/init.ts:99-100` both say:

> "the 2026-07-13 proof-phase run measured it [qwen2.5-coder:7b] at F1 59-71%"

This is wrong, and traceable to a real but misattributed source. `docs/eval/20260713-extraction-proof-phase.md` does not exist anywhere in this checkout (not tracked, not untracked) — it only exists in the unmerged sibling worktree `.claude/worktrees/agent-ac72934b8fdc982ea` (commit `ede1a21`/`9300cfd`, PR #175, not an ancestor of this branch's HEAD). Reading that report's actual results table:

| Config | F1 range |
|---|---|
| qwen2.5-coder:7b + OLD prompt (v1) | 66%–66% |
| qwen2.5-coder:7b + NEW prompt (v3, current default) | 64%–71% |
| codex gpt-5.4-mini + v3 | 78%–80% |
| **codex gpt-5.5 + v3** | **59%–67%** |

qwen2.5-coder:7b's combined real range across both its configs is **64-71%**, not 59-71%.
The **59% belongs to gpt-5.5**, a completely different model/provider, not qwen2.5-coder:7b.
The comment mixes gpt-5.5's floor with qwen2.5-coder:7b's ceiling and presents it as one
number for the model being retired. This is exactly the class of thing the dispatch
instructions explicitly forbade ("no fabricated benchmarks... any invented number = HIGH") —
it's not invented from nothing, but it's factually wrong and was pulled from a report this
branch cannot even see, so nobody reviewing this diff on `main` can check it against source.

Fix: either drop the invented range entirely (the honest, defensible claim is just "not
installed on this box anymore, and separately no longer the default — see the 2026-07-08 A/B
benchmark for its actual measured F1 59%"), or wait until the SLICE-436 proof-phase work is
actually merged and cite it correctly with the real 64-71% qwen figure, not a number built by
splicing two different models' ranges together.

Contrast: the **qwen3:8b** side of both comments is handled correctly — "not yet benchmarked"
is stated plainly with no invented F1, matching the explicit boundary given to the builder.
Only the qwen2.5-coder:7b retirement note has the problem.

## Verified correct

**1. Latent tier-picker bug — real, and the fix is right.** Pre-diff `src/cli/init.ts:340`
(`promptSelect('Extraction model (Ollama):', choices, 'llama3.1:8b')`) pre-highlighted a
value that did not exist in `choices` (`git show HEAD:src/cli/init.ts` confirms the choices
array only ever contained `qwen2.5:7b`, `qwen2.5-coder:7b`, BYO-cloud, and custom — `llama3.1:8b`
was dropped from the curated list earlier and the pre-highlight default was never updated to
match). The new diff correctly points the pre-highlight at `qwen3:8b`, which is now actually in
the choices array. Confirmed real bug, correct fix.

**2. Default propagation is complete and consistent** across `src/config/config.ts` (both
`llm.compaction`/`llm.extraction`), `src/providers/llm/ollama.ts`'s constructor fallback,
`src/cli/init.ts`'s `defaultLlmModelFor`, the provider-choice label, and
`tests/config/writer.test.ts:138` (asserts the emitted YAML matches the new *default* — legitimate,
not historical evidence being rewritten).

**3. Historical/dated records genuinely preserved.** `qwen2.5:7b`'s real 2026-07-08 A/B stats
(F1 67%, precision 99%, ~21.6s/session) survive verbatim in both `init.ts`'s
`OLLAMA_EXTRACTION_TIERS` and `docs/providers.md`'s tier table — it's now labeled "previous
default" rather than removed, so the real measured numbers for the model that's staying
selectable are intact. `scripts/eval/extraction-bench/results/**`, `docs/eval/*.md`,
`docs/superpowers/**`, `docs/research/**`, and `src/distill/prompts/extract.ts` are untouched
(confirmed via `git diff --stat` and targeted greps) — the few-shot example
`"qwen2.5-coder:7b", not "the coding model"` at `extract.ts:579` and the dated observational
comment `observed 4096 for qwen2.5:7b` at `extract.ts:525` are both correctly left alone.

**4. The 3 judgment calls beyond the named list are correct, not overreach:**
- `scripts/eval/extraction-bench/run-bench.mts` and `README.md`: both files assert in prose
  that compaction is "held constant at ollama/qwen2.5-coder:7b (**the current production
  default**)". Since `daemon-runner.ts` (already in the named scope) changed its
  `COMPACTION_MODEL` constant to `qwen3:8b`, leaving these two files unedited would have made
  them self-contradicting with a file the builder was explicitly told to change, and would have
  left a false "current production default" claim in the bench's own docs. Updating them was
  necessary, not scope creep. `README.md` also does the right thing by explicitly noting the
  *historical* `results/` runs stay labeled against `qwen2.5-coder:7b`/`qwen2.5:7b` — it doesn't
  try to retcon old data.
- `docs/migration-from-saas.md:47`: the file uses present tense ("The wizard **asks**: ...")
  describing live `init` behavior, not a historical record — it's onboarding instructions for a
  *today* migration, so leaving it saying `qwen2.5-coder:7b` would actively mislead a new user
  running the real wizard right now. The content call was correct. Process note (LOW): this file
  was reportedly on the builder's own MUST-NOT-CHANGE list, and the builder edited one line anyway
  on its own judgment rather than flagging the apparent conflict between "don't touch this file"
  and "don't ship stale live docs" back to the dispatcher first. The outcome is right; the
  boundary-handling discipline is a little loose.

**5. Test suite and types clean, no regressions.** `bunx tsc --noEmit -p .` — clean, zero
output. `bunx vitest run` — **249/249 test files passed, 3038 passed / 6 skipped (3044 total)**
on this run (builder reported 3033; the small delta is consistent with normal box-load
variance, not a regression — I saw zero failures on a full from-scratch run, including the
real live-Ollama-calling tests such as `qwen3:8b` chat completions at 48.8s and 16.2s in the
log, so nothing here is being silently skipped).

## Gaps worth a follow-up (not blocking)

**[MEDIUM] `.github/workflows/README.md:121`** still states "`qwen2.5-coder:7b` — current
production LLM default (compaction/extraction)" — this is now false and was missed. Unlike
`nightly-live.yml`'s `OLLAMA_MODELS` (correctly left alone — it's genuinely pulling a model for
fixture-hardcoded tests like `tests/e2e/plugin-flow.test.ts` and
`tests/providers/ollama-llm.test.ts`, which reference the literal string `qwen2.5-coder:7b`
independent of the config default, so changing the pull list would be pointless churn), this
README line is prose describing "current production default" in the present tense, i.e. it's
making a live claim, not documenting fixture data. Worth a one-line fix in the same spirit as
the other docs touched here.

**[LOW] Silent risk-disclosure gap.** New/fresh installs now get `qwen3:8b` as the extraction
default sight-unseen, and it has never been through the extraction A/B harness. The diff *does*
handle this honestly in the wizard tier table and doc comments ("not yet benchmarked here —
operator-verified working extraction/compaction"), which is the right amount of disclosure for
a CLI tier picker. There's no doctor WARN row for "extraction model has no measured F1" and
none was added — reasonable to treat as a documentation-level disclosure rather than a runtime
gate, given `qwen2.5:7b` remains one click away and the docs are honest about it, but flagging
in case the operator wants a stronger signal (e.g. a doctor advisory) before this reaches other
users.

## Commands run

```
bunx tsc --noEmit -p .          # clean, no output
bunx vitest run                 # 249 files passed, 3038 passed | 6 skipped (3044)
```

## Summary

Fix the one HIGH item (`docs/providers.md:163`, `src/cli/init.ts:99-100` — drop or correct the
"F1 59-71%" claim for the retired `qwen2.5-coder:7b`) before this ships. Everything else —
the default swap itself, the latent tier-picker bug fix, historical-record preservation, and
the three off-list judgment calls — is correct and can stay as-is once that one number is fixed.
