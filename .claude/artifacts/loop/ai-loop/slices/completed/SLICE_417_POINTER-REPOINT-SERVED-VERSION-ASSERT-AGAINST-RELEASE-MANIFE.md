---
id: SLICE-417
title: "Pointer repoint + served-version assert against release manifest (AC-1, AC-2)"
status: completed
feature: FEAT-438
phase: null
priority: P0
target_release: null
requires_validation: true
risk: high
created: 2026-07-07
updated: 2026-07-07
effort_points: 3
completed_at: 2026-07-07
---
# SLICE-417: Pointer repoint + served-version assert against release manifest (AC-1, AC-2)

Implements FEAT-438. See [feature file](../../../backlog/in-progress/FEAT-438.md) for product context.

## Objective

`current.json.entryJs` points at `C:/work/mega/astramemory-local/dist/cli/index.js`

## In scope

- Wire `materializeRelease()` (SLICE-416, `src/service/release.ts`) into the
  `reinstall` flow (`src/cli/reinstall.ts`): after build, materialize a release,
  then repoint `current.json.entryJs` to `<releaseDir>/dist/cli/index.js`.
- Atomic pointer write — reuse the shim tmp-file+rename pattern (`src/service/shim.ts`);
  an interrupted repoint must never yield a torn `current.json`.
- Served-version assert: after `service start`, assert the served version
  (`/version` or `--version`) equals the release manifest `pkgversion`; fail loud
  (non-zero + clear message) on mismatch. This is the direct catch for the
  2026-07-07 outage (served build ≠ expected).
- **Carry-forward from SLICE-416 review (MEDIUM):** before repointing to a
  pre-existing release dir (the idempotent-reuse path, `release.ts:226-234`),
  re-verify its manifest/boot rather than trusting it blindly.

## Out of scope

- Retention / rollback / `reinstall --dev` — SLICE-418 owns these.
- `materializeRelease()` internals — landed + verified in SLICE-416.
- schtasks / XML task registration — unchanged (only the pointer moves).

## Acceptance criteria

- [x] AC-1 (repoint): Given a built checkout, When `reinstall` runs, Then it
      materializes a release and rewrites `current.json.entryJs` to the versioned
      release dir's `dist/cli/index.js`, and a subsequent `service start` serves
      from that release dir (not the repo `dist/`).
- [x] AC-2 (served-version assert): Given the service has started against the
      repointed release, When `reinstall` performs its post-start check, Then it
      asserts served version == release manifest `pkgversion`; on a forced
      mismatch it exits non-zero with a clear message and does NOT leave a
      half-repointed pointer.
- [x] AC-3 (reuse re-verify): Given a release dir for the same id already exists,
      When `reinstall` would reuse it, Then it re-verifies (boot-verify or
      manifest+version) BEFORE repointing — a stale/broken same-id dir is not
      trusted (closes the SLICE-416 review MEDIUM).
- [x] AC-4 (atomic pointer): Given a repoint is interrupted mid-write, When the
      daemon or a reader next reads `current.json`, Then it observes either the
      old or new pointer, never a torn file (tmp+rename).

## Done When

- all acceptance criteria PASS with evidence per `01-loop-control/EVIDENCE_RULES.md`
- build / test commands per `.claude/loop.json` pass
- FEAT-438 stays in `in-progress/` (SLICE-418 remains)
- Crew `final-synthesis` artifact written

## Reviewer ladder

- Reviewer A: correctness — repoint atomicity, served-version assert coverage,
  reuse re-verify closes the 416 MEDIUM, no torn-pointer window.
- Reviewer B: regression — `reinstall` idempotency preserved; a failed
  materialize/assert leaves the PRIOR working pointer intact (no worse than before).
