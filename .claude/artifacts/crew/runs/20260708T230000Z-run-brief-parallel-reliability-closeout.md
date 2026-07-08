# Run Brief — Parallel Reliability Close-out (5 lanes)

- Started: 2026-07-08 (session 34764d70)
- Owner: lead (main thread)
- Mode: 5 parallel worktree lanes → per-lane (architect-reviewer + reviewer) → merge-on-green (auto, notify user)
- Decisions locked: A/B parallel+guards; all 5 lanes; lead merges on green + notifies.
- Deferred: sync PULL feature (#1) — not in this run.

## Lanes

| Lane | Items | Repo / Worktree | Branch | Builder agent | Status |
|------|-------|-----------------|--------|---------------|--------|
| A | #2 reinstall verify-health; #3 service stop kills lock-holder | astramemory-local / laneA-service-install | fix/service-install-reliability | a76bd6f92d0ff4342 (fullstack-dev) | building |
| B | #4 FEAT-440 crash-loop; #5 FEAT-439 schema-drift | astramemory-local / laneB-observability | feat/observability-probes | a0f17d06e254cbb75 (fullstack-dev) | building |
| C | #8 libuv teardown assertion | astramemory-local / laneC-sync-teardown | fix/sync-teardown-assertion | a67d19dc7db2fa8e9 (fullstack-dev) | building |
| D | #7 astrarunner emitter port | runner-plugin / laneD-emitter | feat/astrarunner-emitter-port | afa4d206a40e76c48 (aiplugin-dev) | building |
| E | #6 user↔tenant linkage (SECURITY) | memory (C#) / laneE-tenant-linkage | feat/tenant-user-linkage | a5a4713649a808664 (backend-dev, opus) | building |

## File-ownership guards (A↔B soft seam)
- A owns: cli/reinstall.ts, cli/service.ts, service/instance-lock.ts, service/install-flow.ts. Forbidden: shim.ts, doctor/checks.ts, serve.ts.
- B owns: doctor/checks.ts, service/shim.ts, new probe/script files. Forbidden: reinstall.ts, install-flow.ts, service.ts.
- Escalate (don't edit) on forbidden-file need.

## Per-lane gate (after builder returns)
1. crew:architect-reviewer (approach/boundary/design) + crew:reviewer (correctness). Both must PASS.
   - Lane A/C/D: light architect pass (small fixes). Lane B: FEAT ACs. Lane E: full design+security review (crew:architect-reviewer + crew:csharp-reviewer).
2. needs_fix → /crew:fix in same worktree → re-review.
3. Green (both PASS + build + tests) → merge branch to its repo's main, notify user.

## Merge order (this repo A/B/C): serialize from main, rebase later lanes. D/E independent repos.

## Cleanup on done: git worktree remove each lane.
