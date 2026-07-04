---
id: SLICE-412
title: MCP e2e over stdio transport
status: completed
feature: FEAT-418
phase: null
priority: P2
target_release: null
requires_validation: true
risk: medium
created: 2026-07-04
updated: 2026-07-04
touches_files: [src/cli/mcp-stdio.ts, src/cli/index.ts, tests/smoke/mcp-stdio.e2e.test.ts]
completed_at: 2026-07-04
---
# SLICE-412: MCP e2e over stdio transport

Implements FEAT-418. See [feature file](../../../backlog/in-progress/FEAT-418.md) for product context.

## Objective

Give the MCP surface its first transport-level test coverage. Today
tests/mcp/server.test.ts exercises tool handlers over Streamable HTTP built in
the same process; nothing ever spawns the server as a real child process and
speaks JSON-RPC to it. Because NO stdio entry point exists yet, this slice adds
a thin one (`astramem mcp-stdio`: buildMcpServer + @modelcontextprotocol/sdk
StdioServerTransport, reusing the CLI's existing db/embed/config wiring), then
drives it end-to-end from a smoke-style test.

## In scope

- New `src/cli/mcp-stdio.ts` subcommand registered in `src/cli/index.ts`:
  opens the configured (or env-overridden) datadir, builds the MCP server via
  the existing `buildMcpServer`, connects a `StdioServerTransport`, exits
  cleanly when stdin closes. Mock-provider support via the same env flags the
  smoke suite uses (no Ollama needed).
- New e2e test `tests/smoke/mcp-stdio.e2e.test.ts` reusing the smoke sandbox
  helpers (`tests/smoke/helpers/daemon.ts` patterns: temp datadir, env
  isolation, zero-residue teardown): spawn `node dist/cli/index.js mcp-stdio`
  as a child process, drive it with a minimal JSON-RPC client over
  stdin/stdout — initialize → tools/list → search_memory + get_health calls
  against seeded fixture data.
- Hard teardown: kill the child in afterEach/finally even on assertion failure
  (FEAT risk: no orphan processes on CI).

## Out of scope

- Exhaustive tool-by-tool e2e coverage (explicit pm_scope_notes guard — 2-3
  representative calls only).
- Any change to the HTTP transport, tool handlers, or plugin wiring.
- Advertising/documenting mcp-stdio as a public surface (README changes
  minimal or none; this is test-enabling infrastructure first).

## Acceptance criteria

- [ ] AC-1: All tests pass (`bunx vitest run`) and typecheck is clean (`bun run build`)
- [ ] AC-2: Given the built CLI, when the e2e test spawns `mcp-stdio` as a child
      process and sends `initialize` then `tools/list` over stdio, then the
      response advertises the full registered tool set (count + names asserted
      against the same list tests/mcp/server.test.ts pins).
- [ ] AC-3: Given a seeded temp datadir (fixture memories via direct repo insert
      or the remember tool), when the test calls `search_memory` and
      `get_health` over stdio, then search returns ≥1 hit with score in [0,1]
      and health reports ok — all with mock providers, no Ollama.
- [ ] AC-4: Given the test completes (pass OR fail), when stdin is closed /
      teardown runs, then the child process exits (waited on with a timeout +
      kill fallback) and the temp datadir is removed — no orphan process, no
      residue. Verified by asserting child exit and datadir absence in the test.

## Done When

- all acceptance criteria PASS with evidence per `01-loop-control/EVIDENCE_RULES.md`
- build / test commands per `.claude/loop.json` pass
- feature FEAT-418 moved from `in-progress/` to `done/`
- Crew `final-synthesis` artifact written

## Reviewer ladder

- Reviewer A: crew:reviewer (correctness/regressions)
- Reviewer B: crew:typescript-reviewer (only if Reviewer A flags depth)
