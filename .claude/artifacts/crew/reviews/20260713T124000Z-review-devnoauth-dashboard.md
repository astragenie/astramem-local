# Review: devNoAuth extended to /dashboard pages

**Scope:** src/server/routes/dashboard-auth.ts (new), dashboard.ts, dashboard-jobs-html.ts,
dashboard-consolidation-html.ts, dashboard-search-html.ts, dashboard-api-html.ts, app.ts (wiring),
config/config.ts (doc), README.md (doc), tests/server/dev-no-auth.test.ts.

**Verdict: NEEDS_FIX** (test-coverage gap only — no live vulnerability found; every auth-boundary
code path read correct on adversarial review).

## What was checked

### 1. 403 bypass unreachable — CONFIRMED SAFE
`dashboard.ts:37-48` calls `checkDashboardAuth`, and when it returns `{status: 403}` the handler
returns immediately (403 body, `text/plain`) *before* reaching the `?token=` bootstrap block at
`dashboard.ts:50-61`. `checkDashboardAuth` (`dashboard-auth.ts:54-60`) only ever returns 403 when
`devNoAuthActive` is true, and in that branch it never falls through to the bearer/cookie
comparison — there is no code path where a request that failed the Host check can reach the
`?token=` comparison, get a cookie set, or receive a 302. A rebinding page hitting
`/dashboard?token=<guessed>` with a forged Host gets a flat 403, no oracle.

All four sibling pages (`dashboard-jobs-html.ts:174-180`, `dashboard-consolidation-html.ts:85-91`,
`dashboard-search-html.ts:44-50`, `dashboard-api-html.ts:135-141`) follow the same
call-then-return-on-`!allowed` shape; none of them ignore the verdict or fall through to rendering.

### 2. All five pages call the shared helper — CONFIRMED
`grep` for `bearerOk|cookieOk|readCookie|COOKIE_NAME` across `src/` turns up only
`dashboard-auth.ts` itself (the one legitimate definition) and `dashboard.ts`'s
`const COOKIE_NAME = DASHBOARD_COOKIE_NAME` re-export alias — no hand-rolled duplicate logic
remains in any of the five route files. `app.ts:19-23` imports and registers exactly five
dashboard route factories (`dashboardRoute`, `dashboardConsolidationRoute`, `dashboardJobsRoute`,
`dashboardSearchRoute`, `dashboardApiRoute`) — no sixth dashboard-ish route exists.

### 3. Fail-closed default — CONFIRMED
Every route factory signature defaults `devNoAuthActive = false` (e.g.
`dashboard-jobs-html.ts:171`), so a caller that forgets the parameter fails closed to the
pre-existing Bearer/cookie behavior. `app.ts:137` computes `devNoAuthActive` once
(`devNoAuthConfigured && isLocalBind`, the same boot-computed value already forced false on a
non-loopback bind at `app.ts:128-136`) and threads that single value into all five registrations
(`app.ts:211-215`) — no route recomputes it independently from raw config.

### 4. `isLoopbackHostHeader` reuse — CONFIRMED, not forked
`dashboard-auth.ts:24` imports `isLoopbackHostHeader` from `../lib/network.ts`, the same module
`app.ts:33` imports for the API preHandler. Single implementation, no duplicate.

### 5. Timing/oracle — cosmetic only
The API preHandler's 403 body is JSON (`{error:'forbidden', reason:'non-loopback Host header'}`,
`app.ts:159`) while the dashboard helper's is plain text (`'403 Forbidden - non-loopback Host
header'`, `dashboard-auth.ts:57`). Both fire on exactly the same predicate
(`isLoopbackHostHeader`) with no timing-sensitive branching before it, so this is a content-type/
body-shape inconsistency, not an information leak. Not blocking.

Separately (pre-existing, not introduced by this diff — confirmed via `git show HEAD~3` on
`dashboard.ts`, commit `e549894`): the dashboard bearer comparison
(`dashboard-auth.ts:63`, `authHeader === \`Bearer ${token}\``) is a plain `===`, not the
constant-time `safeBearerEqual` the API preHandler uses (`app.ts:167`, FEAT-430). This review's
diff only moved that pre-existing comparison into the shared helper verbatim; it did not add or
worsen the timing side-channel. Worth a follow-up ticket, not a blocker for this change.

### 6. Tests and typecheck — RUN, real output below
```
bunx tsc --noEmit -p .        # clean, no output
bunx vitest run tests/server/dev-no-auth.test.ts
  Test Files  1 passed (1)
  Tests  17 passed (17)

bunx vitest run tests/server/dashboard-consolidation-html.test.ts \
  tests/server/dashboard-html.test.ts tests/server/dashboard-jobs.test.ts \
  tests/server/dashboard-search-html.test.ts tests/server/dashboard-subpages.test.ts \
  tests/server/dashboard.test.ts
  Test Files  6 passed (6)
  Tests  66 passed (66)
```
83/83 green. But `dev-no-auth.test.ts`'s devNoAuth-specific trio (loopback 200 / non-loopback 403)
is only exercised for **`/whoami`, `/dashboard`, and `/dashboard/jobs`** (lines 47-133). There is
no devNoAuth-mode test at all — loopback-allow or non-loopback-403 — for `/dashboard/consolidation`,
`/dashboard/search`, or `/dashboard/api`. `grep -r devNoAuth tests/` confirms the only devNoAuth
test file is `dev-no-auth.test.ts`, and `grep 'dashboard/api'` across `tests/` returns zero matches
— `dashboard-api-html.ts` has no dedicated test file at all (pre-existing gap, but this diff added
an auth parameter to it with no accompanying test either way).

Code inspection shows all three untested pages route through the identical shared
`checkDashboardAuth` call in the identical shape as the two tested pages, so I have no reason to
believe the behavior is actually wrong — but "the same helper is used" is exactly the kind of
claim a regression test should verify mechanically rather than the next reviewer re-deriving by
hand. A future refactor of `dashboard-auth.ts` or a copy-paste edit to one of these three files
could silently break the 403 guard on it with nothing to catch it.

**This is the basis for NEEDS_FIX**: add the loopback-200 / non-loopback-403 pair (at minimum) for
`/dashboard/consolidation`, `/dashboard/search`, and `/dashboard/api` to `dev-no-auth.test.ts`,
mirroring the existing `/dashboard/jobs` pair (lines 115-133).

### 7. README / config.ts prose — CONFIRMED matches implementation
`config.ts:15-40`'s doc comment and `README.md:367-390`'s "Dev no-auth mode" section both state:
devNoAuth covers API + `/dashboard` + sub-pages; dashboard's independent Bearer/cookie/`?token=`
auth applies "only while this flag is off"; the Host-header loopback guard applies uniformly; and
devNoAuth is refused (not fatal) on a non-loopback bind. All of this matches the code exactly —
no prose overclaim or understatement found.

## Summary

The auth-boundary logic itself is correct and adversarially sound: the 403 path cannot be
bypassed into the token-bootstrap flow, all five dashboard routes are wired through one shared,
fail-closed helper, the loopback guard is reused rather than forked, and documentation matches
behavior exactly. The only actionable gap is test coverage — 3 of 5 dashboard pages have zero
devNoAuth-mode regression tests despite this being an auth-boundary change. Recommend adding the
missing trio tests before merge; no code change to the auth logic itself is required.
