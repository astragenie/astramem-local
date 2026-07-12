---
id: FEAT-470
status: done
priority: P2
category: chore
target_release: null
created: 2026-07-10
updated: 2026-07-10
depends_on: []
slices: []
derived_from: 2026-07-10 review/validation LOW findings batch (SLICE-420/421/422 residuals)
cross_product: [astramem-local]
autonomous_safe: true
triage_notes: "Orchestrator-authored batch of five review-nit residuals, each individually verified by a reviewer or validator this session with file:line evidence. All mechanical, test/doc/one-liner scope, no behavior redesign, no public surface change — batched to amortize ceremony. autonomous_safe true."
---
## Description

**Stabilization quick-wins batch** — five LOW-severity residuals from today's
review/validation rounds, each disclosed in a PASS artifact and individually
tiny; batched into one slice.

## Acceptance criteria

- **AC-1:** Given `src/config/writer.ts`'s `hasNothingToEmit`, When an optional
  string field is explicitly `''` (emitter's truthy-omit skips it), Then
  `findMissingConfigKeys` does not flag it (extend predicate to match the
  emitter's own falsy-omit semantics for STRING fields only — booleans/numbers
  unaffected) and a test pins `''`, plus a counter-test that `0`/`false`
  values are still checked. (SLICE-420 re-review residual.)
- **AC-2:** Given `src/redact/entropy.ts`, When read, Then a doc comment states
  the numeric-alphabet ceiling (~3.32 bits/char uniform digits < 4.0 threshold
  → digit-only secrets invisible to the entropy stage; FEAT-468 tracks the
  real fix). Comment only, no behavior change. (FEAT-463 final-review note.)
- **AC-3:** Given `.claude/artifacts/loop/backlog/done/FEAT-466.md`'s AC-2
  text, When read, Then it carries a one-line addendum naming the deliberate
  rotate write-through exception (DEC-011). (FEAT-466 re-review nit.)
- **AC-4:** Given a moved-but-identical dataset (same sha256, different path),
  When `--resume` runs, Then the refusal-on-path behavior is pinned by an
  explicit test in `scripts/eval/shared/run-params.test.ts` and one README
  line documents it as intentional strictness. (462a re-review nit.)
- **AC-5:** Given `normalizeConfigDir` in `src/storage/keystore.ts`, When the
  suite runs on ANY platform, Then an executable test asserts the non-win32
  branch does NOT case-fold (platform-parameterize the helper or test the
  pure function directly with an injected platform arg — do not skip on
  non-Windows). (FEAT-466 re-review LOW.)

## Non-goals

Suite-flake fix (FEAT-471), sync-token scoping (FEAT-472), smart-quote
redaction (FEAT-473) — real work, separate FEATs.
