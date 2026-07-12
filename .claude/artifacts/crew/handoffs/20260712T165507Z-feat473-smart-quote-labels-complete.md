---
feature: FEAT-473
title: unicode smart-quote label redaction
worktree: C:\work\mega\astramemory-local-worktrees\w473
branch: feat/w473-wave3
status: build-complete
---

## Objective

Close the FEAT-463 review's disclosed LOW finding #2: curly/smart quotes
(" " ' ') around a credential label were not recognized by the
`generic_credential_quoted` detector family — a SHORT secret (under the
entropy floor) in smart-quoted JSON leaked in full; long secrets were
already caught by entropy regardless of quote style.

## What changed

- `src/redact/detectors.ts` — new exported `ANY_QUOTE_CHAR` constant
  (straight `"`/`'` plus the four Unicode smart-quote code points:
  U+2018/U+2019 single, U+201C/U+201D double), plus `DOUBLE_QUOTE_OPEN/
  CLOSE/EXCLUDE` and `SINGLE_QUOTE_OPEN/CLOSE/EXCLUDE` for the paired-value
  entries. `QUOTED_LABEL_SEP`'s label-closing-quote slot now uses
  `ANY_QUOTE_CHAR`. The 6 `generic_credential_quoted` entries (3 value
  shapes x 2 keyword families) now accept EITHER straight or curly quotes
  on EACH side of a value independently — so a value can be opened with one
  style and closed with the other (the common word-processor/chat-client
  auto-curl mangle that touches only one side), not just cleanly-paired
  straight or cleanly-paired curly.
- `src/redact/entropy.ts` — imports `ANY_QUOTE_CHAR` from detectors.ts
  (single source of truth, no second copy to drift). Two separate ASCII-only
  quote references were found and fixed here, not just the one flagged in
  the dispatch brief:
  - `LABEL_PREFIX_RE` (the FEAT-468 digit-run label guard, `hasLabelPrefix`)
    — widened per the dispatch brief's own note.
  - `LABEL_CORE_RE` + the safe-value quote-stripping in
    `isLabelWithSafeValueFollowing` (the FEAT-463 whole-token entropy-guard,
    a DIFFERENT code path than the digit-run guard) — found empirically,
    not by inspection: a curly-quoted label token like
    `“PASSWORD_MIN_LENGTH”:` failed to parse as a label under the
    ASCII-only `LABEL_CORE_RE`, so it fell through to the ordinary entropy
    check on its own raw text (curly quotes + colon included) and got
    wrongly flagged as `high_entropy` — the exact false-positive class this
    guard exists to prevent, just triggered by a different quote style than
    the ASCII repro the existing code comments document. Caught by running
    the new fixture, not assumed — see "Verification" below.
- `tests/security/redact.test.ts`:
  - 9 new `TRUE_POSITIVES` fixtures: curly-double/curly-single/mixed
    straight-curly value combos (both directions), for both the trailing
    and compound keyword families, all using SHORT secrets specifically to
    prove the total-leak class (not just "some redaction happened").
  - 5 new false-positive fixtures mirroring the existing ASCII quoted-config
    negatives, repeated with curly/mixed quotes (`“NODE_ENV”: “production”`,
    `“PASSWORD_MIN_LENGTH”: 8`, `“SECRET_SCAN_ENABLED”: “true”`, a mixed
    straight/curly variant, `“authtoken”: “abc...”`).
  - 3 new fixtures in the FEAT-468 numeric-secret false-positive corpus,
    proving the `LABEL_PREFIX_RE` widening: curly-quoted, mixed-quoted, and
    curly-label-with-bare-value labeled numeric IDs all stay unredacted.

## Verification

- `bun run build` (tsc -p .) clean throughout.
- `npx vitest run tests/security/` — 7 files / 210 tests passed (up from
  193 pre-change), 0 failed.
- Full suite: `npx vitest run` — 213 files / 2610 passed / 6 skipped / 0
  failed.
- `tests/security/redact-perf.test.ts` — p95 still comfortably under the
  20ms budget (unaffected, as expected for a character-class-only change).
- ReDoS: ran ad-hoc adversarial payloads (4-5KB strings mixing the new
  quote chars with long non-terminating runs) directly against the built
  `redactText` — all completed in 0.2-2.1ms, no exponential blowup. Expected:
  the change adds characters to existing character classes, introduces no
  new quantifiers or nested groups.
- One genuine regression caught mid-build (not assumed away): my first pass
  only widened `detectors.ts` + `LABEL_PREFIX_RE`. Running the new
  `“PASSWORD_MIN_LENGTH”: 8` false-positive fixture immediately failed
  (`[REDACTED:high_entropy:...] 8` instead of the input unchanged) — traced
  to `LABEL_CORE_RE`/`isLabelWithSafeValueFollowing` in entropy.ts, a third,
  separate ASCII-only quote-handling site not mentioned in the dispatch
  brief. Fixed and re-verified; see "What changed" above.

## AC-by-AC self-check (per FEAT-473 scope)

- Quote-class extension (U+2018/2019/201C/201D) on `QUOTED_LABEL_SEP`: PASS.
- Mixed straight/curly combinations handled: PASS — independent open/close
  classes per family, tested both directions, both quote families.
- Smart-quoted positive fixtures (short secret leak class) + benign
  smart-quoted negatives, `expectedEventCount` pattern followed: PASS — 9
  positive + 8 negative (5 quoted-config + 3 numeric-label-guard) new
  fixtures.
- ReDoS unchanged by construction: PASS — character-class-only change,
  verified empirically, not just claimed.
- redact-perf 20ms p95 budget holds: PASS.

## Risks / open items

- Did not touch `findNumericSecretRuns`'s digit-run REGEX itself
  (`DIGIT_RUN_RE`) — only its label-guard (`hasLabelPrefix`/
  `LABEL_PREFIX_RE`) needed widening; the digit-matching logic itself has
  no quote-character dependency.
- The pre-existing, disclosed escaped-inner-quote partial-redaction gap
  (`"api_key": "sk-abc\"def"` style, FEAT-463 review finding) is unchanged
  by this FEAT — still regex-tier-only, still a documented non-goal, not
  touched here.
- Did not add a fourth smart-quote family (e.g. German „ "/guillemets « »)
  — out of scope per the FEAT's own stated pair list (U+2018/2019/201C/201D
  only). Flagging as a possible future fast-follow if a real transcript
  corpus turns up other locale quote styles, not required by this ticket.
