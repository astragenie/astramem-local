---
id: SLICE-426
title: "install.sh: root/sudo handling + PATH guidance + config-dir perm hardening"
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
# SLICE-426: install.sh: root/sudo handling + PATH guidance + config-dir perm hardening

Implements FEAT-474. See [feature file](../../../backlog/in-progress/FEAT-474.md) for product context.

## Objective

**Port Supermemory's `install.sh` UX patterns onto our own installer** —

## In scope

- bullet 1
- bullet 2

## Out of scope

- bullet 1

## Acceptance criteria

> WARNING: ACs copied from FEAT-474 and shared across 2 sibling slices — scope per-slice before close

- [ ] **AC-1 — Skip reinstall when already current.**
- [ ] **AC-2 — `FORCE=1` overrides the skip.**
- [ ] **AC-3 — Version mismatch always reinstalls.**
- [ ] **AC-4 — `/dev/tty` reattach keeps the wizard interactive when piped.**
- [ ] **AC-5 — Graceful fallback when no `/dev/tty` exists.**
- [ ] **AC-6 — Refuse to auto-start the daemon as root.**
- [ ] **AC-7 — chown config/data back to the invoking user under sudo.**
- [ ] **AC-8 — Config directory gets restrictive perms, not just secrets.env.**
- [ ] **AC-9 — PATH guidance prints a copy-pasteable line.**
- [ ] **AC-10 — No regression to non-root, non-sudo installs.**

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
