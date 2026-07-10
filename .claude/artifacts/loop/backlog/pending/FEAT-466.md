---
id: FEAT-466
status: pending
priority: null
category: bug
target_release: null
created: 2026-07-10
updated: 2026-07-10
depends_on: []
slices: []
derived_from: .claude/artifacts/crew/validations/20260710T123200Z-validation-result-slice-420-feat-461-config-yaml.md (incident finding)
cross_product: [astramem-local]
autonomous_safe: null
tags: ["concern:security", "concern:testing", "stack:typescript", "surface:daemon"]
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
