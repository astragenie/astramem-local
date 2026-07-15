---
findings: "🔴:0,🟡:2,❓:1"
status: completed
decision: approved_with_notes
---
# Review Result: Review Result

- Created: 2026-07-15T07:16:17.534Z
- Reviewer: typescript-reviewer
- Decision: approved_with_notes
- Status: completed
- Summary: Existing-install safety confirmed sound (writer always emits embedding.provider; loader deepMerge lets on-disk value win over new default); 2 MEDIUM config-hygiene gaps found in init.ts/onnxEmbed, everything else clean and green.
- Evidence Checked:
  - MEDIUM: src/cli/init.ts buildConfig() (~line 661-687) spreads ...base (defaultConfig()
  - now carrying onnxEmbed:{dtype:q8
  - pooling:cls}) into every wizard-built config without resetting onnxEmbed for non-onnx choices -- an ollama/azure-openai init now writes a spurious onnxEmbed block to config.yaml (harmless at runtime per the 'ignored otherwise' doc comment
  - but untested and confusing; tests/cli/init.test.ts has no coverage of this). MEDIUM: config.onnxEmbed.numThreads (config.ts:119
  - providers/index.ts:111) has a safely-capped DEFAULT (Math.max(1
  - Math.min(4
  - cpus().length-1))) but the config-file OVERRIDE path is completely unclamped -- inconsistent with this repo's own NUM_CTX_CAP / contradiction-judge governance discipline
  - and relevant given #347's in-process-CPU-stall finding since this default-flip makes ONNX CPU inference in-process for every fresh install. LOW: DEFAULT_OLLAMA_EMBED_MODEL constant now doubles as the onnx default label (functionally correct -- resolves to 'mxbai-embed-large' matching the registry -- but the OLLAMA-prefixed name is misleading for a provider-agnostic use). VERIFIED SAFE (the critical item): writer.ts:197 unconditionally emits provider: cfg.embedding.provider for every written config.yaml; loader.ts deepMerge(base=defaultConfig()
  - parsed=on-disk file) applies parsed's keys over base for every key the file itself sets
  - so an existing install's literal 'provider: ollama' always wins over the new onnx default on upgrade -- no silent flip. checkOllama/Ollama-setup prompts correctly gated on === 'ollama' only (init.ts:328
  - 790)
  - onnx path skips them cleanly; non-interactive env override (ASTRA_MEMORY_INIT_EMBED_PROVIDER) still works with onnx as new default. writer.ts onnxEmbed emission matches the codexSubscription/azure conditional-field pattern
  - all 5 fields round-trip in the fully-populated fixture. Test edits (ollama->onnx assertion flips) are all genuine default-config assertions
  - not weakened explicit-provider tests. No any/@ts-ignore regressions (existing eslint-disable-justified 'as any' casts in onnx.ts pooling helpers predate this diff). No missed-case switches on the widened embedding.provider union -- providers/index.ts
  - init.ts
  - writer.ts all handle onnx explicitly.
- Files Reviewed:
  - src/config/config.ts
  - src/config/loader.ts
  - src/config/writer.ts
  - src/cli/init.ts
  - src/providers/embed/onnx.ts
  - src/providers/embed/onnx-registry.ts
  - src/providers/index.ts
  - src/cli/serve.ts
  - tests/config/config.test.ts
  - tests/config/writer.test.ts
  - tests/providers/embed/onnx.test.ts
- Test Adequacy: bun run build: clean. bun run typecheck:tests: clean. bunx vitest run tests/config tests/cli/init tests/providers/embed: 215/221 passed, 6 skipped, 1 unrelated flake (hook-idempotency test timed out at 5s under full-suite contention, passed cleanly in isolation).
- Risks: -
- Required Follow-up: -

