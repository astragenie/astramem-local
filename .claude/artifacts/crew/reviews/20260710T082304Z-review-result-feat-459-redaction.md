# Review Result — FEAT-459 (stage-0 redaction compound-label hardening)

**Commit:** `3eadb8c` on `feat/feat-459-redaction`
**Reviewer:** independent adversarial review (both directions: missed secrets AND false positives)
**Original verdict: NEEDS_FIX** — see re-review below.
**Final verdict (after fix commit `4661587`): PASS**

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

## Recommendation (original pass)

Fix Finding 1 (or explicitly scope it out with a documented follow-up FEAT, mirroring how the
unlabeled-entropy-floor decision was documented) before merge. Everything else in the diff is
correct, well-tested, and matches its stated claims.

---

## Re-review — fix commit `4661587`

**Verdict: PASS.** Finding 1 is resolved. All checks below were re-run empirically (direct
regex/redactText execution, not just reading the diff or trusting the commit message).

### 1. The 5 confirmed misses, re-tested

Ran `redactText()` directly (via a throwaway vitest probe, deleted after) on all 5 originally-
failing fixtures — all now redact correctly, with the secret substring absent from output and a
`generic_credential` event emitted:

```
SECRET_KEY=abcdefgh1234        -> redacted (cap "abcdefgh1234")
DJANGO_SECRET_KEY=abcdefgh1234 -> redacted
JWT_SECRET_KEY=abcdefgh1234    -> redacted
APP_SECRET_KEY=abcdefgh1234    -> redacted
secret_key_base: abcdefgh1234  -> redacted (colon separator, Rails form)
```

### 2. Two-tier design — trailing-only keywords stay trailing-only

Confirmed `token`/`api_key` were deliberately NOT widened (a second `PatternDetector` entry
restricted to `secret|password|passwd|pwd` was added instead of touching the original). Verified
the cited ambiguous-keyword shapes still produce zero events:

```
TOKEN_LIMIT=4096  -> NOT redacted
TOKEN_COUNT=5     -> NOT redacted
KEY_SIZE=256      -> NOT redacted
```

`KEY_SIZE=` in particular confirms bare `key` is still not a recognized keyword under either
detector (only `api[_-]?key` is), so this isn't just "token stayed narrow" — the fix didn't
quietly widen `key` either, consistent with the commit message.

### 3. Value guard scoped correctly to the new any-segment detector only

```
PASSWORD_MIN_LENGTH=8      -> NOT redacted (numeric, guarded)
SECRET_ROTATION_DAYS=30    -> NOT redacted (numeric, guarded)
SECRET_SCAN_ENABLED=true   -> NOT redacted (boolean, guarded)
SECRET_SCAN_ENABLED=false  -> NOT redacted (boolean, guarded)
DB_PASSWORD=letmein123456  -> redacted (trailing match, no guard applied — value isn't
                               numeric/boolean here anyway, but confirms the guard is wired to
                               `valueFilter` on the any-segment detector only, per
                               `src/redact/index.ts:97`, not injected into the shared path)
```

Also checked a case the brief didn't ask for but that specifically exercises the guard's scope
boundary: `SECRET_KEY_ROTATION_DAYS=30` (leading keyword `secret`, trailing segment numeric) —
correctly NOT redacted, confirming the guard applies to the whole captured value regardless of
where in the compound the keyword sits, not just to single-segment cases.

Also spot-checked the entropy-side companion guard (`CONFIG_ASSIGNMENT_RE` in `entropy.ts`) is
real, not decorative: `PASSWORD_MIN_LENGTH=8` produces **zero** events overall (not just zero
`generic_credential` events) — if the entropy guard weren't there, this LABEL=VALUE token's
high character diversity could still have cleared the 4.0 bits/char threshold and gotten
flagged as `high_entropy` despite the pattern-detector guard correctly declining it. Confirms
the two guards (detectors.ts value filter + entropy.ts config-assignment regex) are actually
both load-bearing, not redundant.

### 4. Full original false-positive matrix, re-run against the new code

Every false positive from my original review still holds with both new detectors active:
`NODE_ENV=`, `LOG_LEVEL=`, `PORT=`, `MAX_TOKENS=`, `primary_key=id`, `monkey=business`,
`authtoken=`, `topsecret=`, `RETRY_LIMIT=`, `SESSION_TIMEOUT=`,
`const API_KEY_HEADER = 'x-api-key';`, `XAPI_KEY=`, plus `cache_key=abc` (new, since the
any-segment detector's docstring specifically calls out `cache_key=`/`sort_key=` as intended
non-matches). Also verified no double-redaction / overlap artifact on a case designed to trigger
both detectors at once: `MY_SECRET_PASSWORD=hunter2222` matches via the any-segment detector
(`secret` is a leading segment) — confirmed exactly one `generic_credential` event fires and the
full secret is absent from output, via `dedupeOverlaps` in `src/redact/index.ts` (sorts by
span start, keeps first non-overlapping) correctly resolving the two candidate spans from the
two `generic_credential`-typed detectors into one.

### 5. Design documented at the pattern site

`src/redact/detectors.ts`'s new block (comment above the any-segment detector) documents: why
`secret`/`password`/`passwd`/`pwd` are high-precision enough to widen, why `token`/`api_key`
are deliberately excluded (cites `TOKEN_LIMIT=`/`TOKEN_COUNT=`/`KEY_SIZE=` as the concrete FP
risk), why bare `key` stays unrecognized, and why the value-side guard exists. `entropy.ts`'s
new comment documents the companion gap it closes and includes the measured motivating case
(`PASSWORD_MIN_LENGTH=8` scoring >4.0 bits/char). Same standard as the original commit's
documentation — no regression in rigor.

### 6. Suite / build

- `npx tsc --noEmit -p .`: clean.
- `npx vitest run` (full suite): **190/190 files passed, 2230/2230 non-skipped tests passed** (6
  skipped, 0 failed) — matches the team-lead-reported baseline exactly. Notably the
  `tests/scripts/post-merge-rebuild.test.ts` timeout flake from my original review run did NOT
  recur this time, consistent with it being an unrelated parallel-load flake rather than
  anything caused by this branch.
- Confirmed the 6 skipped tests are unrelated to redaction: they live in
  `tests/providers/{openai-compatible-llm,ollama-embed,ollama-llm,azure-llm,codex-subscription-llm,azure-embed}.test.ts`
  (live-service integration tests), `tests/e2e/plugin-flow.test.ts`, and
  `tests/config/migrate-dirs-reconcile.test.ts` — nothing under `tests/security/` is skipped.

### Outstanding (non-blocking, unchanged from original review)

Finding 2 (quoted/JSON label forms like `"OPENAI_API_KEY": "sk-abc"` still not matched) was not
in scope for this fix and remains open as a low-severity follow-up candidate, same as before.

## Final recommendation

Ship it. Finding 1 is fully resolved with a well-scoped, well-documented, well-tested two-tier
design that keeps the false-positive posture intact and adds a genuinely necessary companion
guard on the entropy side. No new issues introduced.
