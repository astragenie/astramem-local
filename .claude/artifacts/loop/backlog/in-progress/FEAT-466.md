---
id: FEAT-466
status: in-progress
priority: P1
category: bug
target_release: null
created: 2026-07-10
updated: 2026-07-10
depends_on: []
slices: [SLICE-422]
derived_from: .claude/artifacts/crew/validations/20260710T123200Z-validation-result-slice-420-feat-461-config-yaml.md (incident finding)
cross_product: [astramem-local]
tags: ["concern:security", "concern:testing", "stack:typescript", "surface:daemon"]
pm_customer_impact: 0.75
pm_effort_estimate: 0.5
pm_strategic_alignment: 0.7
pm_technical_risk: 0.45
pm_dependency_depth: 0.1
pm_composite_priority: P1
pm_autonomous_safe: true
pm_reviewed: 2026-07-10
autonomous_safe: true
triage_notes: "P1 via formula: impact 0.75>=0.7 AND alignment 0.7>=0.6, so the first P1 branch fires directly. composite_score = 0.75*0.35 + 0.7*0.30 + (1-0.5)*0.20 + (1-0.45)*0.10 + (1-0.1)*0.05 = 0.6725. Customer impact scored high, not just 'testing hygiene': this is a live production-credential collision incident (2026-07-10, SLICE-420 validation) — a sandboxed init overwrote the real machine-wide bearer in Windows Credential Manager, caught only by luck (no daemon restart during the ~1 min window) and restored manually from secrets.env. Every future sandboxed init/e2e run carries the same latent blast radius until this is scoped. strategic_alignment scored 0.7: directly protects the daemon's core trust proposition ('your local memory, not leaked/clobbered by unrelated processes') and unblocks safe sandboxed testing of init/writeConfig going forward. technical_risk banded at 0.45: security-sensitive (credential storage identity) and must preserve backward compat for existing installs via legacy-identity fallback, but confined to src/storage/keystore.ts + doctor.ts, no data-migration, revert-only rollback, and precedented by the existing ASTRA_MEMORY_TEST_FORCE_KEYFILE bypass pattern already shipped for db-key. autonomous_safe=true: all three mechanical thresholds pass (risk 0.45, effort 0.5, dependency 0.1, all <=0.6) and this triage pass drafts concrete Given-When-Then ACs below (scoped identity + legacy fallback, sandbox bypass, doctor row, before/after OS-store-untouched assertion, two-configDir incident-class regression test) satisfying the AC-exists gate."
started_at: 2026-07-10
---
## Description

**OS credential-store identity is machine-global — a sandboxed `init` run
overwrites the PRODUCTION daemon's bearer** — `src/storage/keystore.ts` stores
the bearer and db-key under a fixed identity (service `astramem-local`,
account `bearer`/`db-key`) in the OS credential store (Windows Credential
Manager / keychain). This identity is NOT scoped by APPDATA/LOCALAPPDATA
sandboxing, so any test or sandboxed `init` that calls `storeBearer()`
clobbers the real machine-wide entry.

**Incident 2026-07-10** (SLICE-420 validation): a sandboxed non-interactive
`init` (required to exercise `writeConfig` end-to-end) overwrote the
production bearer in Windows Credential Manager. Caught immediately and
restored from the untouched `%APPDATA%\Astramem\secrets.env`; zero client
impact only because the production daemon resolves its bearer once at boot
and did not restart during the ~1 min window. This is a latent
production-credential collision for every future sandboxed init/e2e run.

### Scope

- Scope the credential-store identity by config/data dir (e.g. service
  `astramem-local:<hash-of-configDir>` or account suffix), with a migration
  read-fallback to the legacy unscoped identity so existing installs keep
  working after upgrade.
- AND/OR add a test bypass mirroring the existing
  `ASTRA_MEMORY_TEST_FORCE_KEYFILE` (db-key) so bearer storage can be forced
  to a file inside the sandbox — a legitimately sandboxed init must have a
  supported way to never touch the global store.
- Doctor: surface which identity (scoped vs legacy) the running daemon reads.
- Tests: sandboxed init with the bypass leaves the OS store untouched
  (assert via keystore read before/after).

### Non-goals

- Multi-profile support UX (separate feature); this is strictly
  collision-proofing the storage identity.

## Acceptance criteria

- **AC-1:** Given two distinct config/data directories (e.g. two independent `init` runs pointed at different `configDir`/`APPDATA` values, reproducing the 2026-07-10 incident scenario), When each calls `storeBearer()`/`storeDbKey()` in `src/storage/keystore.ts`, Then each writes to its own scoped OS credential-store identity (e.g. service `astramem-local:<hash-of-configDir>`) and neither run's write overwrites or clobbers the other's stored entry.
- **AC-2:** Given an existing pre-upgrade install whose bearer/db-key were written under the legacy unscoped identity (service `astramem-local`, account `bearer`/`db-key`), When the daemon boots after upgrading to the scoped-identity code, Then it successfully reads its credentials via a read-fallback to the legacy identity with no re-init or manual credential migration required, and the existing install keeps working unchanged.
- **AC-3:** Given a documented environment-variable bypass analogous to the existing `ASTRA_MEMORY_TEST_FORCE_KEYFILE` (db-key) is defined for the bearer, When a sandboxed or test `init` run sets that bypass variable, Then bearer storage is forced to a file inside the sandbox and the OS credential store (Windows Credential Manager / keychain) is never written to for that run.
- **AC-4:** Given a test reads the OS credential-store entry for the default/production identity immediately before and immediately after running a sandboxed `init` with the AC-3 bypass variable set, When the sandboxed init completes, Then the before and after reads are byte-identical, directly proving the bypass leaves the OS store completely untouched.
- **AC-5:** Given `doctor` runs against a daemon reading credentials from either the new scoped identity or the legacy fallback identity, When its output is inspected, Then it includes a row reporting which identity (scoped vs legacy) the running daemon is currently using.
- **AC-6:** Given both the scoped-identity change and the legacy-fallback change are in place, When the existing keystore/doctor test suite plus a new incident-class scenario test (two distinct configDirs, two `init` runs, assert via keystore reads that neither's stored credential was clobbered by the other) are run, Then all of them pass, with no regression in any pre-existing keystore or doctor test.
