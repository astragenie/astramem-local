---
feat: FEAT-468
branch: feat/w468-wave2
worktree: C:\work\mega\astramemory-local-worktrees\w468
status: builder-complete
---

# FEAT-468 — numeric-secret digit-run heuristic (entropy blind spot)

## Objective

Stage-0 redaction's Shannon-entropy detector (`src/redact/entropy.ts`) caps
at log2(10) ≈ 3.32 bits/char for a pure-digit alphabet, permanently below
the 4.0 default `entropyThreshold` — so an unlabeled, all-digit secret (long
numeric PIN, legacy digit-only API token) is structurally invisible to it
regardless of length. Proven in the FEAT-463 final review: the bare
unlabeled string `98765432109876543210987654` (26 digits) scores 3.295 and
leaked in full.

## Design chosen: digit-run length heuristic (not per-alphabet normalized entropy)

Considered and rejected the per-alphabet-normalized-entropy alternative
(divide raw entropy by log2(alphabet size), compare to a ratio threshold):
it can't discriminate a random-looking SECRET from a random-looking PHONE
NUMBER or ACCOUNT NUMBER — both score close to the digit alphabet's own
ceiling, so there's no entropy-based signal that separates them.

Implemented instead: `findNumericSecretRuns` (`src/redact/entropy.ts`) scans
the whole remaining text (same stage-3 input as the entropy check, i.e.
after PEM blocks and pattern detectors have already run) for maximal runs
of consecutive digit characters (`/\d+/g`) and flags any run of
`MIN_TOKEN_LENGTH` (20, reusing the constant the entropy stage already uses
for its own unlabeled-token floor) or more. Any non-digit character —
space, dash, paren, plus, dot, letter — ends a run, so every
separator-formatted numeric shape is exempted for free with no extra
separator-detection logic. Only the digit substring itself is redacted
(works even when the run is embedded inside a larger non-whitespace token,
e.g. an alpha prefix glued directly to a long digit run).

Wired into `redactText`'s stage 3 (`src/redact/index.ts`) as an additive
detector alongside `findEntropySecrets`, tagged with its own event type
`numeric_secret` (distinct from `high_entropy` — different detection
mechanism, kept observable in `redaction_log` by shape, same convention
`generic_credential_quoted` already established for FEAT-463). Spans from
both detectors are merged into one `applySpans` call so `dedupeOverlaps`
prevents any double-redaction on a span both happen to agree on.

**No config knob added.** Unlike `entropyThreshold` (a real
deployment-tunable), this floor is fixed and corpus-validated rather than
something an operator needs to adjust — and adding one would mean touching
the FEAT-461/465 config round-trip machinery (`buildFullyPopulatedConfig`,
`findMissingConfigKeys` in `tests/config/writer.test.ts`, plus
`writer.ts`/`loader.ts`) for a heuristic that doesn't need per-deployment
tuning. Kept scope to `src/redact/*` + `tests/security/redact.test.ts` only.
The FEAT-463 review's own conditional ("default ON only if FP corpus is
fully green, else default OFF with knob") is satisfied here because the
corpus below is fully green by construction of the length floor, not by
threshold tuning.

## Threshold rationale (20, why it's safe)

`MIN_TOKEN_LENGTH` (20) sits strictly above every non-secret digit-run
length in the required FP corpus:
- unix timestamps: 10 digits (seconds), 13 digits (milliseconds)
- squashed ISO date+time(+ms): up to ~17 digits
- credit-card-shaped test numbers: 15 (Amex), 16 (Visa/Mastercard)
- zip+4 squashed: 9 digits
- order/invoice IDs: well under 20 in realistic practice

A LABELED numeric secret (`TOKEN=1234567890123456789012345`) is already
caught earlier by the `generic_credential` pattern detector
(`detectors.ts`), which has no minimum length on its captured value — this
heuristic only closes the UNLABELED gap, matching the FEAT's stated scope.

## Fixture corpus (tests/security/redact.test.ts)

