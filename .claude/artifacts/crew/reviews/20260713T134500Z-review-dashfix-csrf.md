# Review: dashboard accept/reject CSRF hardening (adversarial re-verification)

**Date:** 2026-07-13
**Scope:** `src/server/lib/origin-guard.ts`, `src/server/app.ts` (devNoAuth preHandler Origin
check + urlencoded parser), `src/server/routes/dashboard-auth.ts`, `src/server/routes/dashboard-consolidation-html.ts`,
`src/server/routes/consolidation.ts` (extracted `resolveProposal`), `tests/server/dashboard-consolidation-html.test.ts`.

**Verdict: PASS**

## 1. Re-ran the exact proven pre-fix exploit against the current tree

Wrote a throwaway vitest test (`tests/server/_tmp-attack-verify.test.ts`, deleted after the run)
reproducing the previously-proven attack: `devNoAuth: true`, `Host: 127.0.0.1:7777`,
`Origin: http://evil.example`, `Content-Type: application/x-www-form-urlencoded`, empty body, no
credentials, against both the new dashboard route and the old API route.

Actual output:

```
DASHBOARD route attack -> status: 403
  proposal status after: pending
OLD API route attack -> status: 403
  proposal status after: pending
{"...","msg":"dev no-auth mode: rejected non-loopback Origin header"}
```

Both `POST /dashboard/consolidation/proposals/attack-dash-1/accept` and
`POST /consolidation/proposals/attack-api-1/accept` returned **403**, and the proposal remained
`pending` in the repo (not just a status-code check — verified via `ProposalRepo.get(...).status`
post-request in-process). The exploit is closed on both surfaces.

## 2. `originIsLoopback` adversarial vector sweep

Wrote a throwaway vitest file (`tests/server/_tmp-origin-guard-adversarial.test.ts`, deleted after
the run) covering: `http://localhost.evil.com`, `http://127.0.0.1.evil.com`, literal `"null"`,
`http://127.0.0.1:7777`, `https://localhost`, empty string, `http://evil.com@127.0.0.1` (userinfo
trick), `http://127.0.0.1@evil.com` (reverse userinfo trick), IPv6 (`http://[::1]:7777`,
`http://[::1]`), decimal/hex IP obfuscation (`http://0x7f000001`, `http://2130706433`, `http://127.1`),
a non-URL garbage string, and case/trailing-dot variants of `localhost`.

Result: **no bypass**. It correctly uses `new URL(origin).hostname` (not substring/regex matching),
so every subdomain/userinfo trick that puts `localhost`/`127.0.0.1` somewhere other than the actual
hostname position was rejected, and every genuine loopback encoding (including decimal/hex IPs and
`127.1`, which the WHATWG URL parser itself normalizes to `127.0.0.1`) was correctly accepted.
Malformed/opaque origins (`"null"`, empty string, garbage) throw inside `new URL()` and are caught
→ `false` → rejected, which is the safe direction.

**One correctness finding (not a bypass — fails closed):**

- **[LOW] `src/server/lib/origin-guard.ts:17`** — `new URL(origin).hostname` returns IPv6 hosts
  **with** brackets (e.g. `"[::1]"`), but `isLoopbackHost` (`network.ts:14`) compares against the
  bare literal `'::1'`. So `originIsLoopback('http://[::1]:7777')` and
  `originIsLoopback('https://[::1]')` both incorrectly return `false`, even though `isLoopbackHostHeader`
  (used for the `Host` header check three lines above it in the same preHandler) explicitly strips
  brackets and *does* treat `::1` as loopback. Net effect: a daemon bound to `::1` (a supported
  loopback bind — `isLoopbackHost` includes it) would 403 its own dashboard's form POSTs and the
  devNoAuth API path whenever the browser sends an Origin header, because the Origin check rejects
  what the Host check just accepted. This is a functional regression for IPv6-loopback binds, not a
  security hole — it fails closed (over-rejects) rather than open. Fix: reuse the same
  bracket-stripping logic `isLoopbackHostHeader` already has (or wrap `.hostname` through it) inside
  `originIsLoopback` before comparing.

## 3. Absent Origin still passes in devNoAuth (no regression to curl/CLI workflows)

Confirmed via the existing suite's `'no credentials, loopback Host, no Origin header => works'` test
(`dashboard-consolidation-html.test.ts:298`) — passed. `app.ts:176-184` only runs the rejection when
`origin` is truthy (`if (origin && !originIsLoopback(origin))`), so curl/scripts with no Origin
header are unaffected.

## 4. Default (Bearer) mode unchanged

- `dashboard-auth.ts:80-90` — the non-devNoAuth branch is untouched: only `bearerOk || cookieOk`,
  no Origin check added or needed there.
- `app.ts`'s API preHandler non-devNoAuth branch (`app.ts:188+`) requires `safeBearerEqual` against
  the Bearer token; no Origin check applies (correctly — Bearer can't be forged by a cross-site form).
- Confirmed the dashboard session cookie is set with `HttpOnly; SameSite=Strict; Path=/dashboard`
  (`dashboard.ts:58`) — `SameSite=Strict` means a cross-site `<form>` POST simply never attaches the
  cookie, and `Path=/dashboard` means it wouldn't reach `/consolidation/...` even if it did. The
  doc-comment reasoning in `dashboard-consolidation-html.ts`'s file header matches the actual code.

## 5. Buttons actually work end-to-end (not just status codes)

`dashboard-consolidation-html.test.ts`'s `'real browser flow: cookie-only accept/reject actually
resolves the proposal...'` tests bootstrap via `GET /dashboard?token=`, extract the `Set-Cookie`,
then POST cookie-only urlencoded to the new route, and assert **both** a 303 redirect **and**
`ProposalRepo.get(id)?.status` flipped to `accepted`/`rejected` — real state change, not just the
HTTP response. Passed.

## 6. `resolveProposal` extraction is behavior-preserving

`consolidate.test.ts` (the old API route's full suite: run/list/accept/reject/404/409/bulk/kind
filters) passed unchanged against the refactored `consolidation.ts`, which now delegates to the
shared `resolveProposal` in the same file. No behavior drift on the pre-existing API surface.

## 7. Actual command output

```
$ bunx tsc --noEmit -p .
(no output — clean)

$ bunx vitest run tests/server/dashboard-consolidation-html.test.ts tests/server/dev-no-auth.test.ts tests/consolidate/consolidate.test.ts
 Test Files  3 passed (3)
      Tests  78 passed (78)
   Duration  1.90s
```

## Summary

The CSRF hole is closed on both the new dashboard-scoped mutation routes and the old Bearer-only
API route (devNoAuth Origin check applied to both surfaces via the same `originIsLoopback` helper).
`originIsLoopback` correctly parses with `URL` rather than substring-matching and resists every
bypass vector tried, including userinfo tricks and numeric IP obfuscation. Absent-Origin curl/CLI
flows and default Bearer-mode behavior are unaffected. The buttons work end-to-end with real proposal
state changes verified, and the `resolveProposal` extraction preserves the old API route's behavior.

One non-blocking LOW-severity correctness bug found: `originIsLoopback` doesn't strip IPv6 brackets
before comparison, so it over-rejects (fails closed, not a bypass) Origin headers from IPv6-loopback
binds (`::1`) that `isLoopbackHostHeader` would accept for the same request's `Host` header. Worth a
follow-up fix but does not block this PASS.
