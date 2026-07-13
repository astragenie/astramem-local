# Review: SLICE-433 — Engineering-rich prompt v3 + type-conditioned richness + AtomSchema cap bump

**Reviewer**: independent correctness review (uncommitted working tree)
**Verdict**: **NEEDS_FIX** (one HIGH finding blocks; everything else is clean)
**Scope reviewed**: `src/distill/prompts/extract.ts`, `src/distill/stages/05-extract.ts`, `tests/distill/05-extract.test.ts`, `tests/distill/prompts/extract.test.ts`, `tests/pipeline/handlers/distill.test.ts`, `scripts/eval/extraction-bench/fixtures/fx43-rich-lesson-embed-cache-stampede.json`
**Tests run**: `bunx vitest run tests/distill/` → 174/174 pass. Full suite `bunx vitest run` → 243 files, 2923 passed, 6 skipped. `npx tsc --noEmit` → clean.

## HIGH — v3 prompt likely does not fit the local Ollama context window; no `num_ctx` override exists to compensate

`src/distill/prompts/extract.ts:364-521` (`EXTRACTION_SYSTEM_PROMPT_V3`).

Measured the v3 prompt text using the codebase's own chunking heuristic (`CHARS_PER_TOKEN = 4`, `src/distill/stages/03-chunk.ts:12`, the same constant the pipeline uses to size chunks):

- v3 system prompt: 15,294 chars / 2,229 words → **~3,824 tokens** (chars/4) to **~2,900 tokens** (words×1.3). Either heuristic puts it in the high-3-to-low-4k range.
- User chunk: target **800 tokens** (`TARGET_TOKENS`, `03-chunk.ts:15`), sometimes more since turn boundaries are respected over the target.
- `maxTokens` (Ollama `num_predict`) was bumped in this same diff to **2500** (`src/distill/stages/05-extract.ts:127`).
- Total needed: prompt (~2900-3824) + chunk (~800) + output (2500) = **~6200-7100 tokens.**

Team lead's prior live observation (`/api/ps`) put this repo's actual running `qwen2.5:7b` context length at **4096**. `grep -rn "num_ctx" src/` returns zero matches anywhere in the codebase — `src/providers/llm/ollama.ts:107-114` only ever sends `options.temperature` and `options.num_predict`; there is no code path that raises `num_ctx` above whatever Ollama/the model defaults to. So on the default local profile, the v3 system prompt **by itself** already consumes most-to-all of the observed 4096-token window, before the transcript chunk or any output room is counted at all.

This is very likely the real explanation for the builder's own smoke-test observation (3 atoms collapsed to 1, a lesson dropped) — not prompt phrasing pushing the model toward single-atom output. Ollama's default behavior when a request exceeds `num_ctx` is to silently truncate/shift context (typically dropping the oldest tokens first), which can chew into the system instructions themselves or truncate the model's own output mid-generation — exactly the kind of silent degradation that would show up as fewer/merged atoms with no error surfaced anywhere in the pipeline (`extractChunk` would see this as a clean 200 with a truncated/garbled JSON body, not a distinguishable failure mode).

