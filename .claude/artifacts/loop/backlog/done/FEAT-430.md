---
id: FEAT-430
status: done
priority: null
category: security
target_release: null
created: 2026-07-05
depends_on: []
slices: []
derived_from: null
tags: [concern:security]
autonomous_safe: null
triage_notes: "Security hardening: Bearer-token auth compare in src/server/app.ts:113 used JS `!==`, a variable-time string compare — first differing byte short-circuits, which is a classic timing side-channel an attacker can use to recover MEMORY_BEARER byte-by-byte given enough samples. Hardened to a fixed-length-digest constant-time compare (src/server/lib/secure-compare.ts, safeBearerEqual) so no length or byte-position branch is observable. No auth-boundary behavior changed: /health and /version stay public only on loopback bind (FEAT-406 unchanged); every other route still 401s on wrong/missing token."
---

# FEAT-430: Bearer auth timing-safe hardening

## Description

The daemon's global `preHandler` auth hook (`src/server/app.ts`) gates every
route except `/dashboard` (own token check) and `/health`/`/version` on a
loopback bind (FEAT-406). The gate compared the incoming `Authorization`
header to the expected `Bearer <MEMORY_BEARER>` value with plain string
`!==`. JS string comparison short-circuits at the first differing
character, so response latency correlates with how many leading bytes of
the guess are correct — a remote timing side-channel that can, with enough
samples, recover the bearer token one byte at a time.

## Fix

`src/server/lib/secure-compare.ts` adds `safeBearerEqual(a, b)`: both sides
are SHA-256 hashed to a fixed 32-byte digest, then compared with
`node:crypto`'s `timingSafeEqual`. Hashing first (rather than trying to pad
raw strings to equal length) sidesteps `timingSafeEqual`'s "different
buffer length" throw entirely — the digests are always the same length
regardless of input length, so there is no length branch left to leak and
no special-case needed for the length-mismatch path.

`src/server/app.ts`'s auth hook now calls `safeBearerEqual(auth, `Bearer
${opts.token}`)` in place of `!==`; `auth` defaults to `''` when the header
is absent so a missing header still 401s through the same constant-time
path instead of an early return.

## Acceptance criteria (Given / When / Then)

**AC-1** Given a request with the correct `Authorization: Bearer <token>`, When it hits any authenticated route, Then it is authorized (200/expected status) — unchanged from prior behavior.
**AC-2** Given a request with an incorrect token of the *same* byte length as the correct token, When it hits any authenticated route, Then the response is 401.
**AC-3** Given a request with an incorrect token of a *different* byte length than the correct token, When it hits any authenticated route, Then the response is 401 (no throw, no 500).
**AC-4** Given a request with no `Authorization` header at all, When it hits any authenticated route, Then the response is 401.
**AC-5** Given the change, When `/health` and `/version` are requested on the default loopback bind, Then they remain public (no Bearer required) — the auth-boundary rule from FEAT-406 is unchanged.
**AC-6** Given the change, When any other route is requested without/with a wrong Bearer, Then it still 401s exactly as before — no route that was gated became public or vice versa.

## Verification

- `tests/server/bearer-timing-safe.test.ts` — new: correct token (200), wrong
  token same length (401), wrong token different length (401), missing header
  (401), plus unit coverage of `safeBearerEqual` (equal/mismatched/empty/
  different-length, asserts no throw).
- `tests/server/remote-health-auth.test.ts` — existing FEAT-406 suite,
  re-run green to confirm the auth-boundary rule (loopback-public vs
  non-local-gated) is unaffected.
- Full `bun run build` (tsc) clean; full `vitest run` green (1292 passed,
  4 pre-existing skipped; 5 unrelated config-test timeouts observed only
  under full-suite parallel contention, reproduced as pre-existing/flaky —
  pass individually in isolation, untouched by this change).

## Notes

Worktree `wt-bearer`, branch `feat/HARD-bearer-timingsafe`. Follows the
`src/server/lib/network.ts` (`isLoopbackHost`) precedent for a small,
single-purpose auth-adjacent helper module colocated under
`src/server/lib/`.
