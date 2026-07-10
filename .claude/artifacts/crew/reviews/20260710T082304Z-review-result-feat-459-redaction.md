# Review Result — FEAT-459 (stage-0 redaction compound-label hardening)

**Commit:** `3eadb8c` on `feat/feat-459-redaction`
**Reviewer:** independent adversarial review (both directions: missed secrets AND false positives)
**Verdict: NEEDS_FIX**

## Scope

`src/redact/detectors.ts` (`generic_credential` label regex: `\b` → `(?<![A-Za-z])`),
`src/redact/entropy.ts` (comment only), 3 test files (fixture flips + new fixtures + perf smoke).

## AC-by-AC verification (all 5 pass on their own terms)

Verified empirically against the actual shipped regex (`node`, not just reading), not just by
reading the tests:

- **AC-1** (`INTERNAL_SECRET=abc123` → redacted): PASS. Confirmed via direct regex exec and via
  `tests/security/redact-autocapture.test.ts` (flipped GAP test).
- **AC-2** (`OPENAI_API_KEY=sk-proj-...` → redacted via lookbehind, independent of entropy):
  PASS. Confirmed via direct regex exec (`API_KEY=sk-proj-...` matched, cap group correct).
- **AC-3** (17-char labeled fragment redacted; same fragment unlabeled NOT redacted): PASS.
  `generic_credential`'s captured group `(\S+)` has no length floor (true both before and after
  this commit — verified by diffing `detectors.ts` at `b5f1cee` vs `3eadb8c`, the commit
  message's claim here is accurate, not just asserted). `entropy.ts`'s `MIN_TOKEN_LENGTH = 20`
  floor is unchanged and correctly documented as unlabeled-only.
- **AC-4** (GAP tests flipped, full suite green, zero new false positives): PASS. Diffed
  `tests/security/redact-autocapture.test.ts` directly — both `GAP:`-prefixed tests are
  genuinely flipped to positive assertions, not just renamed. Ran the full suite (see below).
- **AC-5** (perf smoke logs concrete before/after, not vacuous pass/fail): PASS. The perf test
  logs p50/p95/mean/max via `console.log` AND does a real old-pattern-vs-new-pattern
  head-to-head bench with a bounded regression assertion (`after.mean < max(before.mean*5, 1)`),
  not just a fixed threshold on the new pattern alone. Meaningful, not vacuous.

## Suite / build

- `npx vitest run` (full suite): 189/190 files passed, 2220/2227 tests passed, 1 failed
  (`tests/scripts/post-merge-rebuild.test.ts`, a 5s timeout in an unrelated git-fixture-repo
  test). Re-ran that file in isolation: **8/8 passed** — confirmed pre-existing flake under
  parallel suite load, not caused by this diff. Close to but not exactly the claimed
  "190/2221/0 failed" baseline; the discrepancy is this one flaky file, already reproduced as
  flaky rather than broken.
- Ran the 3 redaction-specific test files in isolation: **64/64 passed**.
- `npx tsc --noEmit -p .`: clean, no errors.

## Finding 1 (HIGH — root cause of NEEDS_FIX): keyword-as-leading/middle-token compound labels still silently unmatched

The fix only widens the *boundary* check (`\b` → lookbehind); it does not change where the
keyword must sit relative to the separator. `generic_credential` still requires the recognized
keyword to be the **last** token immediately before `[:=]`. Verified empirically:

```
SECRET_KEY=abcdefgh1234        -> NO MATCH
DJANGO_SECRET_KEY=abcdefgh1234 -> NO MATCH
JWT_SECRET_KEY=abcdefgh1234    -> NO MATCH
APP_SECRET_KEY=abcdefgh1234    -> NO MATCH
PASSWORD_HASH=abcdefgh1234     -> NO MATCH
secret_key_base: abcdefgh1234  -> NO MATCH
TOKEN_SECRET=abcdefgh1234      -> matches ("secret" is last token)
SECRET_TOKEN=abcdefgh1234      -> matches ("token" is last token)
```

