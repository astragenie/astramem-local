---
findings: "🔴:0,🟡:1,❓:0"
status: completed
decision: approved_with_notes
---
# Review Result: Review Result

- Created: 2026-07-15T05:45:42.832Z
- Reviewer: typescript-reviewer
- Decision: approved_with_notes
- Status: completed
- Summary: S2 delta is clean: preload() is a correct idempotent thin wrapper over the existing memoized lazy load, serve.ts wiring never blocks boot and correctly attaches a rejection handler, the doctor check is additive and correctly tier-scoped, OnnxDType hoist has no duplicates/cycles, default stays ollama, build/typecheck/34 tests all pass — one MEDIUM doc-consistency note: ADR-018's stated boot-latency trade-off is now overridden for onnx users by background preload without an ADR addendum.
- Evidence Checked:
  - getBackend() sets backendPromise synchronously pre-await so preload()+embed() race is safe (no thundering herd); serve.ts preload wired after app.listen (line 308) at line ~331
  - gated !useMock && provider==='onnx' && dataDir!==':memory:'
  - uses void p.then(onOk
  - onErr) so rejection is handled not floating; doctor check gated instanceof OnnxEmbedProvider
  - tier:'full' correct because runFrequentDoctorChecks strips embedProvider unconditionally (schedule.ts) so a 'cheap' tier would never have run anyway; OnnxDType single declaration in contracts/embed.ts
  - re-exported from onnx.ts
  - imported by config.ts
  - no cycle; defaultConfig() still 'ollama' (config.ts:945); MEDIUM finding: docs/adr/ADR-018-onnx-embedding-provider.md:344-358 'lazy first-call
  - not eager boot' explicitly accepts 'the FIRST real embed call after boot pays session-load latency inline' as a stated trade-off — SLICE-2's serve.ts background preload now proactively pays that cost at boot for onnx-configured daemons
  - undoing the accepted trade-off without an ADR addendum documenting the change (class-level laziness in OnnxEmbedProvider itself is preserved — preload() is caller-invoked via serve.ts
  - not constructor-invoked); minor LOW style note: serve.ts:338 duck-types via 'as EmbedProvider & { preload?: () => Promise<void> }' guarded by typeof-check before invocation (safe
  - but instanceof OnnxEmbedProvider would be more direct given the block is already gated to provider==='onnx').
- Files Reviewed:
  - src/providers/embed/onnx.ts
  - src/cli/serve.ts
  - src/doctor/checks/onnx-embed.ts
  - src/doctor/checks/index.ts
  - src/contracts/embed.ts
  - src/config/config.ts
  - tests/providers/embed/onnx.test.ts
  - tests/doctor/onnx-embed-check.test.ts
  - docs/adr/ADR-018-onnx-embedding-provider.md
- Test Adequacy: bun run build: clean. bun run typecheck:tests: clean. vitest tests/providers/embed/onnx.test.ts + tests/doctor/onnx-embed-check.test.ts: 34 passed, 2 skipped (live-model tests correctly gated on ASTRA_TEST_ONNX_LIVE), 0 failed. Run in worktree C:/work/mega/astramemory-local/.claude/worktrees/agent-a207576d0ba544900 (has installed node_modules).
- Risks: -
- Required Follow-up: -

