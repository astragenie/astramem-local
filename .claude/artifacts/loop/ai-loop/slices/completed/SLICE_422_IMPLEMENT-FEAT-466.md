---
id: SLICE-422
title: Implement FEAT-466
status: completed
feature: FEAT-466
phase: null
priority: P1
target_release: null
requires_validation: true
risk: high
created: 2026-07-10
updated: 2026-07-10
completed_at: 2026-07-10
---
# SLICE-422: Implement FEAT-466

Implements FEAT-466. See [feature file](../../../backlog/in-progress/FEAT-466.md) for product context.

## Objective



## In scope

- bullet 1
- bullet 2

## Out of scope

- bullet 1

## Acceptance criteria

- [ ] **AC-1:** Given two distinct config/data directories (e.g. two independent `init` runs pointed at different `configDir`/`APPDATA` values, reproducing the 2026-07-10 incident scenario), When each calls `storeBearer()`/`storeDbKey()` in `src/storage/keystore.ts`, Then each writes to its own scoped OS credential-store identity (e.g. service `astramem-local:<hash-of-configDir>`) and neither run's write overwrites or clobbers the other's stored entry.
- [ ] **AC-2:** Given an existing pre-upgrade install whose bearer/db-key were written under the legacy unscoped identity (service `astramem-local`, account `bearer`/`db-key`), When the daemon boots after upgrading to the scoped-identity code, Then it successfully reads its credentials via a read-fallback to the legacy identity with no re-init or manual credential migration required, and the existing install keeps working unchanged.
- [ ] **AC-3:** Given a documented environment-variable bypass analogous to the existing `ASTRA_MEMORY_TEST_FORCE_KEYFILE` (db-key) is defined for the bearer, When a sandboxed or test `init` run sets that bypass variable, Then bearer storage is forced to a file inside the sandbox and the OS credential store (Windows Credential Manager / keychain) is never written to for that run.
- [ ] **AC-4:** Given a test reads the OS credential-store entry for the default/production identity immediately before and immediately after running a sandboxed `init` with the AC-3 bypass variable set, When the sandboxed init completes, Then the before and after reads are byte-identical, directly proving the bypass leaves the OS store completely untouched.
- [ ] **AC-5:** Given `doctor` runs against a daemon reading credentials from either the new scoped identity or the legacy fallback identity, When its output is inspected, Then it includes a row reporting which identity (scoped vs legacy) the running daemon is currently using.
- [ ] **AC-6:** Given both the scoped-identity change and the legacy-fallback change are in place, When the existing keystore/doctor test suite plus a new incident-class scenario test (two distinct configDirs, two `init` runs, assert via keystore reads that neither's stored credential was clobbered by the other) are run, Then all of them pass, with no regression in any pre-existing keystore or doctor test.

## Done When

- all acceptance criteria PASS with evidence per `01-loop-control/EVIDENCE_RULES.md`
- build / test commands per `.claude/loop.json` pass
- feature FEAT-466 moved from `in-progress/` to `done/`
- Crew `final-synthesis` artifact written
- (pure refactors / mechanical changes: set `requires_validation: false` in frontmatter
   above to waive the validation gate — no badge needed at close time)

## Reviewer ladder

- Reviewer A: ...
- Reviewer B: ...
