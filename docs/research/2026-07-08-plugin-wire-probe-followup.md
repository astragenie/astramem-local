# Plugin wire-probe follow-up (astramem-plugin #24 / U6)

**Date:** 2026-07-08
**Source repo:** `astramemory-plugin` (`bin/astramem connect`, `src/cli/connect.ts`)
**Target repo:** `astramemory-local` (daemon)
**Status:** plugin side landed; one decision open for the daemon team.

## What the plugin changed

`astramem connect` previously attempted `POST /register` first and fell back to
`GET /health` on 404. That fallback path was permanently dead — the daemon has
never exposed a `/register` route. Verified against `src/server/app.ts`, which
registers only:

```
health · version · ingest · search · memory · lifecycle · why · digest ·
recall · mcp · dashboard(+consolidation/jobs/search/api) · memory-tool ·
consolidation · entities · sync-status
```

The plugin now probes `GET /health` directly (5s timeout), drops the `/register`
POST entirely, and derives `bearer_valid` from the health response status
(`!== 401 && !== 403`). Plugin tests assert `/register` is never hit; `tsc`
clean; connect + dispatch suites green.

**No daemon change is required to unblock the plugin.** The rest of this report
is about a latent correctness gap the fix surfaced.

## The real finding: `bearer_valid` is a no-op on loopback

The daemon's global `preHandler` (`src/server/app.ts`) makes `/health` and
`/version` **public whenever the daemon is bound to loopback** (`isLoopbackHost`
→ `isLocalBind`). Bearer auth on those two routes only engages when the bind
host is non-loopback.

The default local setup binds `127.0.0.1:7777`. Consequences for `connect`:

- The health probe returns `200` regardless of the bearer — even with a wrong,
  expired, or absent token.
- `connect` therefore reports `bearer_valid: true` and prints a "connected"
  status **without ever validating the bearer against the daemon**.
- The bearer is only actually exercised the first time a real authed route is
  called (ingest/search/etc.) — i.e. after `connect` has already claimed success.

So on the standard local profile, `connect`'s bearer check is cosmetic. It
proves the daemon is *reachable*, not that the configured token *works*. That is
a false-confidence signal: a user with a bad token gets a green `connect` and
only discovers the problem when the first capture/recall silently 401s.

## Decision needed (daemon side)

Tracked as **[astramem-local#129](https://github.com/astragenie/astramem-local/issues/129)**.
Pick the connection contract. Options, roughly in effort order:

1. **Accept health-probe as the contract; document it.** Declare that `connect`
   verifies reachability only, and rename/reword the plugin's `bearer_valid` to
   `daemon_reachable` (plugin-side change). Cheapest; honest; loses token
   pre-validation.

2. **Add a lightweight authenticated probe route** (e.g. `GET /whoami` or
   `GET /auth/check`) that always requires Bearer, even on loopback, and returns
   the token's identity/validity. `connect` probes that instead. Gives real
   pre-validation without loosening the public-health-on-loopback ergonomics
   (which exist so dashboards/curl work locally without a token).

3. **Honor an *offered* bearer on `/health` even on loopback:** if the request
   carries an `Authorization` header, validate it and 401 on mismatch; if absent,
   stay public. Keeps one route, preserves tokenless local use, makes the probe
   meaningful when a token is supplied. Slightly subtle (auth becomes
   conditional on header presence).

**Recommendation: option 2.** A dedicated authed probe keeps the public-health
contract intact for tooling and gives `connect` a route whose whole purpose is
"does this token work" — no conditional-auth footgun, no overloading `/health`.

## Plugin-side action tracker (#24)

- [x] Remove dead `POST /register` path — done, landed.
- [x] Probe `GET /health`, unify 5s timeout — done.
- [x] **Stop claiming false validity.** `connect` no longer reports
  `bearer_valid: !!bearer` on a public 200. `ConnectResult` now carries an
  honest tri-state `bearer_status: 'absent' | 'rejected' | 'unverified'`
  (`unverified` on a public-`/health` 200, `rejected` only on an explicit
  401/403). Output and `local.json` cache updated; two regression tests added.
- [ ] **Make it `verified` — blocked on [#129](https://github.com/astragenie/astramem-local/issues/129).**
  Once the daemon ships an authed probe route (option 2/3), point `connect` at it
  and add a `'verified'` status.

Until then, `connect` on the default loopback profile reads as "daemon is up,
bearer unverified," not "your token is good."
