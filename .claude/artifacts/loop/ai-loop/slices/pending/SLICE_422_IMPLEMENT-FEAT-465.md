---
id: SLICE-422
title: Implement FEAT-465
status: pending
feature: FEAT-465
phase: null
priority: P2
target_release: null
requires_validation: true
risk: medium
created: 2026-07-10
updated: 2026-07-10
---
# SLICE-422: Implement FEAT-465

Implements FEAT-465. See [feature file](../../../backlog/in-progress/FEAT-465.md) for product context.

## Objective



## In scope

- bullet 1
- bullet 2

## Out of scope

- bullet 1

## Acceptance criteria

- [ ] **AC-1:** Given a config line with a quoted scalar value containing a `#` (e.g. `ollama.baseUrl: "http://host:11434/ #note"`), When `src/config/loader.ts` strips comments, Then the `#` inside the double quotes is treated as literal content, not a comment delimiter, and the full quoted value round-trips unchanged — fixing the exact SLICE-420 repro where `customPatterns` entry `'hash #tag no leading space'` currently corrupts to `["hash`.
- [ ] **AC-2:** Given a `[...]` flow-sequence line whose entries contain `#` inside quotes (e.g. `customPatterns: ["hash #tag no leading space", 'another #value']`), When the loader parses that line, Then every entry's `#`-bearing content is preserved intact, the array retains its original entry count, and no entry is silently truncated at its embedded `#`.
- [ ] **AC-3:** Given a config line with a genuine trailing comment after an unquoted value (e.g. `port: 7777 # the daemon port`), When the loader strips comments, Then everything from that unquoted `#` onward is removed and the resolved value is `7777` — real trailing comments are still stripped, not just quoted ones preserved.
- [ ] **AC-4:** Given a config line with a trailing comment placed after a closed quoted value (e.g. `secret: "abc123" # rotate me`), When the loader strips comments, Then the quoted value `abc123` is preserved exactly and the comment text after the closing quote is still stripped.
- [ ] **AC-5:** Given new round-trip fixtures covering both a `#`-bearing quoted scalar and a `#`-bearing flow-sequence entry are added to the existing `tests/config` suite, When the full test suite runs, Then the new fixtures pass and every pre-existing config-loader test also still passes unchanged — no regression on lines with no adjacent quote character.
- [ ] **AC-6:** Given this fix lands and its new tests are green, When the CHANGELOG is reviewed, Then the FEAT-461 caveat noting "`#` in customPatterns unsupported" is removed or updated to reflect that quoted/flow-sequence `#` values are now handled correctly.

## Done When

- all acceptance criteria PASS with evidence per `01-loop-control/EVIDENCE_RULES.md`
- build / test commands per `.claude/loop.json` pass
- feature FEAT-465 moved from `in-progress/` to `done/`
- Crew `final-synthesis` artifact written
- (pure refactors / mechanical changes: set `requires_validation: false` in frontmatter
   above to waive the validation gate — no badge needed at close time)

## Reviewer ladder

- Reviewer A: ...
- Reviewer B: ...
