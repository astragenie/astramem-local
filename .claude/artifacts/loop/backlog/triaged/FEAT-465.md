---
id: FEAT-465
status: triaged
priority: P2
category: bug
target_release: null
created: 2026-07-10
updated: 2026-07-10
depends_on: []
slices: []
derived_from: .claude/artifacts/crew/reviews/20260710T121205Z-review-result-slice-420-feat-461-config-yaml.md (Finding 2, MEDIUM)
cross_product: [astramem-local]
tags: ["concern:config", "stack:typescript", "surface:daemon"]
pm_customer_impact: 0.45
pm_effort_estimate: 0.3
pm_strategic_alignment: 0.5
pm_technical_risk: 0.4
pm_dependency_depth: 0.15
pm_composite_priority: P2
pm_autonomous_safe: true
pm_reviewed: 2026-07-10
autonomous_safe: true
triage_notes: "P2 via formula (default branch): impact 0.45 < 0.70 so the (impact>=0.7 AND alignment>=0.6) P1 branch does not fire; alignment 0.5 < 0.80 so the (alignment>=0.8 AND effort<=0.4) P1 branch does not fire either; effort 0.3 < 0.70 so P3 (effort>=0.7 AND impact<=0.3) does not fire. composite_score = 0.45*0.35 + 0.5*0.30 + (1-0.3)*0.20 + (1-0.4)*0.10 + (1-0.15)*0.05 = 0.55. Customer impact scored moderate: a real silent-corruption bug (SLICE-420 review reproduced it directly: 'hash #tag no leading space' round-trips as '[\"hash'), but reachable only when a config scalar's value contains a whitespace-preceded '#' — narrow blast radius today, though newly exercised by security.redaction.customPatterns (FEAT-461) where users write arbitrary regex source and '#' is common. technical_risk banded at 0.4: confined to one file (src/config/loader.ts), no schema/migration, git-revertible, but the 'preserve quotes / treat # inside [...] as content' parsing logic is genuinely delicate on edge cases (nested flow sequences, escaped inner quotes) — same risk class as FEAT-463's own quote-preserving redaction fix. autonomous_safe=true: all three mechanical thresholds pass (risk 0.4, effort 0.3, dependency 0.15, all <=0.6) and this triage pass drafts concrete Given-When-Then ACs below (quote-aware stripping, flow-sequence entries, real-trailing-comment regression, existing-suite regression, CHANGELOG caveat removal) satisfying the AC-exists gate."
---
## Description

**config.yaml loader comment-stripping corrupts string values containing ` #`** —
`src/config/loader.ts` strips comments with a quote-unaware regex
(`/(^|\s)#.*$/`), so any scalar whose value contains a `#` preceded by
whitespace is silently truncated at load time. Pre-existing (affects e.g. a
quoted `ollama.baseUrl` containing ` #`), but newly exercised by
`security.redaction.customPatterns` (FEAT-461) — the first field intended to
hold arbitrary user regex source, where `#` is common.

Reproduced in the SLICE-420 review: pattern `'hash #tag no leading space'`
round-trips as the corrupted string `["hash`.

### Scope

- Make comment-stripping quote-aware in the hand-rolled loader: a `#` inside
  single/double quotes (and inside a `[...]` flow sequence) is content, not a
  comment delimiter.
- Round-trip tests: `#`-bearing quoted scalars, `#`-bearing entries inside
  flow-sequence arrays, actual trailing comments still stripped, inline
  comment after quoted value still stripped.
- Remove/adjust the FEAT-461 CHANGELOG caveat ("`#` in customPatterns
  unsupported") once fixed.

### Non-goals

- Not a YAML-library migration — keep the minimal hand-rolled loader; that
  larger decision belongs to a separate FEAT if ever needed.

## Acceptance criteria

- **AC-1:** Given a config line with a quoted scalar value containing a `#` (e.g. `ollama.baseUrl: "http://host:11434/ #note"`), When `src/config/loader.ts` strips comments, Then the `#` inside the double quotes is treated as literal content, not a comment delimiter, and the full quoted value round-trips unchanged — fixing the exact SLICE-420 repro where `customPatterns` entry `'hash #tag no leading space'` currently corrupts to `["hash`.
- **AC-2:** Given a `[...]` flow-sequence line whose entries contain `#` inside quotes (e.g. `customPatterns: ["hash #tag no leading space", 'another #value']`), When the loader parses that line, Then every entry's `#`-bearing content is preserved intact, the array retains its original entry count, and no entry is silently truncated at its embedded `#`.
- **AC-3:** Given a config line with a genuine trailing comment after an unquoted value (e.g. `port: 7777 # the daemon port`), When the loader strips comments, Then everything from that unquoted `#` onward is removed and the resolved value is `7777` — real trailing comments are still stripped, not just quoted ones preserved.
- **AC-4:** Given a config line with a trailing comment placed after a closed quoted value (e.g. `secret: "abc123" # rotate me`), When the loader strips comments, Then the quoted value `abc123` is preserved exactly and the comment text after the closing quote is still stripped.
- **AC-5:** Given new round-trip fixtures covering both a `#`-bearing quoted scalar and a `#`-bearing flow-sequence entry are added to the existing `tests/config` suite, When the full test suite runs, Then the new fixtures pass and every pre-existing config-loader test also still passes unchanged — no regression on lines with no adjacent quote character.
- **AC-6:** Given this fix lands and its new tests are green, When the CHANGELOG is reviewed, Then the FEAT-461 caveat noting "`#` in customPatterns unsupported" is removed or updated to reflect that quoted/flow-sequence `#` values are now handled correctly.
