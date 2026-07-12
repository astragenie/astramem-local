---
feat: FEAT-468
branch: feat/w468-wave2
worktree: C:\work\mega\astramemory-local-worktrees\w468
status: builder-complete-fix-round-1
review: .claude/artifacts/crew/reviews/20260712T170000Z-review-feat468-numeric-secret-redaction.md
---

# FEAT-468 — fix round 1 (review needs_fix response)

Responds to the two findings in the review artifact above (verdict: needs_fix).

## FIX 1 (HIGH) — label-context awareness

**Finding**: `findNumericSecretRuns` had zero label-context awareness — a raw
`\d+` scan with no concept of "this digit run is the value side of a
labeled assignment." Reproduced live by the reviewer: `MAX_RETRIES=999...`,
`INVOICE_NUMBER=1234...`, `ACCOUNT_NUMBER=9876...`, and `"orderId":
"1234..."` all got corrupted — directly contradicting the FEAT's own scope
("the gap is UNLABELED numeric secrets only").

**Fix**: added `LABEL_PREFIX_RE` + `hasLabelPrefix` (`src/redact/entropy.ts`).
Before flagging a digit run, check whether the ~40 chars immediately
preceding it match a `LABEL=`, `label: `, or `"label": ` shape (identifier,
optional single-quote layer, `:` or `=` separator, optional trailing quote).
If so, skip — regardless of whether the label itself looks like a secret
keyword. This mirrors the *intent* of the entropy stage's existing
`CONFIG_ASSIGNMENT_RE`/`isLabelWithSafeValueFollowing` guards but
generalizes to arbitrary-length digit values (those two guards only ever
fire on a whole-token Shannon-entropy check, never on a digit substring
embedded inside a larger token — this is a genuinely new mechanism, not a
call-out to the existing ones).

Deliberately does NOT check whether the label is a recognized secret
keyword: per the FEAT's own scope, a labeled value — secret-shaped label or
not — is the pattern-detector stage's (detectors.ts) job upstream, not this
heuristic's. Verified with a pinned counter-case
(`tests/security/redact.test.ts`): `TOKEN=98765432109876543210987654` is
still fully redacted, but by the stage-2 `generic_credential` pattern
detector (asserted `type: 'generic_credential'`), never reaching stage 3's
numeric-secret heuristic at all (the raw text stage 3 sees already has that
span replaced by a placeholder, protected via `protectedRanges`).

**New FP fixtures** (all verified `events.length === 0`, exact reviewer
repros where given): `MAX_RETRIES=9999999999999999999999999`,
`INVOICE_NUMBER=12345678901234567890 was issued last week`, `please
reference ACCOUNT_NUMBER=98765432109876543210 on your next call`,
`"orderId": "12345678901234567890"` (JSON), `trackingId:
12345678901234567890123 confirmed` (YAML, added per review instruction to
cover all three label shapes: env/JSON/YAML).

**Accepted, documented tradeoff** (per review's explicit FP-first bias
instruction): the guard suppresses on ANY label-shaped prefix, including
ordinary prose punctuation that coincidentally looks like one (e.g. `Total:
<23-digit number>`). Traded off deliberately against the HIGH-severity risk
of corrupting real labeled IDs/config/JSON — an unlabeled-looking 23+ digit
"total" in prose is a materially less realistic shape than the labeled-ID
corruption this closes.

## FIX 2 (MEDIUM) — USPS tracking-number false positives

**Finding**: unlabeled 20-digit (USPS Certified Mail) and 22-digit (USPS
Priority/Express) tracking numbers redacted — a real, common, unlabeled
digit-run shape not in the original FP corpus.

**Fix chosen**: option (a), raised the floor. `NUMERIC_SECRET_MIN_LENGTH`
20 -> 23 (`src/redact/entropy.ts`, now a dedicated constant, no longer
piggybacking on the entropy stage's `MIN_TOKEN_LENGTH`). Verified: both
reviewer repro strings (`9400111899223197428490`, 22 digits;
`71967398271700000000`, 20 digits) now stay unredacted, and the FEAT-463
26-digit repro (the FEAT's original motivating case) still clears the new
floor with 3 digits of margin.

**Accepted, documented residual**: an unlabeled 20-22 digit secret remains
invisible to this heuristic (documented in the entropy.ts doc comment).
Judged acceptable — narrower than the tracking-number FP class it dodges,
and shorter than any vendor-format secret the sibling pattern detectors
already catch by shape.

**No new config knob** — unchanged from the original design decision (see
the prior handoff); still out of scope per review's explicit instruction
not to add one.

## Fixture changes from raising the floor

The pre-fix-round true-positive fixtures at exactly 20/22 digits (the old
minimum-floor boundary and the "digit-heavy legacy token" case) no longer
qualify as true positives under the new 23-digit floor — updated in place:
- "unlabeled 20-digit token" boundary fixture -> now a 23-digit boundary
  fixture (new floor).
- "digit-heavy legacy token glued to alpha prefix" -> digit run bumped from
  22 to 23 digits to remain a true positive.
- Old 19-digit FP boundary fixture -> replaced with a 22-digit FP boundary
  fixture (the new tight boundary, one below the raised floor).
The FEAT-463 26-digit repro and the 32-digit upper-range fixture are
unchanged (both still comfortably above 23).

## Test evidence

- `bunx tsc --noEmit`: clean, no output.
- `bun run build`: clean.
- `bunx vitest run tests/security`: **6 files / 178 tests passed, 0
  failed** (up from 170 pre-fix-round — 8 new: 1 counter-case TP + 7 FP
  fixtures: 2 USPS tracking numbers, 4 label-context shapes, 1 boundary
  replacement is a net rename not an addition... actual delta counted by
  vitest is 8, matching 1 new TP + 7 new FP rows added net of the
  boundary-fixture rename).
- `bunx vitest run` (full suite): **209 files / 2507 passed, 6 skipped, 0
  failed** — up from 2499, consistent with the +8 in tests/security, no
  regressions elsewhere.
- `bunx vitest run tests/security/redact-perf.test.ts`: 2/2 passed, p95
  budget unaffected (the label-context check is one small bounded-window
  regex test per digit-run candidate, not a hot-path change).

## Files changed (fix round 1, cumulative with prior commit)

- `src/redact/entropy.ts` — `LABEL_PREFIX_RE`/`hasLabelPrefix` guard,
  `NUMERIC_SECRET_MIN_LENGTH` raised 20 -> 23, updated doc comments
- `tests/security/redact.test.ts` — updated boundary fixtures for the new
  floor, added label-context FP corpus, added USPS tracking-number FP
  corpus, added the labeled-secret counter-case TP fixture
