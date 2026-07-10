# Handoff: FEAT-465 / SLICE-422 — config loader comment-stripping quote-awareness

## Objective
Fix `src/config/loader.ts`'s quote-unaware `#`-comment stripping, which silently
truncated any config.yaml scalar (or flow-sequence entry) whose value contained
a whitespace-preceded `#`. Reproduced by the SLICE-420 review: a
`security.redaction.customPatterns` entry `'hash #tag no leading space'`
round-tripped as the corrupted string `["hash`.

## Owner
builder (this run), inside worktree `C:\work\mega\astramemory-local-worktrees\w465`,
branch `feat/feat-465-loader-comments`.

## Scope
- In: `src/config/loader.ts` (comment-stripping + scalar/flow-sequence parsing),
  `tests/config/loader.test.ts` (new round-trip fixtures), `CHANGELOG.md` and
  `src/config/config.ts` doc-comment (stale FEAT-461 caveat removal, AC-6).
- Out: no YAML-library migration (explicit non-goal); no other config files touched.

## Deliverable
Quote-aware `stripComment` (tracks single-/double-quote state character by
character; a `#` inside quotes is content, not a comment delimiter — genuine
trailing comments, including ones after a closed quoted value, are still
stripped). `parseScalar` gained double-quote unwrapping and a quote-aware
`splitFlowSequenceEntries` fallback (used when a hand-edited flow-sequence with
single-quoted or mixed-quote entries fails `JSON.parse`), so entry count and
`#`-bearing content survive instead of degrading to an opaque string.

## Changed files
- `src/config/loader.ts` — `stripComment`, `unescapeDoubleQuoted`,
  `splitFlowSequenceEntries`, `parseScalar` double-quote branch + flow-sequence
  fallback.
- `tests/config/loader.test.ts` — new `describe` blocks: quote-aware
  comment-stripping (AC-1..AC-4 + no-regression case) and writer→loader
  round-trip with literal `#` in `customPatterns` and `dataDir` (AC-5).
- `CHANGELOG.md` — Fixed entry added; stale `#`-in-customPatterns caveat
  removed (AC-6).
- `src/config/config.ts` — `customPatterns` doc-comment caveat replaced with a
  note that `#` is now safe (AC-6).

## Per-AC evidence
- **AC-1** (double-quoted scalar with `#`): `tests/config/loader.test.ts` —
  `'baseUrl: "http://host:11434/ #note"'` parses to
  `'http://host:11434/ #note'`. PASS.
- **AC-2** (flow-sequence entries with `#`, mixed quote styles): parses
  `customPatterns: ["hash #tag no leading space", 'another #value']` to
  `['hash #tag no leading space', 'another #value']` — entry count and content
  preserved. PASS.
- **AC-3** (genuine trailing comment after unquoted value): `port: 7777 # the
  daemon port` → `port === 7777`. PASS (already worked pre-fix; regression
  guard now explicit).
- **AC-4** (trailing comment after a closed quoted value): `secret: "abc123" #
  rotate me` → `secret === 'abc123'`. PASS.
- **AC-5** (new round-trip fixtures + full existing suite green): 5 new tests
  added to `tests/config/loader.test.ts`; full `tests/config` suite = 111/111
  pass; full `bun run test` = 2367 passed, 6 skipped, 0 failed (198 test
  files). PASS.
- **AC-6** (CHANGELOG + config.ts caveat removal): both stale caveats replaced
  with fixed-state notes referencing FEAT-465. PASS.

## Gates run (in worktree)
- `bun install` — ok (255 packages).
- `bunx tsc --noEmit` — clean, no errors.
- `bun run build` (`tsc -p .`) — clean.
- `bun vitest run tests/config` — 111 passed (10 files).
- `bun run test` (full suite) — 2367 passed, 6 skipped, 0 failed (198 files).

## Confidence
High. The fix is isolated to `loader.ts`'s two helper functions plus
`parseScalar`'s existing branches; quote-tracking logic is straightforward
single-pass character scanning with no new external dependency. Full suite is
green with no regressions.

## Risks / open questions
- `unescapeDoubleQuoted` implements only minimal backslash-unescaping (`\X` ->
  `X`), not the full YAML double-quote escape grammar (e.g. `\n` is not
  converted to a real newline). Sufficient for round-tripping what
  `yamlScalar`/`JSON.stringify` ever emit (which never produces double-quoted
  scalars) plus reasonable hand-edits; a hand-edit relying on YAML's full
  double-quote escape set would not get full YAML semantics. Out of scope per
  the non-goal (no YAML-library migration).