True positives added to the `TRUE_POSITIVES` table (type `numeric_secret`):
- FEAT-463's exact 26-digit repro (`98765432109876543210987654`)
- unlabeled 20-digit token (exact minimum-floor boundary)
- unlabeled 32-digit token (upper end of the FEAT's stated TP range)
- digit-heavy legacy token glued to a non-keyword alpha prefix
  (`ACCT9876543210987654321098` — proves only the digit run redacts, prefix
  survives)

False positives, dedicated describe block
(`redactText — FEAT-468 numeric-secret false-positive corpus`), all
asserting `events.length === 0` and byte-identical output:
- 19-digit unbroken run (one below the floor — boundary complement to the
  20-digit true positive)
- intl phone numbers: parens/dashes/spaces format, dash-grouped RU-style
  format, squashed 10-digit domestic format
- unix timestamps: 10-digit (seconds), 13-digit (ms)
- squashed ISO date+time: 14-digit, 17-digit (with ms)
- credit-card-shaped test numbers: 16-digit (Visa), 15-digit (Amex)
- squashed zip+4 (9 digits)
- dash-formatted order/invoice number
- space-separated numeric table row
- comma-separated numeric CSV-style row

## Test evidence

- `bunx tsc --noEmit`: clean, no output.
- `bun run build`: clean.
- `bunx vitest run tests/security`: **6 files / 170 tests passed, 0 failed**
  (up from 132 pre-FEAT-468 across the same files — the delta is these new
  fixtures plus a few pre-existing additions from sibling slices already on
  this branch's base).
- `bunx vitest run` (full suite): **209 files / 2499 passed, 6 skipped, 0
  failed** — no regressions anywhere else in the repo.
- Perf: `tests/security/redact-perf.test.ts` (existing p95 < 20ms budget)
  still passes unchanged — the new detector is one additional linear regex
  scan (`/\d+/g`, no backtracking risk) over the same text already being
  scanned for entropy.

## AC self-check (against FEAT-468.md scope)

- "Consider per-alphabet thresholds ... or a digit-run length heuristic" —
  chose the digit-run heuristic, justified above (normalized entropy can't
  discriminate secrets from phone numbers/account numbers).
- "False-positive risk is the hard part ... corpus-driven fixture set
  before any threshold change" — 13 FP fixtures built and green before
  finalizing the length constant (which was reused from `MIN_TOKEN_LENGTH`,
  not newly tuned).
- "One-line doc comment in entropy.ts acknowledging the ceiling" — the
  pre-existing FEAT-463-era doc comment was updated in place to point at
  the new `findNumericSecretRuns` fix rather than just disclosing the gap.
- Team-lead's true-positive range (unlabeled 20-32 digit tokens, the
  FEAT-463 26-digit repro) — all four fixtures added and passing.
- Team-lead's FP corpus (phone numbers, unix timestamps, ISO dates,
  credit-card-adjacent test numbers, IDs, numeric table rows) — all
  represented and green.
- Perf budget — unaffected, verified via the existing perf test.

## Risks / open questions

- The heuristic is length-only, not entropy-aware: a 20+ run of a single
  repeated digit (e.g. all zeros) would also redact. Accepted as
  intentional per the FEAT's own "N+ consecutive digits, no separators"
  framing — a corpus of realistic non-secret shapes was validated, not a
  synthetic degenerate case.
- A decimal number with 20+ digits after the decimal point (e.g. a
  high-precision scientific/financial constant) would have its fractional
  part redacted, since `.` breaks the run at the decimal point but not
  within the fractional digits themselves. Not present in the required FP
  corpus; flagging as a known, narrow edge not exercised by these tests.
- No config knob (see rationale above) — if a future deployment surfaces a
  legitimate 20+ digit unlabeled numeric identifier as an unwanted
  redaction, the fix path is either a corpus-driven length bump or adding
  the knob at that point, not preemptively now.

## Files changed

- `src/redact/entropy.ts` — `findNumericSecretRuns` + updated doc comments
- `src/redact/index.ts` — wired into stage 3, new `numeric_secret` event type
- `tests/security/redact.test.ts` — TP fixtures + FP corpus describe block