This was flagged as the critical check in the review dispatch and it is real: v3 is a legitimate quality improvement for BYO-cloud models (D1's actual target per the design doc) but is very likely unusable as the **local Ollama default** in its current form, because nothing in this diff or the surrounding code raises `num_ctx` to cover it.

**Fix options** (pick one, does not require redesigning the prompt):
1. Pass `options.num_ctx` explicitly in `OllamaLLMProvider.chat` (`ollama.ts:107-115`) sized to cover prompt + chunk + `maxTokens` with headroom, at least for the extraction call.
2. Ship a compact v3 variant for the local/Ollama path (richness rule + self-containment rule kept, few-shot count trimmed) while keeping full v3 for BYO-cloud profiles, gated the same way `resolveExtractionPrompt` already gates v1/v2/v3.
3. At minimum: doctor WARN when the resolved prompt's estimated token count plus target chunk size plus `maxTokens` exceeds the provider's known/observed context window for local providers, so this doesn't fail silently in the field the way it just did in the builder's own smoke test.

Do not ship v3 as the unconditional default (`resolveExtractionPrompt`'s fallback branch, `extract.ts:219`) for the `ollama` provider until one of these lands — this is the exact "silent behavior collapse nothing calls out" failure class this repo has hit before (see `built-wired-never-invoked` pattern).

## Everything else checked — clean

1. **AC-5/AC-6 richness rule stated explicitly**: `extract.ts:388-405` states the type-conditioned rule as an instruction (300-800 chars for lesson/decision with claim+rationale+consequence+provenance; atomic/short for fact/command/todo/event/note), not left implicit. Few-shots are consistent with the rule — measured all example atom lengths: lesson/decision examples run 332-532 chars (within 300-800), fact/command/todo/event examples stay 28-167 chars (short/atomic), no "rich fact" example exists. Example 7 is a genuine negative (WRONG 48-char contextless-trivia todo vs RIGHT self-contained todo), matching the failure mode the rule targets.
2. **Taxonomy/priority/entity contract**: programmatically diffed the type-priority-order section and the skip-noise-through-empty-is-valid section between v2 and v3 — **byte-identical** except one whitespace-only line wrap in the `command:` bullet. v1→v2 does have real content differences (the module comment's "carried over unchanged from v1/v2" phrasing is slightly imprecise since v1≠v2, but v3 does match the more recent v2 exactly) — this is a documentation nit, not a functional issue, not worth a fix cycle on its own.
3. **AC-7 cap bump**: `AtomSchema.text` is `min(5).max(1000)` (`extract.ts:45`), correct and matches AC-7. Grepped the full repo for other `.max(500)`/length constraints near text/atom/memory content — found only two unrelated hits (`mcp/server.ts:638` is a numeric `limit` param cap for relationship-list pagination, `ingest.ts:78` is an array-length cap on canonical events) — neither constrains atom text length. `memories.text` is a plain SQLite TEXT column per CLAUDE.md, no migration needed. A 900-char atom has no other cap to collide with anywhere in extraction → storage → embed → sync → MCP output.
4. **AC-8 / D4 option (a)**: matches the design doc exactly (`docs/superpowers/specs/2026-07-13-memory-quality-design.md:36-39`) — rich multi-claim shape permitted only for lesson/decision, fact/command stay atomic, no structured-claim schema change. Stated explicitly in the prompt (`extract.ts:401-405`) and in the module comment, not left implicit.
5. **Precedence regression tests**: all four cases covered and correct in `tests/distill/prompts/extract.test.ts` — unset/undefined/`'engineering'` → v3 (new default); `ASTRA_EXTRACT_PROMPT=v2` → v2 (wins regardless of profile); `=v1` → v1 (new rollback lever, wins even under conversational profile); `profile==='conversational'` with no override → the pending-marker constant, asserted byte-identical to v1 and explicitly `not.toBe` v3. Mirrored correctly in `tests/distill/05-extract.test.ts` (thread-through) and `tests/pipeline/handlers/distill.test.ts` (handler-level).
6. **maxTokens 1500→2500**: justified by the diff's own comment and consistent with the richer output size v3 produces — the comment correctly notes this doesn't change per-call budget (cost is driven by provider-reported `usage.usd`, not the ceiling). Correct in isolation; the finding above is that this number is part of what makes local-model context overflow worse, not that the bump itself is wrong.

## Recommendation

Land AC-5/6/7/8 as-is (they are correct and well-tested). Before merging with `ollama` as the still-default local provider, resolve the context-window gap — either explicit `num_ctx` on the Ollama call, a compact local-profile variant, or a doctor guard that surfaces the mismatch instead of letting it silently degrade extraction quality the way the smoke test already showed.
