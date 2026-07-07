---
findings: "🔴:0,🟡:2,❓:0"
status: completed
decision: approved_with_notes
---
# Review Result: Review Result

- Created: 2026-07-07T12:41:24.483Z
- Reviewer: reviewer
- Decision: approved_with_notes
- Status: completed
- Summary: Additive-only MCP tool-name manifest + parity test is correct, rigorous, and matches the live server exactly (15/15, 7/7 green); two non-blocking notes on version discipline and residual triplication.
- Evidence Checked:
  - bun run build clean (tsc -p .); bunx vitest run tests/contracts/mcp-tool-manifest-parity.test.ts -> 7/7 pass; bunx vitest run tests/contracts/ -> 7 files/132 tests pass. git diff HEAD confirms src/mcp/server.ts change is a 5-line comment-only insertion (no registerTool/behavior/rename diff). grep of registerTool( in src/mcp/server.ts lists exactly the same 15 names as contracts/manifests/mcp-tools.v1.json
  - byte-identical descriptions spot-checked (search_memory
  - recall_memory
  - remember). Parity test uses readFileSync+JSON.parse for the manifest (no contracts/ import from tests/
  - respecting tsconfig rootDir:src) and builds the real buildApp()+live tools/list JSON-RPC call rather than a hardcoded list; assertions at lines 126-135 and 137-143 check both drift directions plus a full-set equality assertion at 145-152
  - so drift in either direction genuinely fails the suite.
- Files Reviewed:
  - contracts/manifests/mcp-tools.v1.json (new); tests/contracts/mcp-tool-manifest-parity.test.ts (new); contracts/README.md; contracts/package.json; src/mcp/server.ts
- Test Adequacy: New parity test (7 assertions) genuinely cross-checks manifest vs live server tools/list in both directions plus exact-set equality; full contracts/ suite (132 tests) green; no regression risk since server.ts diff is comment-only.
- Risks: contracts/package.json version was not bumped (stays 1.1.0) despite adding a new consumable export (./manifests/*) and a files entry — U4's prior commit (45f0f71) bumped 1.0.0->1.1.0 for a comparable schema addition, so this breaks that precedent; not currently blocking since publish only happens on a contracts-v* tag push with its own tag-vs-version gate, but if this ships un-bumped, downstream repos resolving @astragenie/astramem-contracts won't get a version signal that the manifest export now exists. Separately, the PM-flagged triplicated tool list is NOT resolved by this slice: tests/mcp/server.test.ts:112-128 and tests/smoke/mcp-stdio.e2e.test.ts:33-47 both still carry independent hardcoded 15-name arrays that this manifest+parity test does not reference or consume — a future rename would still require editing 3 places (manifest, server.test.ts, mcp-stdio.e2e.test.ts) even though only the manifest vs live-server pair is now automatically cross-checked. Neither of these is a regression risk today; both are pre-existing/scope gaps rather than defects introduced by this slice.
- Required Follow-up: Non-blocking: (1) bump contracts/package.json to 1.2.0 in this PR or explicitly note why not, to keep the established per-PR version-bump convention; (2) file a SLICE-B follow-up to have server.test.ts and mcp-stdio.e2e.test.ts read tool names from contracts/manifests/mcp-tools.v1.json instead of hardcoding EXPECTED_TOOL_NAMES, so the manifest becomes the actual single source of truth the PM asked for rather than a fourth independent list.

