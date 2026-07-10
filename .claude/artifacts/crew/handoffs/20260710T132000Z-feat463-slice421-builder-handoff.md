---
slice: SLICE-421
feature: FEAT-463
role: builder
status: fix_round_complete
branch: feat/feat-463-quoted-labels
commit: 32db526
review: .claude/artifacts/crew/reviews/20260710T130230Z-review-result-slice-421-feat-463-quoted-labels.md (needs_fix, Finding 1 CRITICAL closed in 32db526)
---

# SLICE-421 / FEAT-463 — builder handoff

## Fix round (2026-07-10, commit 32db526, on top of fab5173/07cc8ea) — review CRITICAL finding

Review (`20260710T130230Z-review-result-slice-421-feat-463-quoted-labels.md`) returned
**needs_fix**: all 6 ACs, structural non-overlap, ReDoS safety, and AC-4's pure-addition
guarantee were independently re-verified and confirmed genuine, but flagged one
CRITICAL finding in the "unplanned" `entropy.ts` guard added alongside the detector work.

**Finding 1 (CRITICAL, reproduced by reviewer, now fixed):** the original guard —
`LABEL_ONLY_RE.test(token) && SECRET_LABEL_KEYWORD_RE.test(token)` — suppressed entropy
detection on any token *shaped* like a value-less label (identifier ending in a bare
`:`/`=`) that merely *contained* a recognized keyword substring, without verifying there
was actually no value attached. A genuine high-entropy secret can satisfy that exact
shape: the reviewer reproduced `mysecrettoken1234567890abcdef=` (entropy 4.507, no
pattern-detector hit, contains "secret"/"token") sailing through all three redaction
stages as full plaintext, plus a `:`-trailing variant and an underscore-segment variant
(`my_secret_token_9f8a7b6c5d4e3f2a1b0c=`) proving "exact segment, not substring" alone
doesn't close it either. A no-keyword control with the identical shape redacted
correctly, isolating the keyword check as the exact hole.

I verified the reviewer's own suggested "simplest form" fix (suppress only when the
label's own entropy is below threshold) does **not** actually work before implementing
it: `"PASSWORD_MIN_LENGTH":` itself scores 4.096 bits/char, above the 4.0 default
threshold, so that check would have wrongly un-guarded the very AC-3 fixture it was
supposed to keep green. Implemented the reviewer's other proposed direction instead —
context-aware, verified against all four cases before committing:
`isLabelWithSafeValueFollowing()` (`src/redact/entropy.ts`) only suppresses entropy on a
label-shaped, keyword-containing token when a genuinely safe value (digits or a boolean
literal, optionally quoted) is found as the *next* whitespace-delimited token in the
text. Nothing following (the shape of all three bypass repros) or an unsafe next token
means the label-shaped token falls through to the ordinary entropy check like any other
token — so a real secret in that shape still gets redacted.

Also addressed review finding #2 (LOW, disclosed, non-blocking): added an inline code
comment at the escaped-quote value-capture regex site in `detectors.ts` (not just the
handoff doc) documenting the partial-redaction limitation for `"key": "va\"lue"`-style
escaped inner quotes — left unfixed per the FEAT's own non-AST-parsing non-goal, per the
reviewer's own recommendation (fast-follow, not a blocker). Unicode smart-quotes
(finding in the same section) intentionally left untouched per team-lead instruction —
out of scope, follow-up FEAT.

New tests in `tests/security/redact.test.ts` (4 new `TRUE_POSITIVES` fixtures): the
reviewer's three exact bypass repros (trailing `=`, trailing `:`, underscore-segment
variant) now redact as `high_entropy`, plus the no-keyword control fixture confirming
the identical shape without a keyword substring redacts correctly either way (regression
guard against reintroducing an overly-broad "any label-shaped token" check in the
future).

### Re-run self-verify gates (fix round)
- `bunx tsc --noEmit` — exit 0, no output.
- `bun run build` — exit 0 (`tsc -p .` clean).
- `bun vitest run tests/security/redact.test.ts` — **76/76 passed** (72 prior + 4 new
  bypass-regression fixtures).
- `bun vitest run tests/security/redact-perf.test.ts` — **2/2 passed**. Logged:
  `p50=0.125ms p95=0.248ms mean=0.145ms max=0.979ms` — still ~80x under the 20ms budget
  (AC-6 unaffected by the entropy-stage change).
- `bun vitest run tests/security` (full directory) — **6 files / 117 tests passed, 0
  failed** (up from 113 by the 4 new fixtures).
- `bun run test` (full suite) — **198 files / 2345 tests passed, 6 skipped
  (pre-existing, unrelated), 0 failed** (up from 2341 by exactly the 4 new tests).

