# Handoff: stable-infra track — FEAT-438 SLICE-416 spec'd, ready for builder dispatch

- Created: 2026-07-07T09:35:00Z
- From: lead session 2934eeb4 (2026-07-07, daemon-outage investigation → stable-infra planning)
- Status at handoff: specs complete, builder NOT yet dispatched (operator asked to stop here)

## Objective

Execute FEAT-438 (release-pinned install, P0) starting with SLICE-416, then
FEAT-440, then FEAT-439 — the stable-infra chain derived from the 2026-07-07
8h daemon outage.

## Owner

Next session's lead. Builder for SLICE-416: `crew:fullstack-dev` subagent.

## State — what is DONE and verified this session

1. **Daemon outage fixed + serving.** Root cause: stale `dist/` (schema 15) vs
   live DB (schema 16, migrated by a worktree agent after PR #116). Fixed via
   `bun run build` + `reinstall`. `/health` ok, v0.8.1, schema_version 16.
2. **Sync 403 root-caused (SaaS-side).** Valid ApiKey → `403 {"error":"sync_disabled"}`
   on both hosts. DEC-048 default-closed gate: prod never set `Sync__Enabled` /
   `Sync__AllowedTenantIds`. Filed astragenie/memory#667 (enable, with exact env
   vars) and #668 (canonical host question — api.astramemory.com now LIVE, was
   dead). Ordering comment on #621: deploy content_hash relax (#619/#620) BEFORE
   enabling sync, else 403 becomes 500. All three SaaS actions await operator.
3. **Shipper/puller error-body logging shipped locally.** `src/sync/shipper.ts` +
   `src/sync/puller.ts` now append response body (200-char cap) to HTTP errors;
   regression test added; sync suite 52/52 green; rebuilt + reinstalled; verified
   live via /sync/status. **UNCOMMITTED** (no dev.stable flag; operator hasn't
   said commit). Files: shipper.ts, puller.ts, tests/sync/shipper.test.ts.
4. **Poison distill job recovered.** Job ad6c5011 requeued (scratchpad one-off
   script) → completed. Queue: 597 completed / 0 poison. One-off LLM flake.
5. **Backlog triaged (all 7 pending → triaged/).** PM artifact:
   `.claude/artifacts/loop/pm-reviews/20260707T160000Z-pm-review-triage-batch.md`.
   Results: FEAT-438 P0 (0.70), FEAT-440 P1 (0.72, autonomous_safe:false —
   same-shim dependency on 438), FEAT-439 P1 (0.71, autonomous_safe:true),
   FEAT-425/428/437 P2, FEAT-429 needs-review (resists decomposition — needs
   runner:architect design note first). NOTE: proposal-policy FEAT renumbered
   430→437 (collision with done/FEAT-430).
6. **SLICE-416 opened via ceremony** (`slice start --id FEAT-438`). currentRun
   rotated. Slice + plan hand-tightened:
   - Slice: `.claude/artifacts/loop/ai-loop/slices/pending/SLICE_416_RELEASE-DIR-MATERIALIZATION-DIST-PROD-NODE-MODULES-AC-5-FAIL.md`
   - Plan (incl. resolved architect decision): `.claude/artifacts/loop/plans/20260707T091627Z-plan-SLICE-416.md`
   - Run brief: `.claude/artifacts/crew/runs/20260707T091627Z-run-brief-feat438-slice416-*.md`
   - FEAT-438 moved to `backlog/in-progress/` by the ceremony.

## Key design decision (recorded in plan, do not re-litigate)

Release materialization = `bun install --production --frozen-lockfile` INSIDE
the release dir (copied package.json + lockfile), temp-dir + rename-after-
boot-verify. Boot-verify = `node <release>/dist/cli/index.js --version` (no DB
open — immune to live-DB schema state). Failure → quarantine `*.failed`, never
a valid-looking partial release.

## Allowed scope (next step)

Dispatch `crew:fullstack-dev` for SLICE-416 with the dispatchInstruction from
the ceremony (re-runnable idempotently: `bun <runner>/loop.mts slice start
--repo "$PWD" --id SLICE-416`). Scope: NEW `src/service/release.ts` + tests
only. Then crew:inspector review → crew:verifier (behavior changed) →
`/runner:close SLICE-416` → SLICE-2 (pointer repoint) → SLICE-3
(retention/rollback/--dev) → FEAT-440 → FEAT-439.

## Forbidden scope

- No edits to `launch.cjs`, `reinstall` flow wiring, or schtasks in SLICE-416
  (SLICE-2/3 own those).
- FEAT-440 must NOT be dispatched before FEAT-438 lands (same-shim collision —
  PM override reason).
- No commits of the sync logging changes without operator say-so; no release
  tags; no prod SaaS config changes (operator-approval items in #667/#621).

## Confidence

High on diagnosis/specs (everything above verified live). Medium on SLICE-416
implementation unknowns: bun --production install behavior for the SQLCipher
better-sqlite3 fork on Windows is the main risk — boot-verify gate is the
designed catch.

## Risks / open questions

- Uncommitted working tree (3 files) could collide with SLICE-416 builder work
  — they don't touch sync/, but commit-or-stash first is cleaner. Ask operator.
- 42+ sync events pending locally; drains automatically once SaaS #667+#621 done.
- Proposal backlog 162 and growing (FEAT-437, P2 — untouched by design).

## Suggested next handoff

After SLICE-416 PASS+review+validation: handoff to SLICE-2 builder (pointer
repoint + served-version assert vs release manifest).
