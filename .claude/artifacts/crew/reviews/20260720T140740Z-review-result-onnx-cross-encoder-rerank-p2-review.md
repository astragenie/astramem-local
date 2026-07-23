---
findings: "🔴:0,🟡:0,❓:0"
status: completed
decision: approved
author_id: worktree-agent-a200886867e9c7cbd
judge_id: crew:reviewer
self_approval: false
---
# Review Result: Review Result

- Created: 2026-07-20T14:12:13.311Z
- Reviewer: reviewer
- Decision: approved
- Status: completed
- Summary: PASS: enabled stays false, ONNX provider is lazily/memoized-constructed and never built when disabled, eval-harness default path is byte-identical, evidence hook is a verified no-op today, tsc+targeted vitest independently re-run green.
- Evidence Checked:
  - ## Verdict: PASS — safe to merge onto feat/retrieval-overhaul

### Risk point 1 — config default flip (HIGHEST RISK): CONFIRMED SAFE
- `defaultConfig().crossEncoder` = `{ enabled: false
  - provider: 'onnx'
  - topK: 50
  - timeoutMs: 1500 }` — `enabled` confirmed `false` (src/config/config.ts:1563
  - branch ref).
- `resolveRerankOpts()` (src/search/rerank.ts:253) short-circuits `if (!config.crossEncoder.enabled) return undefined;` BEFORE `buildCrossEncoderProvider` is ever called — the ONNX provider is never constructed when disabled
  - at either config-build or daemon-boot time (both `src/mcp/server.ts:134` and `src/server/routes/search.ts:196` call `resolveRerankOpts` once at server-factory time
  - guarded the same way).
- `OnnxCrossEncoderProvider`'s constructor does no I/O — model load is lazy + memoized inside `getBackend()`
  - triggered only by the first real `score()` call
  - which itself dynamic-imports `@huggingface/transformers` (mirrors `OnnxEmbedProvider`'s existing posture).
- Grepped every `.ts` file in `src/` on the branch for `crossEncoder.provider` — only two call sites: `writer.ts` (YAML serialization) and `rerank.ts`'s own gated builder. No other code branches on `provider` independent of `enabled`.
- Ran `tests/config/**` (267 tests) on the actual branch worktree: 825ms wall time
  - no network stall
  - all green — confirms hundreds of `defaultConfig()`-building tests are unaffected.

### Risk point 2 — shared eval-harness edits: CONFIRMED SAFE
- `oracle-factorial.mts`: `rerankFlag = get('--rerank') ?? 'off'`; when `'off'` (the omitted-flag default)
  - `makeIsolatedEvalEnv('oracle-factorial')` is called with `undefined` override — byte-identical call to pre-change code.
- `ab-baseline.mts`: same pattern
  - `rerank = get('--rerank') ?? 'off'`
  - forwarded verbatim; log line only adds `rerank=off` text
  - no behavior change.
- `spawn-daemon.ts`: only touched is the `EvalCrossEncoderOverride.provider` type union (widened `'mock'|'http'` → `'mock'|'http'|'onnx'`) plus a doc comment; `makeIsolatedEvalEnv`'s override-resolution body is untouched by this diff (confirmed via `git diff` hunk list — no changes to that function's logic).
- The RRF/relations tracks' locked cheap-recipe A/B is unaffected.

### Risk point 3 — offline-first degrade: CONFIRMED SAFE
- `loadTransformersCrossEncoderBackend` tries `resolveLocalSnapshotDir` first (offline
  - no network); falls through to `from_pretrained` hub download only if no local snapshot
  - logging a `warn`.
- Any load failure (network unreachable
  - model not cached) propagates as a rejected promise out of `score()`
  - which is caught by `applyRerank`'s try/catch (rerank.ts
  - catch block returns `hits` unchanged) — never crashes the daemon
  - never blocks the request. `backendPromise` is reset to `null` on failure so a later call can retry (tested: "a failed load is not memoized").
- Since `enabled: false` ships
  - this path is inert by default anyway.