### Bypass repro evidence (before/after)
| input | before (this fix round) | after |
|---|---|---|
| `mysecrettoken1234567890abcdef=` | suppressed, full plaintext leak | redacted as `high_entropy` |
| `mysecrettoken1234567890abcdef:` | suppressed, full plaintext leak | redacted as `high_entropy` |
| `my_secret_token_9f8a7b6c5d4e3f2a1b0c=` | suppressed, full plaintext leak | redacted as `high_entropy` |
| `myrandomvalue1234567890abcdef=` (control, no keyword) | redacted (unaffected) | redacted (unaffected) |
| `"PASSWORD_MIN_LENGTH": 8` (AC-3 fixture, must stay unredacted) | unredacted (guard fired) | unredacted (guard still fires — safe value "8" follows) |
| `"SECRET_SCAN_ENABLED": "true"` (AC-3 fixture) | unredacted | unredacted (safe value "true" follows) |

### Confidence
High. The fix directly targets the reviewer's root-caused mechanism (shape-only check
with no "is there really no value" verification), is verified against all three
reproduced bypasses plus the control and both AC-3 fixtures by direct computation before
implementation (not just after-the-fact test-passing), and the reviewer's own alternate
suggestion was checked and found insufficient rather than assumed correct.

### Suggested next handoff
Re-review (`crew:reviewer`) to confirm Finding 1 is closed, then validator per
`requires_validation: true` in the slice frontmatter. Parent loop drives both dispatches.

---

## Original implementation (2026-07-10, commit fab5173)

## Objective
`generic_credential` in `src/redact/detectors.ts` required the `[:=]`
separator to immediately follow the keyword (whitespace only) — a closing
quote/apostrophe on the label (`"OPENAI_API_KEY":`, `'DB_PASSWORD' =>`)
broke that adjacency, so JSON-config-shaped and PHP-array-shaped secrets
pasted into a transcript went completely unredacted.

## Owner
Builder (this run). Implementation only — no reviewer/verifier dispatch;
parent loop gates those.

## Scope
**In scope (done):**
- 6 new `PATTERN_DETECTORS` entries in `src/redact/detectors.ts`, tagged
  `generic_credential_quoted` (distinct from the existing `generic_credential`
  type per AC-5), covering both keyword families (trailing-only:
  `api_key|secret|token|password|passwd|pwd`; any-segment compound:
  `secret|password|passwd|pwd`) × 3 value shapes (double-quoted,
  single-quoted, bare/unquoted). Each requires a **mandatory** quote/
  apostrophe between keyword and separator, so they never overlap the two
  existing (unmodified) `generic_credential` entries, which require the
  quote to be *absent*.
- Separator generalized to `(?:=>|[:=])` — the PHP `=>` arrow as a real
  two-character alternative, not assumed-covered by `[:=]` alone (the exact
  trap AC-2 called out: `[:=]` alone would consume only `=` and leave a
  stray `>` at the start of the "value").
- Compound-family quoted entries carry the same numeric/boolean
  `valueFilter` guard as their unquoted sibling (AC-3).
- `src/redact/entropy.ts`: found and fixed an entropy-stage false positive
  surfaced by AC-3's own fixture (`"PASSWORD_MIN_LENGTH": 8`) — a quoted
  label token split from its value by a space (unlike the glued
  `PASSWORD_MIN_LENGTH=8` case `CONFIG_ASSIGNMENT_RE` already guards)
  independently cleared the Shannon-entropy threshold on its own character
  diversity. Added `LABEL_ONLY_RE` + `SECRET_LABEL_KEYWORD_RE`: guards a
  bare/quoted identifier-shaped token ending in `[:=]` with no value
  attached, but *only* when it also contains one of the same secret-ish
  keywords the pattern detectors recognize — narrow enough that it can't
  suppress a genuine unlabeled high-entropy secret that merely ends in `=`
  (e.g. base64 padding).
- `tests/security/redact.test.ts`: 6 new `TRUE_POSITIVES` fixtures (AC-1a/b/c,
  AC-2, plus 2 extra symmetry fixtures — single-quoted-label+bare-value,
  double-quoted-label+single-quoted-value) and 5 new false-positive guards
  (AC-3: 2 benign quoted JSON lines, 2 quoted numeric/boolean config-knob
  values, 1 quoted mid-word collision).

**Out of scope (not touched):**
- The two existing `generic_credential` entries (trailing, compound) —
  byte-identical, per AC-4. Confirmed by full-suite green run with zero
  existing-test edits.
- `redaction-log.ts` / `migrations/005-security.sql` — no schema change
  needed; `type` is a free-form `TEXT` column, confirmed via
  `recordRedactionEvents` (no enum/allowlist anywhere in `src/`).
- `redact/index.ts` — untouched; the existing `runDetector`/`applySpans`
  machinery already redacts only the captured `valueGroup` span and leaves
  everything else (including surrounding quotes) byte-for-byte intact, so no
  new "strip quotes" logic was needed there.

## Deliverable / changed files
- `src/redact/detectors.ts` — 6 new `PATTERN_DETECTORS` entries + 4 shared
  constants/helper (`GENERIC_TRAILING_KEYWORDS`, `GENERIC_COMPOUND_LABEL`,
  `QUOTED_LABEL_SEP`, `rejectNumericOrBooleanLiteral`).