`SECRET_KEY` compounds this with a second, independent gap: bare `key` (without an `api`
prefix) has never been a recognized keyword, only `api[_-]?key` is — so even a hypothetical
"keyword anywhere in the compound" fix wouldn't rescue `SECRET_KEY=`, `PRIVATE_KEY=` (non-PEM),
`ENCRYPTION_KEY=`, `SIGNING_KEY=` on its own.

This matters because `SECRET_KEY` is arguably *the* single most common secret-label string in
the wild (Django's `settings.py` default, Flask's `app.secret_key`, Rails'
`secret_key_base`, countless `.env` files). A short, low-entropy value in that shape —
`SECRET_KEY=abc123`, structurally identical to this FEAT's own headline fixture
`INTERNAL_SECRET=abc123` — reproduces exactly the pre-fix bug this FEAT exists to close, and
does so silently: nothing in the diff documents this as an accepted scope boundary the way
`entropy.ts`'s unlabeled-floor decision is documented. The FEAT's own scope text lists the
patterns it intends to cover (`X_SECRET=`, `X_API_KEY=`, `X_TOKEN=` — all trailing-keyword
forms), so this isn't a broken promise against the letter of the ACs, but it undercuts the
commit message's broader claim ("the label side matches compound forms") and leaves the
detector's real-world coverage meaningfully narrower than a reader would assume. Recommend
either widening the label regex to match the keyword anywhere in an underscore-delimited
compound (not just as the final segment) before merge, or explicitly documenting this as a
known scope boundary with a follow-up FEAT filed — the same treatment already given to the
unlabeled-entropy-floor decision in `entropy.ts`.

## Finding 2 (LOW — recommend follow-up, not blocking): quoted/JSON label forms don't match

```
"OPENAI_API_KEY": "sk-abc"   -> NO MATCH
```

The separator match (`\s*[:=]\s*`) must sit immediately after the keyword with only whitespace
in between; a closing quote character breaks it. This is a pre-existing gap (the old `\b`
anchor wouldn't have matched this compound label either, so it's not a regression), but it's a
common real-world shape for secrets to leak (JSON logs, request/response bodies, `.env.json`)
and worth a follow-up ticket. Not in this FEAT's stated scope, not blocking.

## Everything else checked clean

- **False positives**: all specified risky shapes (`NODE_ENV=`, `LOG_LEVEL=`, `PORT=`,
  `MAX_TOKENS=`, `primary_key=id`, `monkey=business`, `authtoken=`, `topsecret=`) correctly do
  NOT match, verified by direct regex execution, not just by reading the test file. Additional
  shapes I tried that aren't in the test file but should be watched (`RETRY_LIMIT=`,
  `SESSION_TIMEOUT=`, `const API_KEY_HEADER = 'x-api-key';`, `XAPI_KEY=` mid-word) also
  correctly do NOT match — no new false positives found in either direction.
- **Digit/underscore-adjacent labels** (`KEY2_SECRET=`, `_SECRET=`, `1SECRET=`) correctly DO
  match per the documented lookbehind semantics; letter-adjacent mid-word collisions
  (`aSECRET=`, `XAPI_KEY=`) correctly do NOT — the lookbehind is doing exactly what the comment
  in `detectors.ts:76-92` claims.
- **Short-fragment policy claim** (Finding 3 in the dispatch brief): confirmed against
  `git show b5f1cee:src/redact/detectors.ts` — the captured value group had no minimum length
  even pre-fix, so the "already had no minimum length" claim in the commit message and in the
  new `entropy.ts` comment is accurate, not retroactively rationalized. The floor staying fixed
  for unlabeled-only matches is explicitly documented at `entropy.ts:10-19`.
- **Perf**: not vacuous — see AC-5 above.

## Recommendation

Fix Finding 1 (or explicitly scope it out with a documented follow-up FEAT, mirroring how the
unlabeled-entropy-floor decision was documented) before merge. Everything else in the diff is
correct, well-tested, and matches its stated claims.
