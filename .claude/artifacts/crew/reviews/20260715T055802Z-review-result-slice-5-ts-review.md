---
findings: "🔴:0,🟡:1,❓:3"
status: completed
decision: approved_with_notes
---
# Review Result: Review Result

- Created: 2026-07-15T06:02:21.346Z
- Reviewer: typescript-reviewer
- Decision: approved_with_notes
- Status: completed
- Summary: poolClsNormalize verified correct against transformers.js library source (slice(null,0)+normalize(2,-1), first-token-only, mask correctly unused); pooling resolution/threading/registry all correct and config-overridable; build+typecheck+40/6 tests all green — approved with 1 MEDIUM (tautological queryPrefix drift-guard test) and 3 LOW notes.
- Evidence Checked:
  - poolClsNormalize (onnx.ts:225-234) confirmed byte-for-byte equivalent to @huggingface/transformers feature-extraction.js:113-114 (case cls: result=result.slice(null
  - 0)) + normalize(2
  - -1) — verified against installed package source in the deps worktree
  - not just doc-comment claim. Test suite (onnx.test.ts:540-606) proves CLS ignores non-CLS tokens (deliberately poisoned token1/token2 values) and produces unit-norm output at prod dim 1024. Registry resolution order (config field ?? registryEntry?.x ?? DEFAULT_X constant) confirmed in constructor (onnx.ts:379-383); unregistered model falls back to DEFAULT_ONNX_POOLING='mean' without crash (optional chaining). mean-to-cls default flip is config-overridable via config.onnxEmbed.pooling and loudly documented in 3 files (config.ts
  - contracts/embed.ts
  - onnx.ts) — not silent. pooling threaded end-to-end providers/index.ts -> OnnxEmbedConfig -> constructor -> ResolvedOnnxLoadOpts -> loadTransformersBackend dispatch
  - not dropped. bge-m3 revision 4de13258303883538bd53b696b452bf8099f0858 is a full 40-hex pinned commit SHA (test regex-enforced)
  - not a floating tag. No default-provider flip: config.ts:955 embedding.provider default remains 'ollama'. Only 2 'any' casts exist
  - both preexisting-pattern with eslint-disable-next-line justification comments
  - no @ts-ignore. ESM .js extensions and import-type discipline (verbatimModuleSyntax) correct throughout. MEDIUM finding: tests/providers/embed/onnx.test.ts's 'stays in sync with QUERY_PREFIX_BY_MODEL' test is tautological — ONNX_MODEL_REGISTRY's queryPrefix field is itself computed as QUERY_PREFIX_BY_MODEL[key] ?? '' (onnx.ts:113
  - 134)
  - so the assertion compares a value against its own derivation and can never fail regardless of what QUERY_PREFIX_BY_MODEL contains; not a functional bug (no hand-typed duplicate exists so no real drift risk)
  - but mislabels itself as a drift guard when it structurally cannot catch drift — rename/reframe the test intent or replace with a lint-level check that no OTHER code hand-types a queryPrefix literal. LOW: src/providers/embed/onnx.ts grew from 366 to 532 lines (already over the 300-line file budget pre-S5
  - worsened by +166 lines) — consider extracting ONNX_MODEL_REGISTRY + OnnxModelRegistryEntry to a sibling module. LOW: docs/research/20260715-bge-m3-onnx-model-matrix.md is cited 4x in code comments as the evidence trail for the load-bearing cls-pooling-default claim but does not exist on commit 3ac3f00 or any other commit in repo history (git log --all shows zero history) — it is an untracked file sitting in the session-beta working tree only; the citation is currently a dead link for anyone checking out this commit cleanly. LOW: ResolvedOnnxLoadOpts (interface
  - onnx.ts:236-244) and OnnxEmbedConfig.loadBackend's inline opts parameter type (onnx.ts:332-340) are two hand-duplicated shapes kept in sync manually — preexisting pattern from S1/S2
  - S5 correctly added pooling to both
  - but the duplication itself remains a drift risk for a future field addition.
- Files Reviewed:
  - src/providers/embed/onnx.ts
  - src/contracts/embed.ts
  - src/config/config.ts
  - src/providers/index.ts
  - tests/providers/embed/onnx.test.ts
- Test Adequacy: bun run build: clean (0 errors). bun run typecheck:tests: clean (0 errors). bunx vitest run tests/providers/embed/onnx.test.ts: 40 passed, 6 skipped (46 total) — matches builder's claim. All run in the deps-installed worktree C:/work/mega/astramemory-local/.claude/worktrees/agent-a645d60ca24101e2b at commit 3ac3f00 (verified HEAD matches target).
- Risks: -
- Required Follow-up: -

