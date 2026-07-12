---
id: FEAT-472
status: pending
priority: null
category: bug
target_release: null
created: 2026-07-10
updated: 2026-07-10
depends_on: []
slices: []
derived_from: FEAT-466 handoff follow-up flag (2026-07-10)
cross_product: [astramem-local]
autonomous_safe: null
tags: ["concern:security", "stack:typescript", "surface:daemon"]
---
## Description

**sync-token still uses the unscoped machine-global keystore identity** —
`storeSyncToken`/`readSyncToken` (cloud sync device token) kept the fixed
service/account pattern FEAT-466 removed for bearer/db-key. Same collision
class: a sandboxed pairing flow would clobber the production device token.

### Scope

- Mirror FEAT-466: per-configDir scoped identity + read-only legacy fallback +
  keyfile bypass under ASTRA_MEMORY_TEST_FORCE_KEYFILE + doctor row.
- Check rollback interplay with sync.json (memory: sync.json prod-pairing
  leaks into sandboxed spawns — daemon-spawn-footguns) — pairing has its own
  file-state; state clearly which is authoritative post-change.
- Tests: two-configDir no-cross-clobber; bypass leaves OS store untouched.
