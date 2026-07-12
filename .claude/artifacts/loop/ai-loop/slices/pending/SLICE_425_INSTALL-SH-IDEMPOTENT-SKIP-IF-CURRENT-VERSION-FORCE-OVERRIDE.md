---
id: SLICE-425
title: "install.sh: idempotent skip-if-current-version (FORCE override) + /dev/tty interactive reattach"
status: pending
feature: FEAT-474
phase: null
priority: P2
target_release: null
requires_validation: true
risk: medium
created: 2026-07-12
updated: 2026-07-12
effort_points: 3
tags: ["surface:install", "surface:cli", "stack:shell"]
---
# SLICE-425: install.sh: idempotent skip-if-current-version (FORCE override) + /dev/tty interactive reattach

Implements FEAT-474. See [feature file](../../../backlog/in-progress/FEAT-474.md) for product context.

## Objective

Make `install.sh` idempotent (skip the reinstall when the installed version is
already current, with a `FORCE=1` override) and keep the `init` wizard
interactive when the script itself is the piped stdin (`curl … | bash`), by
re-attaching prompts to `/dev/tty`.

This is slice 1 of 2 derived from FEAT-474. Slice 2 (root/sudo handling, PATH
guidance, config-dir perms) is a separate slice — do NOT implement it here.

## In scope

- `install.sh` ONLY (repo root, 82 lines today).
- Idempotent skip-if-current-version + `FORCE=1` escape hatch (AC-1..AC-3).
- `/dev/tty` re-attach for piped installs, with graceful fallback when no
  `/dev/tty` exists, e.g. CI (AC-4, AC-5).

## Out of scope

- **AC-6..AC-10 — they belong to FEAT-474's slice 2.** Root/sudo handling,
  chown-back, config-dir perms, PATH guidance. Do not implement.
- `install.ps1` — explicit non-goal in FEAT-474 (the install.sh patterns are
  POSIX-specific; the Windows schtasks/reinstall flow is unaffected).
- `src/service/reinstall.ts` — already asserts served-version == build-version
  and already has idempotency logic. REUSE it; do not add a parallel mechanism
  and do not edit it.
- `src/cli/init.ts` — already has a complete non-interactive env-var mode
  (`NON_INTERACTIVE_ENV`, init.ts:39-58). Do not rebuild it.
- No single-binary / `bun build --compile` work. FEAT-445's defer verdict stands.
- No daemon runtime changes.

## Acceptance criteria

Full Given-When-Then text for each is in `.claude/artifacts/loop/backlog/in-progress/FEAT-474.md`
under `## Acceptance criteria` — read them there; they name exact files and
line ranges.

- [ ] **AC-1 — Skip reinstall when already current.**
- [ ] **AC-2 — `FORCE=1` overrides the skip.**
- [ ] **AC-3 — Version mismatch always reinstalls.**
- [ ] **AC-4 — `/dev/tty` reattach keeps the wizard interactive when piped.**
- [ ] **AC-5 — Graceful fallback when no `/dev/tty` exists.**

## Done When

- all acceptance criteria PASS with evidence per `01-loop-control/EVIDENCE_RULES.md`
- build / test commands per `.claude/loop.json` pass
- feature FEAT-474 moved from `in-progress/` to `done/`
- Crew `final-synthesis` artifact written
- (pure refactors / mechanical changes: set `requires_validation: false` in frontmatter
   above to waive the validation gate — no badge needed at close time)

## Reviewer ladder

- Reviewer A: ...
- Reviewer B: ...
