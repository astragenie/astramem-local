---
id: FEAT-418
status: triaged
priority: P2
created: 2026-07-04
updated: 2026-07-04
depends_on: []
slices: []
derived_from: test-inventory-2026-07-04
pm_customer_impact: 0.55
pm_effort_estimate: 0.45
pm_strategic_alignment: 0.60
pm_technical_risk: 0.40
pm_dependency_depth: 0.25
pm_effort_points: 5
composite_score: 0.57
composite_priority: P2
autonomous_safe: true
pm_demand_evidence: "Test-inventory review 2026-07-04: MCP is the only client surface (HTTP/CLI/MCP) with zero transport-level test coverage; FEAT-417 (parity params) is unit-level only and this is the harness those tests would eventually run through."
pm_scope_notes: "Reuse existing smoke sandbox helpers (temp datadir, env isolation, teardown) rather than building a parallel harness; scope to initialize + tools/list + 2-3 representative tool calls, not exhaustive tool-by-tool coverage in this slice."
pm_risks:
  - "stdio JSON-RPC framing/buffering can behave differently on Windows vs POSIX — must validate on the actual CI runner OS, not just locally."
  - "Child-process lifecycle (orphan on test failure) needs a hard teardown or CI runners accumulate zombie processes over time."
  - "Scope creep risk: don't let this slice balloon into full MCP tool-by-tool e2e coverage — that is incremental follow-on work, not this FEAT."
reasoning: "Real, if not yet incident-confirmed, coverage gap: MCP is a full client surface with zero transport testing, and this harness unblocks future MCP e2e work. Kept at P2 rather than P1 because there is no confirmed production incident (unlike FEAT-411/415) and it is additive test infrastructure with a clear low-risk reuse path via existing smoke helpers."
---
# FEAT-418: MCP e2e over stdio transport

## Problem
mcp/server.test.ts exercises tool handlers as units; no test ever spawns the MCP server over its real stdio transport. The smoke suite (SLICE-SMOKE-1) covers HTTP + CLI surfaces but never the MCP surface. Transport-layer regressions (JSON-RPC framing, tool registration, init handshake, stdio buffering on Windows) ship silently — exactly the class of gap that let the fused-score wire bug reach the plugin.

## Proposal
Smoke-style e2e: spawn the built MCP entry as a child process, drive it with a minimal JSON-RPC client over stdio (initialize -> tools/list -> search_memory / recall_memory / get_health calls), assert tool inventory and response shapes against a seeded mock-provider daemon datadir. Reuse smoke sandbox helpers (temp datadir, env isolation, zero-residue teardown).

## Acceptance sketch
- tools/list returns the full registered tool set (count + names asserted).
- search_memory over stdio returns hits for seeded fixture data; response validates against the tool's declared output schema.
- Server exits cleanly on stdin close; no orphan process, no residue.
- Runs in CI with mock providers (no Ollama needed).

## Evidence
Test-inventory review 2026-07-04: MCP is the only client surface with zero transport-level coverage. FEAT-417 (MCP as_of/entity parity) adds params but still unit-level — this FEAT is the transport harness those tests can later ride on.
