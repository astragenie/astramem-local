---
feature: FEAT-418
status: active
---
# Run Brief: FEAT418 SLICE412: MCP e2e over stdio transport

- Created: 2026-07-04T11:17:24.477Z
- Tier: full
- Goal: Give the MCP surface its first transport-level test coverage. Today tests/mcp/server.test.ts exercises tool handlers over Streamable HTTP built in the same process; nothing ever spawns the server as a real child process and speaks JSON-RPC to it. Because NO stdio entry point exists yet, this slice adds a thin one (`astramem mcp-stdio`: buildMcpServer + @modelcontextprotocol/sdk StdioServerTransport, reusing the CLI's existing db/embed/config wiring), then drives it end-to-end from a smoke-style 
- Mode: autonomous
- Pace: unattended
- Owner: loop
- Status: active
- Summary: -
- Scope:
  - - New `src/cli/mcp-stdio.ts` subcommand registered in `src/cli/index.ts`:
  opens the configured (or env-overridden) datadir
  - builds the MCP server via
  the existing `buildMcpServer`
  - connects a `StdioServerTransport`
  - exits
  cleanly when stdin closes. Mock-provider support via the same env flags the
  smoke suite uses (no Ollama needed).
- New e2e test `tests/smoke/mcp-stdio.e2e.test.ts` reusing the smoke sandbox
  helpers (`tests/smoke/helpers/daemon.ts` patterns: temp datadir
  - env
  isolation
  - zero-residue teardown): spawn `node dist/cli/index.js mcp-stdio`
  as a child process
  - drive it with a minimal JSON-RPC client over
  stdin/stdout — initialize → tools/list → search_memory + get_health calls
  against seeded fixture data.
- Hard teardown: kill the child in afterEach/finally even
- Out Of Scope:
  - - Exhaustive tool-by-tool e2e coverage (explicit pm_scope_notes guard — 2-3
  representative calls only).
- Any change to the HTTP transport
  - tool handlers
  - or plugin wiring.
- Advertising/documenting mcp-stdio as a public surface (README changes
  minimal or none; this is test-enabling infrastructure first).
- Planned Files: -
- Next Step: Begin implementation

