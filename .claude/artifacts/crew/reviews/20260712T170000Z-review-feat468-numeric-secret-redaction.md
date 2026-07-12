---
feature: FEAT-468
branch: feat/w468-wave2
commit: 32dfa8a
reviewer: independent adversarial review (crew:reviewer)
verdict: needs_fix
---

# FEAT-468 numeric-secret redaction — adversarial review

## Scope reviewed

`src/redact/entropy.ts` (`findNumericSecretRuns`, `DIGIT_RUN_RE`), `src/redact/index.ts`
stage-3 wiring (`numericSpans`, `applySpans` merge), `tests/security/redact.test.ts` FP/TP
fixtures, `tests/security/redact-perf.test.ts`.

Build (`bun run build`) and `npx vitest run tests/security/` both green — 170/170 tests
pass, perf smoke p95 well under the 20ms guard. No regression in the existing 25+
true-positive / false-positive corpus.

## Verdict: needs_fix

## Findings

### [HIGH] src/redact/entropy.ts:269-292 — `findNumericSecretRuns` has zero label-context awareness, redacting benign labeled numeric IDs

The entropy stage right above this one carries three dedicated guard layers
(`CONFIG_ASSIGNMENT_RE` at entropy.ts:36, the three-layer `isLabelWithSafeValueFollowing`
at entropy.ts:118-136) whose entire purpose is to stop a labeled, benign value from being
flagged. `findNumericSecretRuns` is a raw `\d+` scan over the whole remaining text with
none of that — it doesn't know what a label is at all. Reproduced live against the built
`redactText`:

```
MAX_RETRIES=9999999999999999999999999
  -> MAX_RETRIES=[REDACTED:numeric_secret:059eab8a]

INVOICE_NUMBER=12345678901234567890 was issued last week
  -> INVOICE_NUMBER=[REDACTED:numeric_secret:6ed645ef] was issued last week

please reference ACCOUNT_NUMBER=98765432109876543210 on your next call
  -> please reference ACCOUNT_NUMBER=[REDACTED:numeric_secret:328bffe0] on your next call

"orderId": "12345678901234567890"
  -> "orderId": "[REDACTED:numeric_secret:6ed645ef]"
```

This directly violates the FEAT's own Non-goals/scope language ("phone numbers,
timestamps, IDs, numeric data tables — must stay unredacted") and the design comment's
own claim ("order/invoice/ID numbers: well under 20 in practice" — false; ERP/ecommerce
sequence+date IDs, padded account numbers, and JSON `orderId`/`accountNumber` fields
routinely reach 20+ digits). Because the placeholder format never retains the original
value, this is irreversible data corruption on ordinary, non-secret config/JSON/log
content, which is the exact risk class this review was asked to weight most heavily.

Test coverage gap: all 13 rows in the FP corpus (`redact.test.ts:580-678`) are
*unlabeled* digit shapes (phone numbers, timestamps, credit-card patterns, zip+4,
dash-formatted order numbers, CSV rows). Not one exercises a `LABEL=digits`,
`LABEL: digits`, or `"key": "digits"` shape with a non-secret label — so this gap
shipped with the corpus the FEAT itself calls "required."

Fix direction: run `findNumericSecretRuns` matches through the same (or an equivalent)
label-awareness check the entropy stage already has — at minimum, skip a digit run when
it's the value-side of a `LABEL[:=]VALUE` shape where the label isn't itself a
secret-keyword (mirror `CONFIG_ASSIGNMENT_RE`'s intent but generalized to arbitrary-length
digit values, not just single digits/booleans).

### [MEDIUM] src/redact/entropy.ts:250-256 — real-world 20-22 digit unbroken IDs (USPS/postal tracking) are not in the FP corpus and do get redacted

```
your package tracking number is 9400111899223197428490 for delivery
  -> ...tracking number is [REDACTED:numeric_secret:abd60986] for delivery

certified mail 71967398271700000000 delivered
  -> certified mail [REDACTED:numeric_secret:535b21a3] delivered
```

USPS Priority Mail / Certified Mail tracking numbers are commonly 20-22 unbroken digits
— exactly the shape this heuristic targets, and a very plausible thing to show up
unlabeled in support/ops transcripts this daemon ingests. The design comment's FP
rationale list (unix timestamps, squashed ISO dates, credit-card test numbers, zip+4,
dash-formatted order IDs) doesn't include this carrier-ID shape, and no test guards it.
This is lower severity than the HIGH finding above because it's a narrower, single-domain
shape rather than a broad class (arbitrary labeled IDs), but it is a concrete, common,
unlabeled false positive the "IDs must stay unredacted" requirement is supposed to cover.
Worth an explicit accept-the-tradeoff note in the doc comment at minimum, or a shape
exception if this daemon plausibly ingests logistics/support content.

## What held up (no issues found)

- **Boundary correctness**: 19/20/21-digit runs at string start, middle, and end all
  behave exactly as designed (19 → unredacted, 20/21 → redacted). Verified directly
  against the built module, matching the existing `redact.test.ts:306-310` and `:581`
  fixtures.
- **Two runs separated by one non-digit character**: both redact independently with
  correct offsets; no bleed-through.
- **Span-merge / stage-order correctness**: a digit run glued directly onto an
  already-labeled secret (`token=...9999...`, `ghp_...9999...`) is fully absorbed by the
  stage-2 pattern detector and never double-counted in stage 3 — `protectedRanges`
  correctly guards it. A digit run following a placeholder with a separator produces two
  independent, correctly-offset events. A mixed alnum+digit token where only the digit
  substring qualifies (`ACCT9876543210987654321098`) redacts only the digit run, per the
  existing test and reconfirmed live. Could not construct a case where `findEntropySecrets`
  and `findNumericSecretRuns` fire on genuinely overlapping-but-not-nested spans — by
  construction (numeric spans are always digit substrings *within* a whitespace-delimited
  token, and entropy spans are always exactly that token), nesting is the only possible
  relationship, and `dedupeOverlaps`'s greedy earliest-start selection combined with
  `[...entropySpans, ...numericSpans]` ordering (stable sort preserves entropy priority on
  tied starts) resolves it correctly with no double redaction observed in any constructed
  case.
- **Perf**: `DIGIT_RUN_RE = /\d+/g` is a simple linear character-class scan, no
  backtracking risk. `redact-perf.test.ts` passes unchanged (p95 well under the 20ms
  guard) with the new stage-3 pass included.
- **Test rigor**: FP-corpus assertions check `events.length === 0`, not just
  text-unchanged — matches the review brief's concern about hidden extra events.

## Evidence

- `bun install && bun run build`: clean, no errors.
- `npx vitest run tests/security/`: 6 files, 170 tests, all passed.
- Live probes against `dist/redact/index.js` (temporary, non-committed scratch scripts,
  removed after use — worktree is clean per `git status --porcelain`): boundary, merge,
  and the two FP classes above, outputs quoted verbatim in Findings.

## Recommendation

Do not merge as-is. The HIGH finding (unguarded labeled numeric IDs) is a broad,
easy-to-hit false-positive class that contradicts the FEAT's own non-goals and has no
test coverage at all — this is the kind of gap that will surface on real user data
quickly. Add label-awareness to `findNumericSecretRuns` (or scope it more narrowly to
truly unlabeled contexts) and add corpus fixtures for labeled long-numeric-ID shapes
before shipping. The MEDIUM finding (postal tracking numbers) should at least get an
explicit documented tradeoff decision even if not fixed this pass.