### Risk point 4 — `buildRerankCandidateText` / evidence hook: CONFIRMED SAFE NO-OP
- `buildRerankCandidateText({text
  - evidence})` returns `text` unchanged when `evidence` is `undefined`
  - `null`
  - or `''` — verified both by reading the implementation and by the new test block (`tests/search/rerank.test.ts`
  - 4 cases incl. absent/null/empty-string). `SearchHit` (search.ts) does not populate `evidence` today
  - so this is a true no-op in production until a future change threads it through — exactly as claimed.

### Risk point 5 — general correctness / error handling / tests: PASS
- `applyRerank`'s whole-call try/catch fallback contract is preserved and correctly extended (evidence-augmented text construction happens inside the try
  - doesn't change the catch semantics).
- AbortSignal handling in `OnnxCrossEncoderProvider.score()` is checked between batches (documented honest limitation: won't interrupt an in-flight `run()` call) — consistent with `OnnxEmbedProvider`'s existing contract
  - not a regression.
- New dependency: none — `@huggingface/transformers` was already a `package.json` dependency (used by `OnnxEmbedProvider`); no `package.json`/lockfile diff
  - no CVE-audit gate needed.
- Config YAML round-trip: `writer.ts` emits `crossEncoder.onnx.*` fields only when set (matches existing `onnxEmbed` discipline); reader side relies on the pre-existing generic `deepMerge` in `loader.ts` (unchanged
  - not touched by this diff) rather than field-specific parsing — consistent with how every other nested provider-config block in this repo already round-trips.
- Independently ran (not just trusted the builder's self-report):
  - `bunx tsc --noEmit -p tsconfig.json` on the branch worktree → clean
  - zero output.
  - `bunx vitest run tests/search/onnx-cross-encoder.test.ts tests/search/rerank.test.ts` → 59/59 passed
  - 604ms
  - log lines confirm the fake-backend DI seam is used throughout (no `@huggingface/transformers` import triggered
  - no network).
  - `bunx vitest run tests/config/` → 267/267 passed
  - 825ms.
- Test adequacy for the new provider is strong: sigmoid math
  - batching
  - memoization
  - abort-between-batches
  - failed-load-not-memoized/retry
  - registry resolution chain
  - and the `buildRerankCandidateText` no-op cases are all directly tested via the DI seam — no network/model dependency in any test.

### Minor observations (non-blocking
  - no findings raised)
- `preload()` is added but intentionally not wired into `serve.ts` boot — explicitly documented as future/out-of-scope; consistent with "enabled: false ships" posture.
- Doc comments are unusually dense but accurate against the code read; spot-checked against actual line behavior
  - no drift found.

No CRITICAL / HIGH / MEDIUM findings. No LOW findings worth blocking on either — this is a clean
  - well-tested
  - correctly-gated addition.
- Files Reviewed:
  - src/search/onnx-cross-encoder.ts
  - src/search/onnx-rerank-registry.ts
  - src/search/rerank.ts
  - src/config/config.ts
  - src/config/writer.ts
  - scripts/eval/shared/spawn-daemon.ts
  - scripts/eval/locomo/oracle/oracle-factorial.mts
  - scripts/eval/locomo/oracle/ab-baseline.mts
  - docs/runbooks/cross-encoder-rerank.md
  - tests/search/onnx-cross-encoder.test.ts
  - tests/search/rerank.test.ts
- Test Adequacy: Independently re-ran (not just trusted builder report): tsc --noEmit clean; tests/search/{onnx-cross-encoder,rerank}.test.ts 59/59 green via network-free DI backend seam; tests/config/** 267/267 green in 825ms confirming no network/model dependency leaks into defaultConfig()-building tests.
- Author: worktree-agent-a200886867e9c7cbd
- Judge: crew:reviewer
- Risks: none blocking — preload() not wired into serve.ts boot is an explicit, documented future scope item, not a regression
- Required Follow-up: none — safe to merge onto feat/retrieval-overhaul

