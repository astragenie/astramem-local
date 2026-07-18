---
objective: FEAT-552 sub-scope B — regex type-hint tier + retroactive backfill CLI
owner: crew:fullstack-dev
worktree: C:\work\mega\astramemory-local-wtB
branch: feat/552b-type-tier
base: 98515925
tip: 37f8f168fd9632bda181c1487f54e1b6abc778f5
status: DONE
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
all 55 `scripts/eval/extraction-bench/fixtures/*.json`, 194 gold atoms):

| pattern  | fires | correct | precision | fire-rate |
|----------|-------|---------|-----------|-----------|
| command  | 10    | 10      | 100.0%    | 5.2%      |
| decision | 13    | 13      | 100.0%    | 6.7%      |
| lesson   | 1     | 1       | 100.0%    | 0.5%      |
| event    | 0     | 0       | n/a (0 fires) | 0.0%  |

no-fire: 170/194 (87.6%); ambiguous (multi-pattern, null+logged): 0.

Every pattern that fires clears the 95% floor. `event`'s zero fire-rate on
this corpus is a correct, honest outcome (real event atoms in the gold set
are narrated, not phrased with these verbs) — not a bug to paper over by
loosening the match and risking false positives.

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

## Verification evidence

```
unset ASTRA_SKIP_CONSOLIDATE
bun run build                              -> clean (tsc -p .)
npx tsc -p tsconfig.tests.json --noEmit    -> clean
npx tsc -p tsconfig.eval.json --noEmit     -> clean
npx vitest run tests/distill/ tests/storage/ tests/config/
  -> 66 test files passed, 1207 tests passed
```

Targeted new-file runs (subset of the above, called out individually
during build):
- `tests/distill/type-hints.test.ts` — 12/12 passed (includes AC-B1 census)
- `tests/distill/07-memory-normalize.test.ts` — 20/20 passed
- `tests/storage/backfill-types.test.ts` — 5/5 passed
- `tests/config/config.test.ts` — 95/95 passed

Manual smoke: `node dist/cli/index.js backfill-types --json` against
`ASTRA_MEMORY_DATADIR=:memory:` returns a well-formed empty-DB dry-run
result (`{"dryRun":true,"scanned":0,...,"exhausted":true}`).

## AC checklist

- **B1** — rules module unit-tested against the 55-fixture gold set;
  measured hint accuracy reported (table above); all firing patterns
  >=95% precision; no-fire correctly preserved on ambiguity. **PASS**
- **B2** — backfill dry-run prints census; apply updates types + emits audit
  events; resumable (checkpoint file, verified via two-small-batches ==
  one-big-batch test + a third no-op resume call); text/vec/hash asserted
  unchanged in a seeded DB with a real `memories_vec` row. **PASS**
- **ALL** — build + tsc(tests, eval) clean; targeted suites green; DB-row
  assertions present for every counter this slice introduces (census,
  audit-event payload, hash/vec-untouched). **PASS**

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
