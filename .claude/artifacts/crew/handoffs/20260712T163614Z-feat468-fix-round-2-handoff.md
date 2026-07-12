---
feat: FEAT-468
branch: feat/w468-wave2
worktree: C:\work\mega\astramemory-local-worktrees\w468
status: builder-complete-fix-round-2
review: .claude/artifacts/crew/reviews/20260712T173000Z-review-feat468-fix-round-1-reverify.md
---

# FEAT-468 — fix round 2 (re-verification needs_fix response)

Responds to the two findings in the round-1 re-verification (both surfaced by attacking
the label-context guard introduced in fix round 1, both round-1 original findings
independently reconfirmed fixed).

## HITL decision applied

Team lead's decision: the label guard is SAME-LINE ONLY. `Summary:\n<secret>` must
redact (transcript-header shape — routine LLM output formatting, not a real label —
is a realistic secret-leak vector, MEDIUM); `LABEL=<digits>` on the same line must
still not redact.

## Implementation

Replaced the fixed 40-char lookback window (`LABEL_PREFIX_WINDOW`) with a same-line
lookback: `hasLabelPrefix` (`src/redact/entropy.ts`) now finds the start of the
digit run's own line (`text.lastIndexOf('\n', start - 1) + 1`, or 0 if none) and
tests only that slice against `LABEL_PREFIX_RE` — no fixed character cap, and a
`\n` can never be part of the tested slice at all.

This closes both findings as a side effect of the same one-line change:

- **[MEDIUM] cross-line bypass**: a digit run that opens a new line has an EMPTY
  same-line prefix (nothing between the line start and the run), which can never
  match `LABEL_PREFIX_RE` — so nothing on a *previous* line can suppress it,
  full stop. `Summary:\n<26 digits>` and `Result:\n<26 digits>` both now redact
  (verified with fresh 26-digit fixtures, distinct from the existing FEAT-463 repro
  fixture, to keep this failure mode independently pinned).
- **[LOW] fixed-window padding gap**: same-line scanning has no length cap at all,
  so `\s*` in `LABEL_PREFIX_RE` absorbs arbitrary same-line whitespace between a
  label's separator and its value — `ACCOUNT_NUMBER: ` + 40 spaces + a 23-digit
  value now correctly stays unredacted (previously fell outside the fixed 40-char
  window and got flagged).

Also verified (not explicitly required, but a natural consequence of removing the
fixed-width window and worth confirming): a labeled value on an indented line
(`notes\n  ACCOUNT_NUMBER: <23 digits>`) still correctly stays unredacted — the
label-shape regex isn't anchored to the start of the line slice, so leading
indentation before the label doesn't defeat the match.

## Test evidence

- `bunx tsc --noEmit`: clean, no output.
- `bun run build`: clean.
- `bunx vitest run tests/security`: **6 files / 182 tests passed, 0 failed** (up
  from 178 — 2 new true-positive fixtures for the cross-line case, 2 new
  false-positive fixtures for the padding/indentation cases).
- `bunx vitest run` (full suite): **209 files / 2511 passed, 6 skipped, 0 failed**
  — the reviewer's noted 4 pre-existing-flake failures
  (`detach-kill-resume.test.ts`, `daemon-manifest.test.ts`, unrelated
  process-spawn/kill timing) did not reproduce on this run; not chased per the
  team lead's explicit instruction.
- `bunx vitest run tests/security/redact-perf.test.ts`: 2/2 passed — the same-line
  lookback is one bounded `lastIndexOf` scan (bounded by the nearest newline, not
  the whole text) per digit-run candidate; no regression to the p95 budget.

## Files changed (fix round 2, cumulative with prior two commits)

- `src/redact/entropy.ts` — `hasLabelPrefix` rewritten to same-line-only lookback,
  `LABEL_PREFIX_WINDOW` constant removed, doc comments updated to describe both
  closed findings
- `tests/security/redact.test.ts` — 2 new TP fixtures (cross-line headers), 2 new
  FP fixtures (wide same-line padding, indented label line)
