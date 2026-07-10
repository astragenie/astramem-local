# Review Result — FEAT-452 (rerank provenance + observability + docs decision)

- **Branch**: feat/feat-452-rerank-exposure
- **Commit**: b95a554
- **Worktree**: C:\work\mega\astramemory-local-worktrees\feat-452
- **Diff**: `git diff origin/main...HEAD` — 6 files, +291/-10
- **review_decision**: **PASS**

## Scope

Additive rerank provenance surfacing (`reranked`/`rerank_score`/`explanation.signals.cross_encoder`)
distinct from the previously-overwritten `hit.score`, local observability (structured
outcome-tagged pino logs), a documentation-only note on `why_memory` non-rerank-awareness, and a
documented product decision (sidecar vs. embedded model). No new dependency, no contract schema
file change.

## Findings

No blocking or major findings. All six claims verified against source, tests, and a live test run.

### 1. `applyRerank` no longer overwrites `hit.score` — PASS
`src/search/rerank.ts:328-341`: `score` is left untouched by the object spread; `rerank_score` is
a new sibling field, sorted on (`b.rerank_score - a.rerank_score`) instead of `score`. Verified via
`tests/search/rerank.test.ts` (updated + 3 new FEAT-452 tests) and confirmed live with
`bun run vitest run`.

- Tail-beyond-topK path (`rerank.ts:308`, `tail = hits.slice(opts.topK)`): tail hits are
  concatenated unchanged (`[...reranked, ...tail]`) — no `RerankFields` spread onto them. Test:
  `tests/search/rerank.test.ts` "hits beyond topK (untouched tail) carry no rerank fields either" —
  asserts `reranked`/`rerank_score`/`explanation` all `undefined`. PASS.
- Whole-call fallback path (`rerank.ts:346-355`, `catch` block): returns the original `hits`
  array reference unmodified — no per-hit field addition anywhere in the catch branch. Test:
  "whole-call timeout fallback leaves hits completely unchanged" — `expect(result).toEqual(hits)`.
  PASS. Silent fallback is byte-identical to rerank-off shape.

### 2. Default byte-identical (crossEncoder.enabled=false) — PASS
`src/search/search.ts:533-536`: `if (opts.rerank) { ... applyRerank(...) ... }` — `applyRerank` is
never called when `opts.rerank` is `undefined`. `resolveRerankOpts` (`rerank.ts:236-238`) returns
`undefined` when `!config.crossEncoder.enabled`, which is the default. Zero new code executes on
the default path — confirmed by reading the guard directly, not just by doc comment.

### 3. Observability — PASS, no double-log / no swallow
`rerank.ts:321-323` logs `'rerank stage start'` once before the try. The `try` block logs exactly
one `'rerank stage complete'` (outcome: ok) on success; the `catch` block logs exactly one
`'rerank stage fallback to un-reranked order'` (outcome: timeout|error) on failure — single
try/catch, no path that logs both or neither. `RerankTimeoutError` (a bare `Error` subclass,
`rerank.ts:246-249`) is thrown only by `withTimeout`'s rejection and correctly distinguished via
`err instanceof RerankTimeoutError` (`rerank.ts:350`) from a provider-thrown plain `Error`. Live
test run shows exactly one start + one outcome log line per `applyRerank` call, matching this
repo's existing provider-logging pattern (`childLogger`, `latency_ms`, structured fields) used
elsewhere (`providers/llm/*`, `providers/embed/ollama.ts`).

### 4. `why_memory` deliberately NOT rerank-aware — PASS, doc-only
`git diff -- src/server/queries/provenance.ts` shows only added `*` comment lines (8 lines, all
prefixed `+ *` or `+`), zero code changes. Confirmed via line-filtered diff.

### 5. Tests — PASS
- `bun run build` (`tsc -p .`): clean, no errors.
- `bun run vitest run tests/search/rerank.test.ts tests/search/rerank-integration.test.ts
  tests/eval/retrieval-eval.test.ts`: **3 files passed, 51 tests passed**, ADR-005 floors held
  (retrieval-eval suite passed with no threshold regressions reported).
- The 2 pre-existing assertions updated in `rerank.test.ts` ("clamps out-of-range provider scores")
  previously asserted `a.score === 1` / `b.score === 0` — i.e. asserted the old in-place-overwrite
  behavior this slice deliberately removes. The update to assert `a.score` stays the fused value
  and `a.rerank_score` carries the clamped value is a correctness fix to match new intended
  behavior, not a weakening — the clamping behavior itself (`Math.min(1, Math.max(0, raw))`) is
  still fully exercised, just against the correctly-renamed field.
- Confirmed the known pre-existing unrelated failure: `tests/scripts/post-merge-rebuild.test.ts`
  fails with the same `SyntaxError: Invalid or unexpected token` in this worktree as reported on
  main — unrelated to this diff, ignored per instructions.

### 6. Contract shape match — PASS (with a scope note, not a defect)
`contracts/schemas/retrieval-result.v1.schema.json:54-67` defines the per-signal shape under
`hits[].explanation.signals.<name>` as `{ raw, weight, final }` (all `number`, all required,
`additionalProperties: false`). `RerankSignal` (`rerank.ts:266-273`) is exactly `{ raw: number,
weight: number, final: number }` — matches field-for-field, no extra keys, no schema file touched.
Note: `SearchHit.explanation` (`search.ts:107`) only carries `{ signals: { cross_encoder } }`,
without the hit-level `explanation.final` the full schema also requires — but `explanation` did
not exist on `SearchHit` at all before this diff (grep confirms no other production code builds a
full `ScoreExplanation` envelope today), so this isn't a regression introduced by this slice; the
full envelope-level contract conformance is pre-existing, out-of-scope work for whatever future
slice builds the wire-facing retrieval-result response. The claim as documented ("validates against
the shared retrieval-result contract's open signals map") is accurate as scoped and doesn't
overclaim full-envelope conformance.

## Verification commands run
```
git -C <worktree> diff origin/main...HEAD --stat
git -C <worktree> diff origin/main...HEAD -- src/search/rerank.ts src/search/search.ts src/server/queries/provenance.ts docs/runbooks/cross-encoder-rerank.md tests/search/rerank.test.ts tests/search/rerank-integration.test.ts
bun run build
bun run vitest run tests/search/rerank.test.ts tests/search/rerank-integration.test.ts tests/eval/retrieval-eval.test.ts
bun run vitest run tests/scripts/post-merge-rebuild.test.ts   # confirm known pre-existing failure only
```

## Verdict
**PASS.** No fixes required.
