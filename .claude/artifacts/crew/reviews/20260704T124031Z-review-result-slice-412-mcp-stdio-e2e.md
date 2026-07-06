# Review Result: SLICE-412 — MCP e2e over stdio transport

- Created: 2026-07-04T12:40:31Z
- Reviewer: inspector (independent, dispatched by team-lead)
- Decision: **PASS**
- Commit reviewed: `3b83712` (feat/FEAT-418-mcp-stdio-e2e)
- Files: `src/cli/mcp-stdio.ts` (new), `src/cli/index.ts` (+8), `tests/smoke/mcp-stdio.e2e.test.ts` (new)

## Evidence Checked

- `bun run build` (`tsc -p .`) — clean, no diagnostics.
- `bunx vitest run tests/smoke/mcp-stdio.e2e.test.ts` — 2/2 passed (1.09s test time), independently rerun.
- Read `src/cli/mcp-stdio.ts`, `src/cli/serve.ts` (full), `tests/smoke/mcp-stdio.e2e.test.ts` (full), `tests/smoke/helpers/daemon.ts` (isolation helper), `src/mcp/server.ts` (tool count), `src/storage/migrate.ts` (signature), and the vendored `@modelcontextprotocol/sdk` `StdioServerTransport`/`Protocol` source directly (not from memory) to verify lifecycle claims.

## Findings

**1. Lifecycle correctness — sound.**
`StdioServerTransport` (node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js) only registers `data`/`error` listeners on `process.stdin` — it never listens for `'end'`. The builder's comment ("StdioServerTransport does NOT auto-close on EOF") is verified correct from the vendored source, and the `process.stdin.on('end', ...)` handler in `mcp-stdio.ts:69-74` does not race the transport's own listeners (different event). `server.close()` → `transport.close()` (removes stdin listeners, `onclose()`) → `Protocol._onclose()` (aborts in-flight request `AbortController`s) → `db.close()` → `process.exit(0)` is a clean, ordered chain; nothing async is left dangling before `process.exit(0)`.

- [LOW] `src/cli/mcp-stdio.ts:69-74` — one real edge case, not exercised by the test: if a client sends a request and closes stdin before the response is written, `Protocol._onclose()` aborts the in-flight handler via `AbortController`, so the response is silently dropped rather than erroring back to the client. In practice this is low-risk because a client that closed its write side is also about to stop reading, and better-sqlite3 is synchronous so there's no partial-write/corruption risk — just a swallowed response on an already-departing client. Worth a one-line comment acknowledging the tradeoff, not a blocker.

**2. DB/config wiring vs `serve.ts` — matches on everything that matters for this subcommand's stated scope; one intentional, disclosed gap.**
Side-by-side with `serve.ts:39-119`: datadir resolution (`resolveRuntimeConfig`), `:memory:` short-circuit, SQLCipher key fetch + `encryptIfPlaintext` + `openDb({key})` gating on `cfg.security.encryption.enabled`, and `migrate(db, cfg.embedding.dim)` are byte-for-byte the same pattern. Confirmed `migrate()`'s `dim` param defaults to `DEFAULT_EMBED_DIM` (`src/storage/migrate.ts:29`) and is idempotent on an already-migrated DB, so the test's own direct `migrate(db)` call (no dim arg) before the child spawns and the child's `migrate(db, cfg.embedding.dim)` agree by construction on a fresh isolated datadir.

Deliberately **not** carried over from `serve.ts` (correctly, given the file's own header comment: "No daemon lifecycle... this process is meant to be spawned per-client-session"): instance lock, crash handlers, boot job recovery, WAL checkpoint timer, sync shipper, consolidate cadence, and the `getVecSchemaDim`-based embed dim preflight (FEAT-409).

- [LOW/informational] `src/cli/mcp-stdio.ts` — no `getVecSchemaDim` cross-check against `cfg.embedding.dim` before serving. If a user's config drifts from the persisted schema dim (the scenario FEAT-409 exists to catch), `serve` fails loud via the doctor-style preflight message; `mcp-stdio` would instead surface whatever raw error sqlite-vec throws on a dimension mismatch during the first `remember`/`search_memory` call. Acceptable for a test-enabling transport (per the file's own comment marking it non-production), but worth a backlog note if `mcp-stdio` is ever promoted beyond test infrastructure.

**3. Test rigor — solid, not tautological.**
- `StdioRpcClient.onData` (`tests/smoke/mcp-stdio.e2e.test.ts:69-90`) buffers across chunks (`this.buffer += chunk`) and drains all complete `\n`-terminated messages per chunk in a `while` loop before returning — correctly handles both partial-message and multiple-messages-per-chunk cases, not just the common one-message-one-chunk path.
- `EXPECTED_TOOL_NAMES` (15 entries) matches `server.registerTool` call count in `src/mcp/server.ts` (15, confirmed by grep) — the HTTP/stdio parity claim is real, not just a copy-pasted list.
- The `[0,1]` score assertion (`mcp-stdio.e2e.test.ts:203-206`) follows a `hits.length > 0` assertion against a directly-seeded fixture (bypassing `remember`, per the test's own header comment) — a real check on real search output, not a vacuous pass-through.

**4. Concurrency / orphan-process risk — no gap found.**
`makeIsolatedDaemonEnv` (`tests/smoke/helpers/daemon.ts:263-289`) overrides `APPDATA`, `LOCALAPPDATA`, `HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, and `ASTRA_MEMORY_DATADIR` together — every OS-standard lookup path `resolveRuntimeConfig`/`migrateLegacyDirsIfPresent` could hit is redirected into the temp sandbox, and encryption is disabled in the sandboxed `config.yaml` so the child never touches the real OS credential store either. No plausible path for this test to reach a real daemon's datadir. The no-instance-lock design is a real footgun only for a *production* multi-host scenario (two real hosts spawning `mcp-stdio` against the same real datadir concurrently), which is out of scope for this transport-proving slice; the test itself carries no such risk. `afterAll`'s `child.exitCode === null && child.signalCode === null` → `SIGKILL` backstop mirrors the proven pattern already in `smoke.test.ts` and held in the independent rerun.

**5. `describe.sequential` — not an issue.** Checked `node_modules/@vitest/runner/dist/tasks.d-*.d-ts` for a `@deprecated` tag on `sequential`; none exists in vitest 4.1.9, and `tsc -p .` produced zero diagnostics on this file. `describe.sequential` is also the existing pattern in `tests/smoke/smoke.test.ts:118`, so this is consistent usage, not a new deprecated call. No action needed.

## Test Adequacy

Matches the PM scope note (2-3 representative tool calls proving transport wiring, not exhaustive per-tool coverage — that's `tests/mcp/server.test.ts`'s job). AC-2/AC-3/AC-4 all have direct assertions; teardown is airtight against both graceful and thrown-mid-test paths.

## Risks / Required Follow-up

- None blocking. Two informational notes above (in-flight-response-on-EOF edge case; no embed-dim preflight) are worth a one-line backlog mention if `mcp-stdio` is ever positioned as more than test/dev infrastructure, but neither affects this slice's stated ACs.

## Verdict

**PASS.** Recommend proceeding to validation/merge.
