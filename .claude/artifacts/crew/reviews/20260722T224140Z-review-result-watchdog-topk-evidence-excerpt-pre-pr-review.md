---
findings: "🔴:0,🟡:0,❓:1"
status: completed
decision: approved
author_id: herolegion (branch commits, no worktree-agent id)
judge_id: crew:reviewer
self_approval: false
---
# Review Result: Review Result

- Created: 2026-07-22T22:50:03.434Z
- Reviewer: reviewer
- Decision: approved
- Status: completed
- Summary: PASS: all three residual commits (watchdog boot-grace fix 35e8f149,
topK 50->40 tune 8056d253, evidence-excerpt threading 75f1e648) are safe
to merge onto main. Independently re-read every diff against the actual
git history, re-ran the full targeted test matrix live in the branch
worktree, and confirmed no shipped default changed except
crossEncoder.topK (inside the still-disabled crossEncoder block, enabled
stays false end-to-end).
- Evidence Checked: -
- Files Reviewed:
  - src/service/watchdog-probe.ts
  - tests/service/watchdog-probe.test.ts
  - src/config/config.ts
  - src/search/onnx-cross-encoder.ts
  - src/search/onnx-rerank-registry.ts
  - src/search/search.ts
  - src/contracts/wire-hit.ts
  - tests/search/evidence-rerank.test.ts
  - docs/runbooks/cross-encoder-rerank.md
- Test Adequacy: Independently re-ran (not just trusted commit messages): npx vitest run tests/service/watchdog-probe.test.ts = 29/29 passed; npx vitest run tests/search/evidence-rerank.test.ts tests/search/rerank.test.ts tests/search/onnx-cross-encoder.test.ts tests/config = 20 files/332 tests passed; bunx tsc --noEmit -p tsconfig.json = 0 errors. Boot-grace scenarios (still-booting never-kill, hard-cap kill, threshold-preserved, legacy-state upgrade) are directly covered by named test cases, not just incidentally exercised.
- Author: herolegion (branch commits, no worktree-agent id)
- Judge: crew:reviewer
- Risks: One LOW non-blocking observation: evidence-excerpt precedence uses nullish-coalescing (evidence_span ?? evidence), so a hypothetical empty-string evidence_span would silently shadow a populated legacy evidence value; confirmed unreachable today since locate-evidence.ts only ever produces non-empty spans. No other residual risk identified.
- Required Follow-up: None required to merge. Optional follow-up already flagged in the commit's own message: reinstall.ts's 90s verify-health timeout has the same slow-boot blind spot the watchdog fix closed and needs its own companion fix (out of this review's scope).

