---
objective: FEAT-552 sub-scope B — regex type-hint tier + retroactive backfill CLI
owner: crew:fullstack-dev
worktree: C:\work\mega\astramemory-local-wtB
branch: feat/552b-type-tier
base: 98515925
tip: 56116f75
status: FIXED (review round 1: needs_fix -> addressed)
---

## Review round 1 — needs_fix, addressed

`crew:reviewer` (`.claude/artifacts/crew/reviews/20260718T073615Z-review-result-feat-552b-type-tier-review.md`)
found a HIGH issue, live-reproduced against `dist/`: `normalizeText()`'s
`ENTITY_DICT` capitalizes bare `bun` -> `Bun` (and `vitest` -> `Vitest`)
BEFORE the type-hint tier ever runs at both real call sites
(07-memory-normalize.ts, backfill-types.ts both feed `getTypeHint()`
`normalized_text`, never raw atom text) — `COMMAND_LEAD_RE` was
lowercase-only, so it silently never fired for any bun-/vitest-led command
atom in production, even though the original AC-B1 census (measured
against RAW fixture text, not the real production order) counted those
fires as correct.

**Fix** (commit `56116f75`):
- `COMMAND_LEAD_RE` is now case-insensitive (`i` flag) — the smaller-diff
  option the reviewer suggested, and robust to any future `ENTITY_DICT`
  capitalization rule, not just today's `bun`/`vitest`.
