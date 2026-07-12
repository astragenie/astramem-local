---
task: FEAT-473
branch: feat/w473-wave3
reviewer: crew-reviewer (independent)
status: completed
decision: approved
self_approval: false
timestamp: 2026-07-12T16:55:00Z
---

# Review: FEAT-473 — Unicode smart/curly quote recognition in credential labels

## Scope reviewed
- `src/redact/detectors.ts` — `ANY_QUOTE_CHAR` (single-sourced export), `DOUBLE_QUOTE_OPEN/CLOSE/EXCLUDE`, `SINGLE_QUOTE_OPEN/CLOSE/EXCLUDE`, widened `QUOTED_LABEL_SEP` and the six `generic_credential_quoted` pattern-detector entries.
- `src/redact/entropy.ts` — `LABEL_CORE_RE`, `LABEL_PREFIX_RE`, and the safe-value quote-stripping regexes widened to import and reuse `ANY_QUOTE_CHAR` from detectors.ts.
- `tests/security/redact.test.ts` — 17 new cases (9 true-positive short-secret cases across curly/mixed quote combos, 5 false-positive guard cases, 3 entropy-guard label-prefix cases).
- Handoff artifact `.claude/artifacts/crew/handoffs/20260712T165507Z-feat473-smart-quote-labels-complete.md`.

## Findings

None at MEDIUM or above.

**LOW (informational, not blocking):** The quoted-label opening side (before the keyword) is still unconstrained — same as pre-existing behavior, not introduced by this FEAT — so a malformed label like `xAPI_KEY": "value"` (no real opening quote) still matches. Out of scope for FEAT-473; flagged for awareness only, matches the pattern of the disclosed escaped-inner-quote limitation already called out in the code comments.

## Verification performed

1. Read the full diff (`git diff main...feat/w473-wave3`) for all three source files.
2. Traced `ANY_QUOTE_CHAR` single-sourcing: exported once from `detectors.ts`, imported by `entropy.ts` — confirmed no duplicate character-class literal remains in either file (`grep -i quote` on `src/redact/` returns only these two files).
3. Verified independent open/close quote-family mixing is correctly scoped: `DOUBLE_QUOTE_OPEN`/`CLOSE` and `SINGLE_QUOTE_OPEN`/`CLOSE` each include the ASCII quote plus their own family's curly pair only — a double-quoted value can never close with a single-family quote and vice versa, preserving the original design's family isolation while allowing straight/curly mismatch within a family (the realistic word-processor auto-curl mangle).
4. Verified `LABEL_CORE_RE`/`LABEL_PREFIX_RE` widening is symmetric but intentionally NOT family-paired (label boundaries only need "is a quote-like char present", not value-content capture) — consistent with the value-entry design rationale.
5. Confirmed the bare-value negative lookahead (`(?!${ANY_QUOTE_CHAR})`) correctly excludes all 6 quote chars, preventing the bare-value entry from mis-capturing any quoted value's opening char across either family.
6. Ran the full suite in the worktree: `npx vitest run tests/security/redact.test.ts` → **138/138 passed**, matches builder's claim.
7. Spot-checked the AC-3 false-positive corpus (`PASSWORD_MIN_LENGTH`, `SECRET_SCAN_ENABLED`) is exercised with curly-quoted, mixed-quoted, and straight-quoted variants — no over-redaction risk found for benign config values.
8. Checked no other file in `src/redact/` contains a stale unwidened `["']` literal that should have been updated in this FEAT's scope — none found.

## Decision

**approved** — correct, single-sourced, symmetric widening with adequate true-positive and false-positive test coverage (short-secret leak class from FEAT-463 LOW #2 is closed); no regressions in the 138-test suite; the one LOW note is pre-existing and out of scope.
