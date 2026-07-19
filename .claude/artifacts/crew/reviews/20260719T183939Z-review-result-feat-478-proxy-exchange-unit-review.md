---
findings: "[LOW] src/capture/proxy.ts:826-830 — A tool-use-only assistant reply (Anthropic content[] with only tool_use/thinking blocks, no text) still yields no assistant turn from extractResponseTurn (unchanged in this diff), so under the new gate the WHOLE exchange — including a brand-new, never-before-seen user question — is now silently discarded instead of the pre-fix behavior of spooling the question alone. This is not a new regression (the pre-fix orphan-question outcome was already negative value, and the original FEAT-478 report itself came from a real Claude Code session, i.e. a tool-use-heavy client), and it matches the documented AC-2 intent (\"reply that never parsed into a turn at all\"). But there is no unit test in this diff that specifically simulates a tool_use-only Anthropic response to lock in this consequence — worth a follow-up test, not a merge blocker.\n[LOW] Process note — FEAT-478's own triage doc records that the original bug was found only via live proxy traffic against a real Claude Code session, not by the existing unit suite. The new tests do exercise the real, unmocked createProxyCaptureTee/finishCapture path (confirmed by reading tests/capture/proxy.test.ts's 3 new cases) and reproduce the exact reported repro (5-char \"gzip.\" reply, minChars 8), so the specific regression class is now guarded. A short live-proxy smoke pass before/after merge would add confidence given the origin story, but is not required to approve since the touched surface (two-phase gating only) is fully exercised by the new unit tests and the untouched extraction functions (extractRequestTurns/extractResponseTurn/extractSseResponseTurn) are not implicated by this diff."
status: completed
decision: approved
author_id: fullstack-dev
judge_id: crew:reviewer
self_approval: false
---
# Review Result: Review Result

- Created: 2026-07-19T18:44:32.486Z
- Reviewer: reviewer
- Decision: approved
- Status: completed
- Summary: Approved: exchange-unit gating fix is correct, both rewritten tests strengthen intent, AC-3 regression guard verified against the real (unmocked) gating path, dedup ordering has exactly one write site post-decision. Two LOW residual notes, no blockers.
- Evidence Checked:
  - git diff main..HEAD read in full (src/capture/proxy.ts
  - relevance-gate.ts read for context/unchanged
  - tests/capture/proxy.test.ts
  - tests/capture/proxy-decompress.test.ts
  - tests/proxy/usage-storage-e2e.test.ts); independently re-ran bunx vitest run on all 3 test files -> 3 files
  - 72/72 passed (own run
  - not trusting handoff claim); independently ran bunx tsc --noEmit -p tsconfig.json -> clean; traced hash-recording ordering by hand (exactly one write site
  - proxy.ts:838-840
  - reached only after the gated.some(role==='assistant') check at line 830 passes
  - so no exchange's turns are ever recorded before the spool decision) confirming AC-4; confirmed AC-3's new test drives the real unmocked sink/finishCapture path with real chatRequestBody/chatResponseBodyNonStreaming helpers
  - not a mock; grepped src for other consumers of ProxyCaptureEnvelope/extractResponseTurn/extractRequestTurns -> only src/cli/proxy.ts
  - no downstream code assumes user-only envelopes or a fixed turns-per-envelope count; read FEAT-478.md backlog spec + prior handoff + prior typescript-reviewer artifact (independently verified
  - not deferred to).
- Files Reviewed:
  - src/capture/proxy.ts
  - tests/capture/proxy.test.ts
  - tests/capture/proxy-decompress.test.ts
  - tests/proxy/usage-storage-e2e.test.ts (src/capture/relevance-gate.ts read for context
  - unchanged in this diff)
- Test Adequacy: 3 new real-path tests (AC-1 too-short reply, AC-3 regression guard, AC-4 dedup-poisoning) plus 2 deliberately rewritten tests (AC-5) all pass against the actual unmocked gating code; 72/72 green across the 3 touched test files, independently re-run; tsc clean; bug-fix TDD/regression-test requirement satisfied.
- Author: fullstack-dev
- Judge: crew:reviewer
- Risks: LOW: tool-use-only assistant replies now fully discard the exchange incl. a new question, matching AC-2 intent but untested by an explicit tool_use-shaped case (see findings). LOW: no live-proxy smoke pass performed this review given the bug's live-traffic origin, though the fixed surface is fully unit-covered.
- Required Follow-up: Optional, non-blocking: add one test simulating an Anthropic tool_use-only (no text block) assistant response to explicitly lock in the whole-exchange-discard consequence; optionally run one live-proxy smoke exchange before/after merge given the bug's live-traffic discovery origin.

