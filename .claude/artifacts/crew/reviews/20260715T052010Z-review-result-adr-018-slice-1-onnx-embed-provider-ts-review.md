---
findings: "🔴:0,🟡:2,❓:0"
status: completed
decision: approved_with_notes
---
# Review Result: Review Result

- Created: 2026-07-15T05:23:54.297Z
- Reviewer: typescript-reviewer
- Decision: approved_with_notes
- Status: completed
- Summary: OnnxEmbedProvider S1 skeleton is TS-sound: tsc --noEmit clean (both tsconfig.json and tsconfig.tests.json), 22/22 fake-backend tests pass, dim-assert/lazy-memoized-load/AbortSignal-between-texts/pooling-mask-exclusion all correct and test-verified; two MEDIUM/LOW notes only, nothing blocking.
- Evidence Checked:
  - [MEDIUM] src/config/config.ts (onnxEmbed.dtype) + src/providers/embed/onnx.ts:34 (OnnxDType) — the 'q8'|'fp16'|'fp32' literal union is hand-duplicated in two files instead of config.ts importing OnnxDType (or a shared contracts/embed.ts-hosted type). Risk: a future dtype addition only updates one site
  - silently rejecting the new value at the other; config.ts already imports types from contracts/embed.ts and eval/eval-evidence.ts so cross-file type imports are an established pattern here. Fix: export an OnnxDType-equivalent from src/contracts/embed.ts (or re-export from onnx.ts) and have config.ts import it. | [LOW] src/providers/embed/onnx.ts:96 poolMeanNormalize — 'mean_pooling(output.last_hidden_state as any
  - attentionMask as any)' bridges the narrow OnnxTensorLike seam to the library's real Tensor type via 'as any' with an eslint-disable
  - rather than a narrower 'as unknown as Tensor'. Justified by comment (structural-subset seam
  - avoids hand-rolling pooling math) and the arithmetic itself is verified by a real test (padding-mask exclusion + unit-norm check against a real @huggingface/transformers Tensor) so runtime risk is low — cosmetic tightening only
  - not a defect. | [LOW] same fn — 'pooled.tolist() as number[][]' is an unchecked cast on library output with no runtime shape guard; acceptable given direct test coverage of this exact code path
  - but a defensive Array.isArray check would harden it further before S2 wires this into the live boot path. NOT FLAGGED (per dispatch scope
  - explicitly deferred to S2/S3 per ADR-018's own build-sequence table): startup preload absence
  - doctor probe absence
  - cosine geometry-parity gate absence. VERIFIED GOOD: EmbedProvider contract conformance (name/model/dim/queryPrefix/embed/health all correctly typed
  - dim-mismatch throws mirroring ollama.ts); QUERY_PREFIX_BY_MODEL correctly adds a distinct 'mxbai-embed-large-v1' key (not a silent-fallback risk — buildEmbedProvider resolves the prefix from config.embedding.model
  - and even the pre-existing 'mxbai-embed-large' key would resolve correctly if an operator left model unchanged
  - so RECALL-S1 asymmetry cannot silently drop to ''); pooling reuses library's own tested mean_pooling+Tensor.normalize(2
  - -1) and a hand-built test explicitly proves padding tokens (attention_mask=0) are excluded and output is unit-norm; dim is sourced from config/DEFAULT_EMBED_DIM (FEAT-409 SoT)
  - never hardcoded; lazy load is memoized synchronously (no thundering-herd race — check-and-set happens with no await in between) and a failed load correctly un-memoizes for retry (test-verified); AbortSignal checked between texts only
  - documented as a weaker guarantee than the HTTP providers
  - test-verified it stops before the next text's tokenize call; supply chain — onnxruntime-node/protobufjs/sharp added to package.json's trustedDependencies allowlist alongside the @huggingface/transformers dep
  - caret range (^4.2.0) matches this repo's existing pinning convention
  - HF model pinned by 40-char commit SHA never 'main' (test-verified via regex); no @ts-ignore
  - no non-null assertions added
  - no new enum
  - no barrel files
  - local imports correctly use .js extensions (ESM)
  - import type used for type-only imports.
- Files Reviewed:
  - src/providers/embed/onnx.ts
  - src/contracts/embed.ts
  - src/providers/index.ts
  - src/config/config.ts
  - tests/providers/embed/onnx.test.ts
  - tests/providers/_contract-suite.ts
  - package.json
- Test Adequacy: bun test tests/providers/embed/onnx.test.ts: 22 pass, 2 skip (ASTRA_TEST_ONNX_LIVE-gated), 0 fail; tsc -p . --noEmit: clean; tsc -p tsconfig.tests.json --noEmit: clean (run in worktree C:/work/mega/astramemory-local/.claude/worktrees/agent-acd60d96b9eab7a06 at commit d1cc7e8).
- Risks: -
- Required Follow-up: -

