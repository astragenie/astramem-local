# Handoff — WS1 temporal date grounding (LoCoMo score plan)

**Objective:** Thread the session/observation date into extraction so relative
time expressions ("yesterday", "last year") resolve to absolute dates in atom
text — the highest-value item on the LoCoMo score-improvement board (~+7 pts
ceiling per the architect review, worst category at 12.4 F1).

**Owner:** builder (this run). **Status:** DONE — PR open, not yet merged.

**Deliverable:** https://github.com/astragenie/astramem-local/pull/189
(branch `feat/ws1-temporal-date-grounding`, commit `3502f97`, based on
`main` @ `d645e802`).

## Allowed / actual scope

Exactly the 3 files the architect design named:
- `src/distill/stages/05-extract.ts` — `extractChunk`/`extract`/`callExtract`
  gain an optional `sessionDateIso?: string` param; `callExtract` prepends an
  `"Observation date: <date>\n\n"` line to the user message when present.
- `src/distill/pipeline.ts` — formats `ctx.capturedAtMs` to an ISO calendar
  date (`YYYY-MM-DD`) and threads it into the stage-5 `extract()` call.
- `src/distill/prompts/extract.ts` — both the engineering (v3) and
  conversational date-grounding rules now point at the injected
  `Observation date` line first, falling back to the old
  in-transcript-anchor wording when no anchor was threaded (legacy v0.0
  envelopes, direct `/remember` calls — byte-identical for those callers).
- Plus test updates: `tests/distill/05-extract.test.ts` (new AC-6 suite),
  `tests/distill/prompts/extract.test.ts` (updated stale assertions).

**Forbidden scope respected:** did not touch `scripts/eval/locomo/answer.mts`
or its prompt (benchmark-integrity constraint). Did not add a migration. Did
not touch `valid_from`/bitemporal fields (already correctly populated,
untouched by design). Did not converge the date format on LoCoMo's gold-answer
phrasing (chose plain ISO-8601 for real memory-quality reasons per the
reviewer's tripwire).

## AC-7 finding (the important one — lead with this)

**Real production ingest (not just the eval harness) already carries a usable
per-session capture timestamp.** `src/capture/claude.ts`'s
`buildClaudeEnvelope` and `src/capture/proxy.ts`'s `buildProxyEnvelope` both
set `captured_at: new Date().toISOString()` at capture time, flowing through
the SAME path the eval harness uses (`ingest.ts` → `transcripts.captured_at` →
`distillHandler` → `PipelineContext.capturedAtMs`). It's coarser than LoCoMo's
per-session historical date (wall-clock capture time, not a backdated session
date) — but for live Claude Code / proxy sessions that IS a legitimate
real-time anchor. **This fix generalizes to real users, not only the
benchmark.** The only callers with no anchor at all are legacy v0.0 envelopes
and direct `/remember` calls — those correctly keep pre-fix behavior (the
AC-6 negative test covers this).

## Evidence

- `bunx tsc --noEmit` clean, `bun run build` clean.
- Full suite: `bunx vitest run` → **258 test files passed, 3217 tests passed,
  6 pre-existing skips, 0 failures.**
- AC-6 unit tests (`tests/distill/05-extract.test.ts`,
  `describe('sessionDateIso temporal grounding (2026-07-13 fix)')`): anchor
  `2023-05-15` + "yesterday" → atom text contains `2023-05-14`; "last week" →
  `2023-05-08`; "last year" → `2022`; "three years ago" → `2020`; a plumbing
  test confirming the `Observation date:` line reaches the LLM call; a
  negative test confirming no-anchor behavior is byte-identical to pre-fix
  (no injected line, relative phrasing preserved, no hallucinated date).
- Prompt-content tests updated to assert the new injected-line-first wording
  while keeping the fallback-wording assertions (both prompts still resolve
  conditionally when no anchor is available).

## Confidence / risks

- **High confidence** the plumbing is correct and safe — additive optional
  param, `undefined` preserves byte-identical behavior for every caller
  without a real anchor, full suite green.
- **Cannot be verified by unit test**: whether the actual LLM (qwen3:8b /
  qwen2.5-coder:7b locally, or whatever extraction provider is configured)
  reliably performs the date arithmetic the prompt now asks for. That is
  prompt-engineering/model-capability territory, validated only by the
  planned **full-sample LoCoMo rerun with WS1** (wave plan's "Wave 2" step) —
  not by anything in this PR.
- Per the architect review, treat "+7 pts" as an optimistic ceiling, not a
  committed target: ~1/3 of "when" gold answers are phrased relative to
  another date ("the week before 9 June 2023"), which token-F1 penalizes
  even when the underlying fact is correctly grounded; 3/37 genuine
  "how long ago" questions also need a reference date on the ANSWERER side
  (`answer.mts`) that this fix deliberately does not add (out of scope,
  would touch the frozen answerer).

## Safety compliance

Ran entirely via `vitest run` against `:memory:`/in-repo-fixture SQLite
instances created per-test (`openDb(':memory:')` + `migrate(db)`) — never
touched the default datadir, port 7777, or `%LOCALAPPDATA%\Astramem`. No
`serve`/`doctor`/`reinstall`/`init` invoked. No `git stash` used. Branch was
created, committed, pushed, and PR'd; HEAD was switched back to `main`
immediately after committing to avoid disrupting sibling agents sharing this
same checkout (see `worktree-agent-git-race` memory) — the commit is fully
preserved on `feat/ws1-temporal-date-grounding` regardless of local HEAD.

## Suggested next handoff

1. Merge PR #189 (or request review first, per the reviewer gate).
2. Wave 2 per the wave plan: full-sample LoCoMo rerun **with this fix** to
   get the real score delta and firm per-category n (also unblocks WS4's
   currently-too-thin n=13).
3. Run the WS2 diagnostic harness against the fresh post-WS1 run, not the
   stale pre-WS1 one — WS1 changes atom text broadly enough to shift
   single-hop lexical/embedding match.
