---
kind: handoff
objective: FEAT-472 — sync-token scoped keystore identity (mirrors FEAT-466)
owner: builder
feature: FEAT-472
worktree: C:\work\mega\astramemory-local-worktrees\w472
branch: feat/w472-wave2
created_at: 2026-07-12
confidence: high
next_handoff: reviewer
---
# Handoff — FEAT-472 build complete

**Feature:** FEAT-472 — sync-token still used the unscoped machine-global
keystore identity (`storeSyncToken`/`readSyncToken`), same collision class
FEAT-466 closed for the bearer/db-key: a sandboxed pairing flow could clobber
the production device token.

## Objective

Mirror FEAT-466 1:1 for the cloud sync device token: per-configDir scoped
credential-store identity, read-only legacy fallback, the
`ASTRA_MEMORY_TEST_FORCE_KEYFILE` bypass, a doctor row, and clarify the
sync.json-vs-keystore authority split the FEAT explicitly asked for.

## Allowed scope (as assigned)

`src/storage/keystore.ts`, sync-token call sites, `src/doctor/checks.ts`
(doctor row only), and tests. Stayed within this — see changed files below.

## What changed

- **`src/storage/keystore.ts`** — `storeSyncToken`/`readSyncToken` now take a
  required `configDir` param and follow the exact FEAT-466 shape:
  - Writes go to the scoped identity (`scopedService(configDir)`, account
    `sync-device-token`) via the same `scopedService()`/`normalizeConfigDir()`
    helpers the bearer/db-key already use — no new hashing logic.
  - Reads try scoped first, then fall back **read-only** to the legacy
    unscoped identity (service `astramem-local`, account
    `sync-device-token`) — pre-FEAT-472 installs keep working with no
    re-pair.
  - `ASTRA_MEMORY_TEST_FORCE_KEYFILE=1` bypasses the OS store entirely,
    writing/reading `<configDir>/sync-token.key` (mode 0600 + Windows ACL via
    the existing `restrictKeyFileAcl`), identical to the bearer's
    `bearer.key` bypass.
  - New `getSyncTokenIdentity(configDir)` — doctor-facing, mirrors
    `getBearerIdentity`.
  - **No `writeThroughLegacy` option** (unlike `StoreBearerOpts`) — this is
    deliberate, not an oversight. DEC-011's rollback trap is specifically a
    *rotate* hazard (a value updated in place while an old binary still reads
    the legacy identity first). The sync token has **no rotate flow** —
    confirmed by grep: `token rotate` in `cli/token.ts` is bearer-only.
    `pair` is the only write path, and it's a fresh/full re-provisioning
    action analogous to `init`, which FEAT-466 also deliberately does NOT
    write-through to legacy (writing legacy from a sandboxed first-time
    provisioning call is exactly the incident mechanism). Documented inline
    in keystore.ts above the sync-token section; revisit if a rotate-style
    operation is ever added for this token.
- **`src/cli/pair.ts`** — reordered so `configDir` is computed before
  `storeSyncToken(apiKey, configDir)` (previously computed after, and the
  call had no configDir to pass).
- **`src/cli/serve.ts`**, **`src/cli/sync.ts`** — `readSyncToken(defaultConfigDir())`
  at both call sites (shipper startup, `sync pull`). `sync.ts` gained the
  `defaultConfigDir` import (`serve.ts` already had it).
- **`src/config/sync-settings.ts`** — docblock addition stating the authority
  split explicitly (see below) plus a note that `resolveRuntimeConfig` reads
  `sync.json` unconditionally regardless of datadir overrides
  ([[daemon-spawn-footguns]] memory finding — sandboxing datadir alone does
  NOT sandbox sync.json).
- **`src/doctor/checks.ts`** — new `checkSyncTokenLocation()` check,
  registered right after `checkBearerLocation()`. Reports:
  - `sync not paired` (ok:true) when `sync.json` has no `enabled: true` — a
    never-paired install is not a doctor warning, unlike the bearer which
    always must exist.
  - `ASTRA_SYNC_TOKEN env override active` (ok:true) when the env var wins.
  - `OS credential store (identity: scoped|legacy)` (ok:true) when found.
  - `missing — sync.json is paired but no device token is stored` (ok:false)
    with a fix hint to re-`pair` or set `ASTRA_SYNC_TOKEN`.
