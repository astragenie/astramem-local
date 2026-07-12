---
feature: FEAT-468
branch: feat/w468-wave2
commit: 0e7beeb (fix round 1, reviewed against 32dfa8a's findings)
reviewer: independent adversarial re-verification (crew:reviewer)
verdict: needs_fix
supersedes: 20260712T170000Z-review-feat468-numeric-secret-redaction.md
---

# FEAT-468 fix round 1 — re-verification

## Verdict: needs_fix (both round-1 findings resolved; two new, narrower residuals found while attacking the fix itself)

## Round-1 findings: confirmed fixed

Re-ran the exact repro strings from the original review against the built module —
all now pass through unredacted:

```
MAX_RETRIES=9999999999999999999999999                                  -> unchanged, 0 events
INVOICE_NUMBER=12345678901234567890 was issued last week                -> unchanged, 0 events
please reference ACCOUNT_NUMBER=98765432109876543210 on your next call  -> unchanged, 0 events
"orderId": "12345678901234567890"                                       -> unchanged, 0 events
your package tracking number is 9400111899223197428490 for delivery     -> unchanged, 0 events (USPS 22-digit)
certified mail 71967398271700000000 delivered                           -> unchanged, 0 events (USPS 20-digit)
```

`LABEL_PREFIX_RE`/`hasLabelPrefix` (entropy.ts) correctly suppresses the env/YAML/JSON
label shapes that leaked before. `NUMERIC_SECRET_MIN_LENGTH` raised 20→23 correctly
dodges the USPS 20/22-digit shapes while the FEAT-463 26-digit motivating repro and the
32-digit upper-range fixture both still redact. Boundary is exact: 22 digits stays
unredacted, 23 redacts (both reconfirmed live, matching the updated test fixtures).
The `TOKEN=<26 digits>` counter-case is pinned as a stage-2 `generic_credential` catch,
not stage-3 `numeric_secret` — confirmed still true live.

`bun run build` clean. `npx vitest run tests/security/`: 178/178 passed (up from 170).
Full suite (`npx vitest run`): 2503 passed / 4 failed / 6 skipped, across
`scripts/eval/longmemeval/detach-kill-resume.test.ts` and
`scripts/eval/shared/daemon-manifest.test.ts` — both unrelated to this diff (real
process-spawn/kill timing assertions, e.g. "a pid whose port is not listening ->
already-dead" racing actual OS process state). This diff touches only
`src/redact/entropy.ts` and `tests/security/redact.test.ts`; the failing files are
untouched by it and match a known flaky-process-timing class, not a redaction
regression.

## New findings from attacking the fix itself

### [MEDIUM] entropy.ts LABEL_PREFIX_RE — cross-line bypass lets an unrelated prose
### header suppress redaction of a genuinely unlabeled secret

The fix's own doc comment accepts a narrow, deliberate tradeoff: same-line prose
ending in a colon (`Total: <23-digit number>`) will be treated as "labeled" even
though it isn't really a label. But `\s*` in `LABEL_PREFIX_RE` matches newlines too,
so the same suppression fires across a line break, for ANY word ending in `:`/`=`
on the previous line — not just contrived prose punctuation, but ordinary transcript
headers:

```
Summary:
12345678901234567890123456          -> stays UNREDACTED (26-digit unlabeled secret leaks)

Result:
98765432109876543210987654          -> stays UNREDACTED (26-digit unlabeled secret leaks)
```

This is a false NEGATIVE — the more sensitive failure direction for a redaction
control — and the trigger condition ("some word, then a colon, then a newline,
within 40 chars of the secret") is common in exactly the auto-captured assistant
transcript content this daemon ingests (`Summary:`, `Result:`, `Output:`, `Notes:`,
numbered-step labels, etc., are routine LLM output formatting, always followed by a
line break rather than inline text). The round-1 doc comment only reasoned about the
same-line case and called it "an unrealistic shape in practice" — that reasoning
does not extend to the cross-line case, which is the realistic one. Distance still
matters as expected: pushed far enough past the 40-char window (verified with a
`Notes:` + 40 blank lines repro), the secret is caught again — so this is bounded to
"within ~40 chars, including newlines," not unbounded.

Suggested fix direction: either shrink the window so it can't cross a blank-line/
paragraph boundary at all, or require `\s*` between separator and value to not
contain more than one newline (a genuine multi-line label:\nvalue pair, like YAML,
rarely has a full blank line between them, whereas a prose header transitioning to
pasted data usually does — imperfect discriminator, but tightens the gap).

### [LOW] entropy.ts LABEL_PREFIX_WINDOW (40 chars, fixed) — wide separator padding
### pushes a genuinely labeled value back into "unlabeled" territory

```
ACCOUNT_NUMBER: <40 spaces> 12345678901234567890123   -> REDACTED (false positive: label exists but falls outside the 40-char lookback)
ACCOUNT_NUMBER: <30 spaces> 12345678901234567890123   -> stays unredacted (still inside the window)
```

Narrower and much less likely than the round-1 HIGH (requires unusual heavy padding
between separator and value — e.g. fixed-width/aligned config or report formats)
but it is a real, reproducible regression of the exact class the fix was meant to
close. Not urgent; flagging so it's a documented tradeoff rather than an unnoticed
gap, same as the accepted 20-22-digit residual already written up in the entropy.ts
doc comment.

## What else I attacked (no issues)

- Long label name (45 chars) whose identifier gets truncated mid-word by the 40-char
  window still parses as a valid (truncated) identifier and correctly suppresses —
  no false positive from label length alone.
- Digit run at absolute string offset 0 — no crash, correctly evaluated as unlabeled
  (empty lookback window), redacts as expected.
- URL query param `?id=<26 digits>` — treated as labeled (matches `LABEL_PREFIX_RE`
  on `id=`), consistent with the FEAT's stated scope (labeled values are the
  upstream pattern detector's job, not this heuristic's) — not a new bug, just
  confirming intended behavior.
- `Authorization: Basic <all-digit blob>` — no colon/equals immediately adjacent to
  the value (separated by a space after "Basic"), correctly falls through and
  redacts as unlabeled.
- Two digit runs in one string, only the first genuinely labeled — first stays
  unredacted, second (unlabeled, far away) still redacts independently; no
  cross-contamination between the two `hasLabelPrefix` evaluations.

## Recommendation

The two original findings are resolved with good evidence (live repro + new pinned
tests). The cross-line bypass is a real, broader-than-intended miss surfaced by
directly attacking the mechanism the fix introduced — it's narrower in blast radius
than round 1 (needs an actual unlabeled 23+ digit secret, which is already a rare
category by the FEAT's own framing) but it undercuts part of the point of raising
the floor and adding label-awareness in the first place, since a secret sitting
right after a transcript's own formatting will now slip through. Recommend either
tightening `LABEL_PREFIX_RE` to not cross a blank line, or explicitly accepting and
documenting this as a residual (mirroring how the 20-22-digit gap was documented)
before merge — team lead's call on which, but it shouldn't ship silently either way.
