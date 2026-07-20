# Handoff: FEAT-483 SLICE-5 — dashboard-forms e2e (browser-shaped 415 class)

**Objective:** Build a browser-shaped dashboard-route e2e test exercising
every dashboard form action with the exact content-type a browser sends
(`application/x-www-form-urlencoded`), and fix the underlying 415 bug if
still present.

**Owner:** crew:fullstack-dev

**Outcome: DONE — bug already fixed, no product code change needed.**

## What was found

`src/server/app.ts` already registers
`app.addContentTypeParser('application/x-www-form-urlencoded', ...)`,
shipped in PR #172 ("fix(dashboard): make consolidation accept/reject work
from a browser + close devNoAuth CSRF hole"), long before this slice was
dispatched. The only dashboard `<form method="post">` actions anywhere in
the codebase are `accept`/`reject` in
`src/server/routes/dashboard-consolidation-html.ts` — confirmed by
`grep -rn '<form method="post"' src/server/routes/dashboard-*.ts` and
`grep -rn 'app\.post(' src/server/routes/dashboard-*.ts`. Both are already
exercised end-to-end (urlencoded content-type, cookie-only auth, no
Authorization header) in `tests/server/dashboard-consolidation-html.test.ts`
(22/22 passing).

`dashboard-api-html.ts`, named in the original dispatch as the likely fix
site, has no POST routes at all — it is a GET-only API reference page.

## Deliverable

Added `tests/server/dashboard-forms.test.ts` — the dedicated,
FEAT-483-requested canary: one parametrized row per dashboard form action
(`accept`, `reject`), each sent with the exact shape a real `<form>` submit
produces (urlencoded content-type, empty body, session cookie only),
asserting a 303 (not 415). Comment documents the enumeration source so a
future dashboard form that skips this coverage is easy to catch.

## Evidence

- `bunx vitest run tests/server/dashboard-forms.test.ts` → 3/3 pass
- `bunx vitest run tests/server` → 38 files / 574 tests pass
- `bunx tsc --noEmit -p .` → exit 0
- `bunx tsc --noEmit -p tsconfig.tests.json` → exit 0

## Changed files

- `tests/server/dashboard-forms.test.ts` (new)

## Confidence

High — verified by full scoped test run + both tsc configs, and by grepping
the entire `dashboard-*.ts` route surface for form/POST actions rather than
trusting the dispatch's assumed file.

## Risks / open questions

None. No product code changed since nothing was broken.

## Branch / PR

- Branch: `feat/483-s5-dashboard-415`
- PR: https://github.com/astragenie/astramem-local/pull/448

## Suggested next handoff

None — slice complete as scoped.