- **`tests/security/sync-token-keystore.test.ts`** (new) — mirrors
  `bearer-keystore.test.ts`'s patterns exactly (stubbed `Entry` ctor via the
  existing `__setEntryCtorForTests` seam, no real OS keychain touched):
  roundtrip, unavailable-store fallback, two-configDir no-cross-clobber,
  legacy read-fallback + scoped-wins-over-stale-legacy, a
  2026-07-10-incident-class "prod entry untouched by sandboxed write"
  scenario, and the full `ASTRA_MEMORY_TEST_FORCE_KEYFILE` bypass suite
  (never-constructs-Entry + before/after byte-identical store). Kept as a
  sibling file rather than appended to `bearer-keystore.test.ts` since that
  file also covers `resolveBearerToken` precedence/promotion/isolation,
  which has no sync-token analog — appending would have diluted the file's
  focus.

## Authority statement (sync.json vs keystore) — required by the FEAT

- **`sync.json`** (`config/sync-settings.ts`) is authoritative for
  **connection metadata**: `enabled`, `url`, `workspaceId`, `tenantId`.
- **The keystore entry** (or `ASTRA_SYNC_TOKEN`) is authoritative for the
  **credential** itself (the device token/API key).
- Neither ever holds the other's data. Both are required together before the
  shipper (`serve.ts`) or `sync pull` (`sync.ts`) will activate.
- **Rollback**: rolling back the *binary* to pre-FEAT-472 after a fresh
  (post-FEAT-472) `pair` finds no legacy-identity entry (pair never writes
  one) and, if `ASTRA_SYNC_TOKEN` isn't set, resolves to "device-token
  incomplete" — the existing safe no-op path already logged in
  `serve.ts`/`sync.ts`. Re-running `pair` recovers it. This is a UX
  inconvenience, not a security incident, and mirrors the accepted tradeoff
  shape of FEAT-466 AC-2 (pre-scoping installs read fine; only a **binary**
  rollback across the scoping boundary needs a re-provision, same as it
  would for the bearer if `init` were ever re-run post-rollback).

## Test evidence

- `bun run build` (tsc -p .) — clean, no errors.
- `npx vitest run tests/security/sync-token-keystore.test.ts
  tests/security/bearer-keystore.test.ts tests/cli/pair.test.ts
  tests/cli/sync.test.ts` — **58/58 passed**.
- `npx vitest run tests/doctor tests/cli/serve.test.ts` — **80/80 passed**.
- Full suite: `npx vitest run` — **210 files, 2492 passed, 6 skipped**
  (pre-existing skips, unrelated to this change), 0 failed.
- No real OS credential store was touched at any point — all keystore tests
  use the stubbed `Entry` ctor seam; `ASTRA_MEMORY_TEST_FORCE_KEYFILE` was
  only ever set inside test `afterEach`-cleaned scopes.

## Confidence

High. Small, precedented, mechanical mirror of an already-shipped and
reviewed pattern (FEAT-466); no new abstractions; full suite green.

## Risks / open questions

- No `sync-token rotate` CLI command exists today, so the `writeThroughLegacy`
  question is moot for now — flagged above for whoever adds one later.
- `checkSyncTokenLocation()`'s "not paired" branch trusts `sync.json`'s
  `enabled` flag; if `sync.json` is corrupt, `readSyncSettings` already
  returns `null` (existing null-safety), which this check treats the same as
  "not paired" — consistent with how `serve.ts` already treats a missing/
  corrupt `sync.json` (falls back to config defaults, sync off).

## Suggested next handoff

Reviewer — independent review of `src/storage/keystore.ts`,
`src/doctor/checks.ts`, and the three call-site edits, focused on: does the
no-`writeThroughLegacy` reasoning hold up, and does the new doctor check's
"not paired" branch correctly avoid false-positive warnings on a fresh
install.
