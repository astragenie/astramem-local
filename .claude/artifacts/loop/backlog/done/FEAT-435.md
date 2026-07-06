---
id: FEAT-435
status: done
priority: null
category: platform
target_release: null
created: 2026-07-05
depends_on: [FEAT-416]
slices: []
derived_from: FEAT-416
tags: [concern:api, concern:consistency]
autonomous_safe: null
triage_notes: "Direct follow-up to the FEAT-416 review risk note: 'main risk is inconsistent 404/409 semantics vs sibling lifecycle routes if not copied carefully.' Audited src/server/routes/lifecycle.ts across all four lifecycle verbs (invalidate/supersede/promote/restore) and found exactly that divergence in promote's InvalidScopeTransitionError mapping (400 instead of 409) plus a missing `id` field on supersede's 409 body. Implemented in worktree wt-lifecycle / branch feat/HARD-lifecycle-conformance by centralizing the typed-error-to-status mapping in one `mapLifecycleError` helper — no new status codes invented, no success-path behavior changed."
---

# FEAT-435: normalize + lock lifecycle route error-status conformance

## Problem

The FEAT-416 review flagged a risk that the lifecycle routes (`invalidate` /
`supersede` / `promote` / `restore` in `src/server/routes/lifecycle.ts`) might
return inconsistent 404/409 semantics for the same underlying error classes,
since each handler duplicated its own `catch` block mapping the repo's typed
errors (`MemoryNotFoundError`, `MemoryConflictError`,
`InvalidScopeTransitionError`) to an HTTP status. An audit confirmed the risk:

- **`promote`** mapped `InvalidScopeTransitionError` (a valid id whose current
  scope makes the requested transition inapplicable — e.g. downward
  `team -> personal`) to **400**, while every other verb's equivalent
  "valid id, operation not applicable" case (`invalidate` on an
  already-invalid memory, `restore` on a never-archived memory, `supersede`
  onto an already-invalid target) mapped to **409**. This conflated the
  "malformed request body" class (400) with the "state conflict" class (409).
- **`supersede`**'s 409 body omitted the `id` field that `invalidate` and
  `restore` both included, so 409 responses had two different shapes across
  verbs.
- 404 body shape (`{ error: 'not found', id }`) and the centrally-enforced
  401 (`{ error: 'unauthorized' }`) were already consistent across all four
  verbs — no bugs there, but the mapping logic was copy-pasted four times
  with no single source of truth, so the next new verb could silently drift.

## Fix

- Added `mapLifecycleError(err, id, reply)` in `src/server/routes/lifecycle.ts`:
  `MemoryNotFoundError` -> 404 `{ error: 'not found', id: err.atomId }`;
  `MemoryConflictError` **and** `InvalidScopeTransitionError` -> 409
  `{ error: err.message, id }` (route `:id`); anything else rethrown. 400 is
  now reserved exclusively for malformed/invalid request bodies (zod parse
  failures), which is unaffected and unchanged.
- Every verb's catch block (`invalidate`, `erase`, `supersede`, `promote`,
  `restore`) now calls the one helper instead of duplicating the mapping.
- Updated the pre-existing `downward promotion -> 400` test to assert `409`
  (the corrected status) and added a body-shape assertion.
- No verb's success-path (200) behavior changed.

## Acceptance (PM GWT)

1. Given a nonexistent memory id, When any of invalidate/supersede/promote/restore
   is called, Then the response is 404 with body `{ error: 'not found', id }`.
2. Given a valid memory id whose current state makes the operation
   inapplicable (already-invalid, never-archived, bad supersede target, or a
   downward scope promotion), When the corresponding verb is called, Then the
   response is uniformly 409 with body `{ error: <message>, id }`.
3. Given a missing or invalid Bearer token, When any lifecycle verb is called,
   Then the response is 401 (already centrally enforced, verified for all
   four verbs).
4. Given a malformed request body, When invalidate/supersede/promote is
   called, Then the response is 400 (restore takes no body and has no 400
   case).
5. Given a parametrized conformance test iterating all four verbs, When the
   suite runs, Then it fails if any verb's status/body diverges from the
   matrix above — guarding against a future 5th lifecycle verb drifting
   silently.
6. Given the full test suite, When run after the change, Then no verb's
   200-success-path assertions changed.

## Evidence

- Before/after status matrix, verbs changed, and conformance-test pass count:
  see the crew:fullstack-dev dispatch report for
  `feat/HARD-lifecycle-conformance` (worktree `wt-lifecycle`).
- Implementation: worktree `wt-lifecycle`, branch
  `feat/HARD-lifecycle-conformance` — `src/server/routes/lifecycle.ts`
  (`mapLifecycleError` centralization), `tests/server/lifecycle.test.ts`
  (updated promote test + new `lifecycle error-status conformance (FEAT-435)`
  describe block, parametrized over all four verbs).

## Refs

- Origin: FEAT-416 review risk note (`pm_risks`), triaged FEAT-416.md.
