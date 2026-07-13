---
type: validation
created: 2026-07-13T10:55:00Z
slice: SLICE-429
feature: FEAT-481
result: PASS
validator: lead (evidence from builder + reviewer runs in the isolated worktree)
---

# Validation — SLICE-429: get_entity_related + get_entity_timeline MCP tools

## Behavior evidence

- Real spawned-child-process JSON-RPC over stdio (`tests/smoke/mcp-stdio.e2e.test.ts`,
  updated to the 20-tool surface): 1 file / 2 tests PASS, 991ms — the tools are
  reachable through the actual `astramem-local mcp-stdio` wire, not just in-process.
- Conformance suite (real in-process McpServer + real sqlite,
  `tests/mcp/entity-relations-conformance.test.ts`): 13 tests PASS, including the
  adversarial §4.1 case — relation seeded → returned; evidence memory invalidated
  (relation's own valid_to asserted still NULL) → asOf query past invalidation
  returns empty. Positive→negative transition, not an empty-store false pass.
- Manifest parity (`tests/contracts/mcp-tool-manifest-parity.test.ts`): live
  tools/list diffed both directions vs manifest, owner flip cloud→both in the same
  commit as registration. 6 tests PASS.
- Full suite in worktree at final sha b45ff4e: 242 files / 2887 pass / 0 fail;
  tsc clean.

## Reviews

- typescript-reviewer: PASS (1 LOW naming note — asOf kept as deliberate cloud
  parity, documented in-code at src/mcp/server.ts:622-625).
- crew:reviewer: PASS (1 MEDIUM — direction='both' single-query divergence from
  cloud's 2×limit concat — documented in-code at src/mcp/server.ts:663-667).
  Artifact: .claude/artifacts/crew/reviews/slice-429-correctness-review.md.

## Merge

Branch feat/feat-481-slice429 (worktree-isolated build) merged to main at
b45ff4e; zero path overlap with in-flight SLICE-432 work verified pre-merge.