- `src/redact/entropy.ts` — `LABEL_ONLY_RE` + `SECRET_LABEL_KEYWORD_RE` guard
  added to `isGuarded`.
- `tests/security/redact.test.ts` — 6 new true-positive fixtures, 5 new
  false-positive guards.

## Test evidence
- `bunx tsc --noEmit` — exit 0, no output.
- `bun run build` — exit 0 (`tsc -p .` clean).
- `bun vitest run tests/security/redact.test.ts` — **72/72 passed** (66
  pre-existing + 6 new true positives; the 5 new false-positive guards land
  in the same `describe` block as the pre-existing ones).
- `bun vitest run tests/security/redact-perf.test.ts` — **2/2 passed**.
  Logged: `p50=0.089ms p95=0.178ms mean=0.104ms max=0.711ms` over the
  1895-char representative payload — well under the 20ms p95 budget
  (AC-6).
- `bun vitest run tests/security` (full directory) — **6 files / 113 tests
  passed, 0 failed.**
- `bun run test` (full suite) — **198 files / 2341 tests passed, 6 skipped
  (pre-existing, unrelated), 0 failed** (up from 2330 in the last recorded
  full run by exactly the 11 new tests added here).

## AC verification
- **AC-1: PASS.** All 3 fixtures verified directly: `"OPENAI_API_KEY": "sk-
  proj-AbCdEf1234567890"` (trailing, quoted label + quoted value),
  `"DJANGO_SECRET_KEY": "abcdefgh1234"` (compound, quoted label + quoted
  value), `"SECRET_KEY"=abcdefgh1234` (compound, quoted label + bare value,
  no space). Each redacts only the value span; label, quotes, and separator
  are untouched (confirmed by test assertions on the full output string,
  not just "secret absent").
- **AC-2: PASS.** `'DB_PASSWORD' => 'hunter2'` redacts only `hunter2`
  between its quotes; `'DB_PASSWORD'` and the full `=>` arrow survive intact.
  The `=>`-as-single-`=`-plus-stray-`>` trap is structurally avoided (the
  arrow is matched as one two-char alternative, not decomposed from `[:=]`).
- **AC-3: PASS.** All 5 negative fixtures confirmed unredacted:
  `"NODE_ENV": "production"`, `"PORT": "7777"` (no recognized keyword at
  all), `"PASSWORD_MIN_LENGTH": 8` and `"SECRET_SCAN_ENABLED": "true"`
  (compound keyword, numeric/boolean `valueFilter` rejection — the boolean
  case required the entropy.ts fix above, since without it the *label*
  token independently tripped stage-3 entropy even though stage-2 correctly
  declined to redact it), `"authtoken": "abc123456789"` (mid-word
  collision, blocked by the pre-existing `(?<![A-Za-z])` lookbehind, which
  applies identically to the new quoted entries).
- **AC-4: PASS.** Full existing `TRUE_POSITIVES` table and all pre-existing
  false-positive guards run unmodified and unchanged in this diff — verified
  by `git diff` showing zero edits to any existing fixture or assertion,
  only additions.
- **AC-5: PASS.** All 6 new entries use `type: 'generic_credential_quoted'`,
  distinct from `generic_credential` — same one-`type`-per-entry convention
  `azure_key` already uses across 3 entries. No `redaction_log` schema/
  migration change; `type` is a free-form TEXT column consumed as-is by
  `aggregateRedactionEvents`/`recordRedactionEvents`.
- **AC-6: PASS.** Perf smoke logged above: p95 = 0.178ms, ~112x under the
  20ms budget — no catastrophic backtracking from the added quote-tolerance
  or `=>` alternation.

## Confidence
High. All 6 ACs have direct, named test coverage; the one non-obvious
finding (the entropy-stage leak on split label tokens) was caught by AC-3's
own fixture failing red before any entropy.ts change, root-caused against
the actual `tokenize`/`isGuarded` code rather than guessed, and fixed with a
guard narrowly scoped to keyword-bearing label tokens (not "any token ending
in a separator") specifically to avoid suppressing a genuine unlabeled
high-entropy secret. The new detector entries are structurally guaranteed
not to overlap the two existing (untouched) `generic_credential` entries,
since the new entries require a quote character the old ones require to be
absent.

## Risks / open questions
- None blocking. The FEAT's own non-goals (full JSON/YAML AST parsing,
  multi-line heredoc secrets) were not attempted, consistent with scope.
- Not implemented (out of AC scope, noted for completeness): a trailing-
  keyword quoted-label with an *unquoted, mismatched-case* keyword spanning
  a line break, or nested/escaped-quote values (`"key": "va\"lue"`) — regex-
  tier only, per the FEAT's stated non-goals.

## Suggested next handoff
Reviewer (`crew:reviewer`) for correctness/regression review, then validator
per `requires_validation: true` in the slice frontmatter. Parent loop drives
both dispatches.
