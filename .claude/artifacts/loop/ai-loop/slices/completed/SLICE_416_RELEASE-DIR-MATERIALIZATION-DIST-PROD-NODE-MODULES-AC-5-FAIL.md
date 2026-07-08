---
id: SLICE-416
title: Release dir materialization (dist + prod node_modules) + AC-5 failure guard
status: completed
feature: FEAT-438
phase: null
priority: P0
target_release: null
requires_validation: true
risk: high
created: 2026-07-07
updated: 2026-07-07
effort_points: 5
completed_at: 2026-07-07
---
# SLICE-416: Release dir materialization (dist + prod node_modules) + AC-5 failure guard

Implements FEAT-438 (slice 1 of 3 per `proposed_slices`). See
[feature file](../../../backlog/in-progress/FEAT-438.md) for product context
and the 2026-07-07 incident narrative.

## Objective

A `materializeRelease()` step (new module, consumed by `reinstall`) that builds
an immutable, independently-bootable release directory
`%LOCALAPPDATA%\Astramem\releases\<pkgversion>+<gitsha>\` from the current
checkout — WITHOUT yet repointing `current.json` (that is SLICE-2).

## In scope

- New `src/service/release.ts` (or similar): materialize release dir containing
  `dist/` (copied from checkout build output), `package.json`, lockfile, and a
  production `node_modules` (decision recorded in plan: `bun install --production
  --frozen-lockfile` executed INSIDE the release dir, using the copied
  package.json + lockfile).
- Release manifest file (`release.json`: pkgversion, gitsha, created_at, node
  version) written into the release dir for SLICE-2's served-version assert.
- Boot-verify guard: after materialization, run
  `node <release>/dist/cli/index.js --version` (or equivalent no-side-effect
  entry) and require exit 0 + expected version string BEFORE the release is
  considered valid — catches native-module ABI/packaging breakage (FEAT-438
  pre-mortem risk 1).
- Failure guard (FEAT AC-5): any materialization/boot-verify failure → abort
  loudly (non-zero exit, clear message), never leave a half-materialized dir
  eligible for use — quarantine (rename to `*.failed`) or delete the partial dir.
- Unit/integration tests for: happy-path materialization layout + manifest,
  boot-verify pass, simulated install failure → quarantine + non-zero exit.

## Out of scope

- Repointing `current.json` / shim changes / served-version assert wiring
  (SLICE-2).
- Retention/prune, `--rollback`, `--dev` escape hatch, doctor + CLAUDE.md docs
  (SLICE-3).
- Any change to schtasks registration or `launch.cjs`.

## Acceptance criteria

- [x] AC-1: Given a built checkout, When `materializeRelease()` runs, Then
      `%LOCALAPPDATA%\Astramem\releases\<pkgversion>+<gitsha>\` exists containing
      `dist/`, `package.json`, the lockfile, a production `node_modules`, and a
      `release.json` manifest with pkgversion+gitsha+created_at — and the dir is
      not marked valid until boot-verify passes.
- [x] AC-2 (boot-verify): Given a materialized release dir, When
      `node <release>/dist/cli/index.js --version` is executed from OUTSIDE the
      repo checkout, Then it exits 0 and reports the manifest's pkgversion —
      proving native modules resolve inside the release dir with no reference to
      the checkout's node_modules.
- [x] AC-3 (failure guard, FEAT AC-5): Given the production install or
      boot-verify step fails (simulate: broken package.json or a boot-verify
      command forced to exit non-zero), When materialization observes the
      failure, Then it exits non-zero with a clear message, `current.json` is
      untouched, and no valid-looking release dir remains (partial dir deleted or
      renamed `*.failed`).

## AC evidence (verified 2026-07-07)

- AC-1/2/3 unit suite: `tests/service/release.test.ts` 5/5 green; `bun run build` clean.
- AC-2 real native-module smoke (validator): `materializeRelease()` against the
  live checkout → correct `release.json`, `--version` boot-verify passed, `doctor`
  from the materialized dir loaded better-sqlite3 (SQLCipher) + sqlite-vec, 20/20,
  no SQLITE_NOTADB. Artifact: `.claude/artifacts/crew/validations/20260707T121453Z-validation-result-slice-416-materializerelease-validation.md`.
- AC-3 failure guard: broken-package.json + forced version-mismatch both throw,
  quarantine to `*.failed`, `current.json` byte-identical.
- Review: `approved_with_notes` (1 MEDIUM = idempotent-reuse trust, carried to
  SLICE-417 as a gate; 2 LOW). Artifact: `.claude/artifacts/crew/reviews/20260707T121436Z-review-result-slice-416-review.md`.
- Carry-forward to SLICE-417: re-verify (or drop) the idempotent-reuse trust
  path (`release.ts:226-234`) BEFORE wiring `current.json` repoint; add %TEMP%-root
  guard note; concurrent-rename race.

## Done When

- all acceptance criteria PASS with evidence per `01-loop-control/EVIDENCE_RULES.md`
- build / test commands per `.claude/loop.json` pass
- Crew `final-synthesis` artifact written
- FEAT-438 stays in `in-progress/` (slices 2-3 remain)

## Reviewer ladder

- Reviewer A: correctness — materialization atomicity, boot-verify coverage, AC evidence
- Reviewer B: production-readiness — failure paths, no partial-release footgun, Windows path handling
