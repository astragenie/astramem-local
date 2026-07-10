---
id: SLICE-421
title: Implement FEAT-463
status: completed
feature: FEAT-463
phase: null
priority: P1
target_release: null
requires_validation: true
risk: high
created: 2026-07-10
updated: 2026-07-10
completed_at: 2026-07-10
---
# SLICE-421: Implement FEAT-463

Implements FEAT-463. See [feature file](../../../backlog/in-progress/FEAT-463.md) for product context.

## Objective

**Stage-0 redaction: quoted/JSON label forms not detected** — the

## In scope

- bullet 1
- bullet 2

## Out of scope

- bullet 1

## Acceptance criteria

- [ ] **AC-1:** Given transcript text containing the JSON double-quoted label/value form `"OPENAI_API_KEY": "sk-proj-AbCdEf1234567890"`, When stage-0 redaction runs the widened `generic_credential` detector in `src/redact/detectors.ts`, Then the captured value group spans only the text between the quotes (`sk-proj-AbCdEf1234567890`), the output replaces it with a `[REDACTED:generic_credential:<hash8>]` placeholder, and the surrounding double-quote characters, the `"OPENAI_API_KEY"` label, and the `: ` separator are left byte-for-byte unchanged — mirroring how the existing `AccountKey=(\S+)` detector already leaves its label untouched (`detectors.ts:52-56`). Also cover, as additional positive fixtures in the same table: the trailing-keyword compound form `"DJANGO_SECRET_KEY": "abcdefgh1234"` (currently unmatched for the same adjacency reason), and a quote sitting directly against the separator with no intervening space, `"SECRET_KEY"=abcdefgh1234` (quoted label, unquoted value) — confirming the widened pattern tolerates a closing quote/apostrophe between keyword and separator independent of whether the value side is itself quoted.
- [ ] **AC-2:** Given transcript text containing the PHP array-arrow form `'DB_PASSWORD' => 'hunter2'`, When the detector runs, Then `hunter2` is redacted between its single quotes, and the label `'DB_PASSWORD'` plus the full `=>` arrow are left intact character-for-character. Note for implementation: today's separator match is `\s*[:=]\s*(\S+)`, which for `=>` consumes only the `=` and would wrongly capture `>'hunter2'` as the "value" (extra leading `>`) — the fix must treat `=>` as its own two-character separator alternative, not assume `[:=]` alone covers it.
- [ ] **AC-3:** Given the quote-tolerant widening is in place, When the detector runs over each of: benign quoted non-secret config (`"NODE_ENV": "production"`, `"PORT": "7777"`), a quoted numeric/boolean value on an any-segment keyword (`"PASSWORD_MIN_LENGTH": 8`, `"SECRET_SCAN_ENABLED": "true"`), and a quoted mid-word collision (`"authtoken": "abc123456789"`), Then none of these five lines are redacted — the existing numeric/boolean `valueFilter` guard (`detectors.ts:138`) and the `(?<![A-Za-z])` mid-word lookbehind guard both keep applying correctly when the label or value is quoted, not just in the unquoted forms they were originally proven against.
- [ ] **AC-4:** Given the full existing `tests/security/redact.test.ts` suite (all `TRUE_POSITIVES` fixtures and all false-positive-guard cases, unmodified), When the suite runs after this change, Then every case still passes with byte-identical redaction behavior on unquoted forms — this FEAT adds new fixtures alongside the existing ones, it does not alter any existing detector behavior for text with no adjacent quote character.
- [ ] **AC-5:** Given a quoted/JSON-label match fires (AC-1/AC-2/AC-3), When the redaction pass completes, Then the resulting `RedactionEvent` is recorded through the existing `src/storage/redaction-log.ts` path using a `type` string distinguishable from the plain trailing-unquoted match (e.g. a dedicated detector `type` value such as `generic_credential_quoted`, following the same one-`type`-per-detector-entry convention `PATTERN_DETECTORS` already uses for `azure_key` across its three separate entries in `detectors.ts:52-70`) — this requires no `redaction_log` schema/migration change (confirmed: `migrations/005-security.sql` has only a `type TEXT` column, no pattern-shape sub-field), only an additional detector-table entry with its own `type` value, keeping the change within the single-file (`detectors.ts`) blast radius the PM triage scoped.
- [ ] **AC-6:** Given the widened label/value regexes are exercised against the existing `tests/security/redact-perf.test.ts` corpus (the representative auto-capture-shaped payload in `buildRepresentativePayload()`), When the perf smoke test runs, Then p95 latency stays under the test's existing 20ms budget (`redact-perf.test.ts:68`), confirming the added quote-tolerance and `=>`-arrow alternation did not introduce catastrophic backtracking on the hot ingest path.

## Done When

- all acceptance criteria PASS with evidence per `01-loop-control/EVIDENCE_RULES.md`
- build / test commands per `.claude/loop.json` pass
- feature FEAT-463 moved from `in-progress/` to `done/`
- Crew `final-synthesis` artifact written
- (pure refactors / mechanical changes: set `requires_validation: false` in frontmatter
   above to waive the validation gate — no badge needed at close time)

## Reviewer ladder

- Reviewer A: ...
- Reviewer B: ...
