# Wave A — Final Synthesis (2026-07-04)

Run: Wave A parallel build (FEAT-416, FEAT-417, FEAT-415, FEAT-411) + FEAT-412 pre-wave close.
Mode: 4 parallel builders in isolated sibling worktrees, independent inspector reviews as gates, ordered merge.
Orchestrator: primary session (Wave A); concurrent session ran FEAT-413 in parallel on its own branch.

## Shipped (all merged to origin/main via PR #41, merge commit 8567f91)

| FEAT | Merge | Deliverable |
|------|-------|-------------|
| FEAT-412 | config/docs only | Worktree discipline: `loop.worktreeRoot: "../astramemory-local-worktrees"` pinned in `.claude/loop.json`; nested `.claude/worktrees/` prohibited in `.claude/loop/rules.md`; `Agent isolation: worktree` flagged as nesting hazard. AC5 residual (crew:parallel legacy provisioning) filed to dev-team. |
| FEAT-416 | e12437d | `POST /memory/:id/restore` (404 unknown / 409 never-archived, invalidate-mirrored), CLI `memory restore <id>`, `restore_memory` MCP tool (tool count 15). |
| FEAT-417 | 1bc7203 | Shared `getWhyReceipt`/`getSessionDigest` query layer; REST==MCP deep-equal conformance tests; MCP `as_of`/`entity` params inherit `parseAsOf` + `normalizeEntityName`; 417a fix: MCP `session_digest` with unknown explicit `session_id` now errors instead of silent-empty. `src/search/query.ts` deleted (dead duplicate). |
| FEAT-415 | 7bb804b | Encrypted-restart smoke suite (16 tests, port 19200): ingest → SIGKILL → respawn → identical id sets; wrong-key stderr assertions. Test seam `ASTRA_MEMORY_TEST_FORCE_KEYFILE=1` (warn-logged). |
| FEAT-411 | a884815 | Cross-repo wire-contract CI both directions: daemon-side `.github/workflows/cross-repo-roundtrip.yml` (public plugin checkout, no token) + plugin-side mirror (secret-gated on `ASTRAMEM_LOCAL_TOKEN`). |

Plugin repo: PR #16 (smoke suite), PR #17 (dead bash-helper test deletion — ubuntu/macos CI red since ae92cd3), PR #18 (secret-gated CI mirror) all merged.

## Bugs found and fixed by this wave

1. **Smoke suite silently ran encryption-ON against the real Windows Credential Manager** (pre-existing, SLICE-SMOKE-1): helper wrote `config.yaml` to the flat config dir but `defaultConfigDir()` joins the platform subdir, so the file was never read and `defaultConfig()` fell back to `encryption.enabled: true`. Fix: dual-write in `tests/smoke/helpers/daemon.ts` + explicit `encryption` option.
2. **Wrong-key restart produced generic `SQLITE_NOTADB`**: `rewrapWrongKeyError` in `src/cli/serve.ts` now emits an actionable message (key source, wrong/stale key vs corruption, backup pointers); only `err.code === 'SQLITE_NOTADB'` is rewrapped.
3. **MCP `session_digest` silent-empty drift** (FEAT-417a): unknown explicit session id returned an empty digest instead of an error; now errors, matching REST.

## Post-wave operator items (closed same day)

- `cross-repo-roundtrip` added as a required status check to the astramem-local main ruleset (18464801).
- `ASTRAMEM_LOCAL_TOKEN` (fine-grained PAT, read-only Contents on astramem-local) set in astramem-plugin; live dispatch run 28706419227 verified the real roundtrip path executes (1 passed, not skipped).
- Self-hosted runner ETXTBSY flake escalated on devops issue #64 (14 hits / 2 days; now blocks required checks). Two red post-merge main runs rerun to green.

## Verification

- Full suite on merged main: 124 test files, 1227 tests passing (includes ADR-005 eval gate).
- PR #41 checks green after one ETXTBSY rerun; plugin PR #18 verified live (skip-success without secret, real run with secret).

## Open follow-ups

- Wave B candidates: FEAT-419 (idempotency race probe, P1, not autonomous-safe), FEAT-420 (upgrade-path e2e, P1, not autonomous-safe), FEAT-414 (mock-vocab constants), FEAT-418 (MCP stdio e2e), FEAT-421 (nightly live-provider).
- tests/smoke ~1-in-10 flake under repeated concurrent local runs (spawn contention; scope vitest `fileParallelism` or bump timeouts).
- dev-team repo: crew 0.48.0 (test-automator v2.0.0) staged, uncommitted; /crew:parallel nested-worktree provisioning fix (FEAT-412 AC5 residual).
- ETXTBSY infra fix owned by devops issue #64 (per-runner tool cache isolation or `no-cache: true`).