- `splitFlowSequenceEntries` assumes flat scalar entries (strings via
  quote-unwrap, or bare tokens re-parsed through `parseScalar` for
  numbers/booleans/null) — no nested brackets/objects, consistent with
  `customPatterns` being the only array-typed `Config` field today. The
  reviewer confirmed this degrades silently (not loudly) for a hypothetical
  future array-of-arrays field; low priority since no current field can
  trigger it.

## Fix round (review needs_fix, resolved)

Review artifact:
`.claude/artifacts/crew/reviews/20260710T140706Z-review-result-slice-422-feat-465-loader-comments.md`
— verdict `needs_fix`, one HIGH-severity regression.

**Finding 1 (HIGH, reproduced by reviewer, fixed):** the first-round
`stripComment` treated ANY bare `'` outside quote state as opening a
single-quoted scalar, with no regard for position. An unquoted value with an
**odd** number of apostrophes before a real trailing `#` comment (a
contraction like `don't`, a name like `O'Brien`) left the scanner believing
it was still "inside quotes" when it reached the `#`, so the comment text
was silently appended into the parsed value — e.g.
`dataDir: C:\Users\don't\AppData # a trailing comment` corrupted to
`dataDir: "C:\Users\don't\AppData # a trailing comment"`. Confirmed a
genuine regression: the old quote-unaware regex handled this correctly by
never tracking quote state at all. Silent, and for `dataDir` specifically
changes where the daemon opens its SQLite file.

**Fix:** a `'`/`"` now only opens quote state at a position where a scalar
value may legally *start* — right after the `key:` separator, or right
after a top-level `[`/`,` inside a flow sequence — never at an arbitrary
quote character mid-value (matches YAML's actual grammar: an unquoted
scalar's embedded apostrophe is just a literal character). Applied the
identical fix to `splitFlowSequenceEntries`, which had the same latent bug
for an unquoted flow-sequence entry containing an apostrophe (not explicitly
flagged by the reviewer, but same root cause — fixed proactively for
consistency).

**New tests** (`tests/config/loader.test.ts`, describe block "apostrophe-in-
unquoted-value regression (FEAT-465 review fix)"), matching the reviewer's
required (a)-(f) list:
- (a) odd apostrophe count + real trailing comment — reviewer's exact repro,
  comment stripped, value intact.
- (b) even apostrophe count + real trailing comment — control case.
- (c) O'Brien-style Windows path variant.
- (d) quoted value containing apostrophes + real trailing comment — still
  works (`#` inside quotes protected, comment after closing quote stripped).
- (e) unquoted flow-sequence entry containing an apostrophe — preserved
  literally, entry count correct.
- (f) full existing suite stays green (see gates below).

**Gates re-run after fix (in-worktree):**
- `bunx tsc --noEmit` — clean.
- `bun run build` — clean.
- `bun vitest run tests/config` — **116/116 passed** (10 files; was 111
  before this fix round's 5 new tests).
- `bun run test` (full suite) — **2372 passed, 6 skipped, 0 failed** (198
  files; was 2367 before this fix round's 5 new tests — delta accounted for
  exactly).

Reviewer's two disclosed, non-blocking notes (nested-array silent
degradation in `splitFlowSequenceEntries`, minimal double-quote unescaping)
were left as-is per the reviewer's own recommendation (real but low-priority,
already substantially disclosed in the handoff, not a blocker).

## Suggested next handoff
Re-review focused on Finding 1's fix (confirm the value-start-only
quote-opening logic and the `splitFlowSequenceEntries` parity fix are
correct), then `/runner:slice complete --id SLICE-422` ceremony (handoff +
final-synthesis + cost-report) followed by slice grade.

## Commits
- `7a330db` — `fix(config): quote-aware comment stripping in config.yaml
  loader (FEAT-465)` (4 files changed: `CHANGELOG.md`, `src/config/config.ts`,
  `src/config/loader.ts`, `tests/config/loader.test.ts`).
- `4459aa7` — `fix(config): quote-open only at scalar value start, not any
  bare quote (FEAT-465 review fix)` (2 files changed: `src/config/loader.ts`,
  `tests/config/loader.test.ts`) — resolves the review's HIGH-severity
  Finding 1.

No push, no merge performed.