- Dropped `'make'` from `COMMAND_TOKENS`: going case-insensitive means it
  would now collide with `"Make"` in `DECISION_IMPERATIVE_FIRST_RE` for a
  real gold-set decision atom ("Make the feature-flag lookup default to
  false... instead of throwing"). `getTypeHint`'s ambiguity guard resolves
  that collision safely to `null` (never a wrong single fire), but it
  silently costs real decision recall for a token no gold fixture actually
  needs as a command — not gold-tested, cut rather than risk it.
- Added end-to-end regression tests that seed a bun-/vitest-led command atom
  through the REAL call sites — `memoryNormalize()` directly, and
  `runTypeBackfillBatch()` via a `normalizeText()`-derived `normalized_text`
  column (a new `seedNormalized()` test helper, since the existing `seed()`
  helper stored raw text verbatim as a shortcut) — rather than calling
  `getTypeHint()` directly on raw text, which is the exact gap that let the
  bug ship green the first time.
- Corrected the AC-B1 census test (`tests/distill/type-hints.test.ts`) to
  run every gold-fixture atom through `normalizeText()` BEFORE
  `getTypeHint()`, matching the real production order. Re-run numbers are
  **unchanged** from the original (mistaken-methodology) census — command/
  decision/lesson still 100% precision, event still vacuous 0 fires — see
  the corrected census table below. The fix restores fires the
  case-sensitive bug was silently dropping, without introducing new false
  positives (verified by rerunning the same 194-atom gold set).
- **MEDIUM follow-up, recorded but NOT fixed in this pass** (reviewer flagged
  as optional/non-blocking): `backfill-types.ts`'s `writeCheckpoint()` is a
  plain `writeFileSync`, not `writer.ts`'s `writeConfig()` tmp+rename
  pattern. It self-heals via the malformed-JSON-to-rowid-0 fallback on next
  read, so it is not silently wrong — but a crash mid-write on a large
  (e.g. 48k-row) corpus could force a full-corpus rescan rather than
  resuming from the last good checkpoint. Small, isolated fix
  (`src/cli/backfill-types.ts`'s `writeCheckpoint`) if picked up later; not
  blocking for this slice per the reviewer's own severity call.
---

## Objective

Implement FEAT-552 sub-scope B (spec: `.claude/artifacts/loop/backlog/pending/FEAT-552.md`
section "B", ACs B1–B2) — a deterministic, zero-LLM regex tier that corrects
an atom's `type` when the atom text carries an unambiguous surface signal
the extraction model missed, plus a one-shot CLI to retroactively re-type
existing stored atoms with the same rules.

## Allowed scope

`src/distill/type-hints.ts` (new), `07-memory-normalize.ts` wiring, config
governance (`distill.typeHints`), `backfill-types` CLI + core module, tests
under `tests/distill/`, `tests/storage/`, `tests/config/`. No migrations, no
LLM calls, no schema changes (per spec's explicit out-of-scope list).

## Forbidden scope

Sub-scopes A (extraction parsing salvage) and C (consolidation/evidence
determinism) — separate worktrees, not touched here.

## Deliverable

### AC-B1 — type-hint rules module

`src/distill/type-hints.ts`: `getTypeHint(text, opts?) -> {hint, matchedPattern} | null`.
Four STRONG patterns, each independently tuned against the full 55-fixture
gold set to clear a 95% precision floor:

- **command**: leading shell-executable token (git/npm/bun/npx/kubectl/curl/
  docker/dotnet/az/gh/vitest/tsc/pg_dump/pg_restore/psql/aws/node/ssh/scp/
  make/systemctl/journalctl/schtasks/launchctl) followed by whitespace-or-end
  (not just a word boundary — rejects "aws-sdk was already replaced..."),
  with a second-token auxiliary-verb stoplist (is/was/does/did/will/...) that
  rejects narrative sentences merely starting with a tool's name ("npm does
  not support unpublishing...").
- **decision**: four unambiguous strong phrases ("chosen over", "in favor
  of", "decided to use/go with", "we'll/we will use") fire unconditionally;
  the weaker comparators "instead of"/"rather than" additionally require the
  sentence to OPEN with an imperative decision verb (Use/Add/Fix/Migrate/
  Cap/Build/Preserve/Make/Choose/Switch/Adopt/Pick/Set/Default/Prefer/Keep/
  Route/Store/Opt/"Go with") — bare "instead of" alone false-fired on
  narrative lesson/fact/todo prose in the gold set (~54% precision
  standalone); the imperative-first gate raised it to 100%.
- **lesson**: "turns out", "root cause", "the bug was", "lesson:", "learned
  that" (colon-ending alternative pulled out of the shared trailing `\b`
  group — a boundary check right after `:` followed by whitespace never
  matches, since neither side is a word character).
- **event**: sentence-initial capitalized ship verb (Shipped/Released/
  Deployed/Merged) OR explicit passive voice ("was/were shipped/released/
  deployed/merged") — deliberately excludes a bare mid-sentence occurrence,
  so a parenthetical status marker like "(merged)" or "the deploy shipped"
  (no "was" immediately before it) does not fire.

More than one pattern firing on the same atom = ambiguous = `null` + a
structured log line (never guesses). Empty/whitespace text = `null`.

**Measured gold-set census** (`tests/distill/type-hints.test.ts`, run against
all 55 `scripts/eval/extraction-bench/fixtures/*.json`, 194 gold atoms).
**CORRECTED METHODOLOGY (review round 1):** every atom is run through
`normalizeText()` FIRST, exactly matching the real production order both
call sites use — the original round-1 census called `getTypeHint()` on raw
fixture text directly, which is what let the case-sensitive `bun`/`vitest`
bug pass its own test undetected:

| pattern  | fires | correct | precision | fire-rate |
|----------|-------|---------|-----------|-----------|
| command  | 10    | 10      | 100.0%    | 5.2%      |
| decision | 13    | 13      | 100.0%    | 6.7%      |
| lesson   | 1     | 1       | 100.0%    | 0.5%      |
| event    | 0     | 0       | n/a (0 fires) | 0.0%  |

no-fire: 170/194 (87.6%); ambiguous (multi-pattern, null+logged): 0.

Numbers are IDENTICAL to the round-1 (methodologically wrong) census — the
`COMMAND_LEAD_RE` case-insensitivity fix restores the fires the bug was
silently dropping (bun-led commands) without introducing new false
positives, so the corrected-methodology re-run lands on the same totals by
coincidence, not because the fix was a no-op (see the round-1 finding at the
top of this document and the end-to-end regression tests it added, which
would have failed before the fix). Every pattern that fires clears the 95%
floor. `event`'s zero fire-rate on this corpus is a correct, honest outcome
(real event atoms in the gold set are narrated, not phrased with these
verbs) — not a bug to paper over by loosening the match and risking false
positives.

### Wiring + config

- `07-memory-normalize.ts`: `memoryNormalize(atoms, { typeHints?, log? })`.
  Runs the hint against each atom's *normalized* text (post entity-dict
  canonicalization) and overrides `type` ONLY when the hint fired AND
  disagrees with the model's type; sets `typeHintApplied: {from, to,
  matchedPattern}` for observability, left `undefined` otherwise (agree, no
  fire, or ambiguous).
- Both real call sites updated: `src/distill/pipeline.ts` (passes
  `ctx.config?.distill.typeHints`) and `src/pipeline/handlers/distill-events.ts`
  (passes `ctx.config.distill.typeHints`) — both now also log
  `type_hints_applied` count on the stage-complete line (ADR-015 "measure the
  rate" posture).
- `Config['distill']['typeHints']: 'on' | 'off'`, default `'on'` — the ONE
  distill.* tier that ships on (every other tier in this file ships off);
  documented rationale inline (deterministic, gold-set-tested, reversible,
  no LLM call).
- `applyTypeHintsGovernance` (config.ts) mirrors `applyDurabilityGateGovernance`'s
  shape but falls back to `'on'` (not `'off'`) on an invalid/missing value —
  wired into BOTH `loadConfig()` (config.ts) and `loadConfigFromDisk()`
  (loader.ts), matching the existing "both composition points" bar this
  repo's reviewers hold every other `distill.<tier>` governance function to.
- `writer.ts`: added the missing emission line so an operator's explicit
  `typeHints: off` survives a future `writeConfig()` call (the exact
  FEAT-461 "writer silently drops a field" class this file exists to
  prevent) — `findMissingConfigKeys`'s generic per-field check now passes
  for this field automatically.

### AC-B2 — backfill-types CLI

`src/distill/backfill-types.ts` (core, DB-only, unit-testable — mirrors
`src/tag-hygiene/backfill.ts`'s shape) + `src/cli/backfill-types.ts` (CLI
wrapper). `astramem-local backfill-types [--apply] [--batch-size N]
[--limit N] [--reset] [--json]`.

- Dry-run is the default (matches every other backfill CLI in this repo).
  Prints a would-change census (fromType -> toType: count); mutates nothing.
- `--apply` updates `memories.type` + `updated_at` and appends ONE
  `memory_events` row per change: `event_type: 'usefulness'`, payload
  `{family: 'type_corrected', action: 'retype', from, to, matched_pattern,
  source: 'type-backfill'}`. Deliberately a NEW family (`type_corrected`),
  NOT the existing `memory_corrected` family invalidate()/supersede() use —
  that family is a negative usefulness signal
  (`src/storage/usefulness.ts`'s feedback-loop queries count it against an
  atom); a type retag is a metadata correction, not "this memory was wrong,"
  and must not silently poison usefulness scoring for atoms that were simply
  mistyped.
- Batched by rowid, resumable via a checkpoint file
  (`<dataDir>/backfill-types.checkpoint.json`, `{lastRowid}`) written after
  every applied batch — an interrupted `--apply` run resumes rather than
  re-scanning or silently skipping rows. Dry-run never reads/writes the
  checkpoint (a preview must always reflect the whole corpus, not a stale
  resume point from a prior `--apply`). `--reset` clears it.
- Only ever reads `type`/`normalized_text`, only ever writes
  `type`/`updated_at` — never `text`, `hash`, or the vector index. Scoped to
  `valid_to IS NULL` (never retypes an already-superseded/invalidated row).
  Idempotent: a second `--apply` run over an already-backfilled corpus finds
  zero candidates (asserted in tests).

## Files changed

- `src/distill/type-hints.ts` (new)
- `src/distill/stages/07-memory-normalize.ts`
- `src/distill/pipeline.ts`
- `src/pipeline/handlers/distill-events.ts`
- `src/config/config.ts` (`typeHints` field, default, `applyTypeHintsGovernance`, wired into `loadConfig`)
- `src/config/loader.ts` (wired into `loadConfigFromDisk`)
- `src/config/writer.ts` (emission line)
- `src/distill/backfill-types.ts` (new — core)
- `src/cli/backfill-types.ts` (new — CLI wrapper)
- `src/cli/index.ts` (command registration + help text)
- `tests/distill/type-hints.test.ts` (new — AC-B1, unit patterns + gold-set census)
- `tests/distill/07-memory-normalize.test.ts` (extended — override/no-override/off/ambiguous)
- `tests/storage/backfill-types.test.ts` (new — AC-B2, dry-run/apply/resume/idempotent/skip-invalidated)
- `tests/config/config.test.ts` (extended — `applyTypeHintsGovernance` + 4 existing `distill` literal fixtures patched with the new required field)
- `tests/config/writer.test.ts` (extended — `buildFullyPopulatedConfig()` fixture gets `typeHints: 'off'`)
- **Fix commit `56116f75`** (review round 1): `src/distill/type-hints.ts` (case-insensitive `COMMAND_LEAD_RE`, dropped `'make'` token), `tests/distill/type-hints.test.ts` (corrected census methodology), `tests/distill/07-memory-normalize.test.ts` (+2 bun/vitest end-to-end regressions), `tests/storage/backfill-types.test.ts` (+1 bun-led backfill regression + `seedNormalized()` helper)
- `.claude/artifacts/crew/reviews/20260718T073615Z-review-result-feat-552b-type-tier-review.md` (review artifact, carried for evidence)

## Verification evidence (post-fix, commit `56116f75`)

```
unset ASTRA_SKIP_CONSOLIDATE
bun run build                              -> clean (tsc -p .)
npx tsc -p tsconfig.tests.json --noEmit    -> clean
npx tsc -p tsconfig.eval.json --noEmit     -> clean
npx vitest run tests/distill/ tests/storage/ tests/config/
  -> 66 test files passed, 1210 tests passed
```

Targeted new-file runs (subset of the above, called out individually):
- `tests/distill/type-hints.test.ts` — 12/12 passed (includes corrected-methodology AC-B1 census)
- `tests/distill/07-memory-normalize.test.ts` — 22/22 passed (+2 bun/vitest end-to-end regressions)
- `tests/storage/backfill-types.test.ts` — 6/6 passed (+1 bun-led backfill regression via real `normalized_text`)
- `tests/config/config.test.ts` — 95/95 passed

Manual smoke: `node dist/cli/index.js backfill-types --json` against
`ASTRA_MEMORY_DATADIR=:memory:` returns a well-formed empty-DB dry-run
result (`{"dryRun":true,"scanned":0,...,"exhausted":true}`).

## AC checklist

- **B1** — rules module unit-tested against the 55-fixture gold set;
  measured hint accuracy reported using the PRODUCTION (normalize-then-hint)
  order (table above, corrected post-review); all firing patterns >=95%
  precision; no-fire correctly preserved on ambiguity; end-to-end
  bun-/vitest-led regression tests added. **PASS**
- **B2** — backfill dry-run prints census; apply updates types + emits audit
  events; resumable (checkpoint file, verified via two-small-batches ==
  one-big-batch test + a third no-op resume call); text/vec/hash asserted
  unchanged in a seeded DB with a real `memories_vec` row; bun-led regression
  via real `normalizeText()`-derived `normalized_text`. **PASS**
- **ALL** — build + tsc(tests, eval) clean; targeted suites green (66 files /
  1210 tests); DB-row assertions present for every counter this slice
  introduces (census, audit-event payload, hash/vec-untouched). **PASS**

## Confidence / risks

High confidence. No migrations, no LLM calls, no schema changes — matches
the FEAT-552 spec's explicit constraints. The `event` pattern has a 0%
fire-rate on the current gold corpus (by design — see rationale above); a
future fixture with genuine ship-verb-phrased event atoms would be the
first real test of its precision at a nonzero fire-rate, but the pattern
was independently designed to reject every false-fire shape found during
development (parenthetical status markers, unrelated-clause "the deploy
shipped").

One pre-existing gap surfaced but NOT touched (out of scope for this
sub-scope): none of `distill.typeHints`, `atomTriage`, or `gatekeeper`
provider/model overrides are round-tripped by `writer.ts` beyond the mode
field itself (documented in existing code comments as a known, accepted
gap for atomTriage/gatekeeper/extractionPassB) — `typeHints` has no
provider/model field so this doesn't apply to it, noted only for context.

## Suggested next handoff

Sub-scopes A and C (separate worktrees, per the FEAT-552 3-way split) are
independent and can proceed/complete without depending on this one. No
follow-up FEAT needed for B specifically — B1/B2 are both fully satisfied.
