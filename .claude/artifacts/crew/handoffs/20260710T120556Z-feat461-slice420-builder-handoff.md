---
slice: SLICE-420
feature: FEAT-461
role: builder
status: mini_fix_complete
branch: feat/feat-461-config-yaml
commit: 2496848
review: .claude/artifacts/crew/reviews/20260710T121205Z-review-result-slice-420-feat-461-config-yaml.md (needs_fix, Finding 1 closed in 7c89fe9)
---

# SLICE-420 / FEAT-461 — builder handoff

## Mini-fix (2026-07-10, commit 2496848, on top of 7c89fe9/4b05678) — validator finding

Validator flagged (non-blocking severity, but this slice's own AC-3 code, so kept in
scope): `findMissingConfigKeys` fired a false-positive "missing keys" warn — `azure.
endpoint`, `azure.deployment`, `openaiCompatible.baseUrl`, `codexSubscription.authPath`
— on essentially every ordinary `init`/`reembed-dim`/`pair` run.

Root cause: `src/cli/init.ts` builds these blocks as `azure: { ...base.azure, endpoint:
answers.azureEndpoint, deployment: answers.azureDeployment }` — when the user didn't
configure that provider, `endpoint`/`deployment` are explicit **own properties with value
`undefined`**, not absent keys. `findMissingConfigKeys`'s `nestedKey in parsedChild` check
only tests key presence, so it fired even though `configToYaml` correctly omits these
fields (the pre-existing `cfg.azure.endpoint ? [...] : []` conditionals were never the
problem — the false positive was purely in the AC-3 diff check, not in the actual emitted
YAML).

Fix (`src/config/writer.ts`): a shared `hasNothingToEmit(value)` predicate — true for
`undefined` or an empty array (generalizing the `customPatterns` carve-out from the prior
fix round rather than hardcoding a field-name exclusion list) — is now consulted at both
the top-level and nested-key loops in `findMissingConfigKeys`. "Cannot be missing if there
is nothing to emit." A key with a real, defined value that's still absent from the
emitted output is untouched by this predicate and still flags correctly.

New tests in `tests/config/writer.test.ts` (2 tests, added to the existing AC-2 block):
- an `init.ts`-shaped `Config` (azure/openaiCompatible/codexSubscription/crossEncoder
  optional fields explicitly set to `undefined`, mirroring the real object-building
  pattern) reports zero missing keys and logs no AC-3 warning.
- a defined-but-unemitted field is still flagged: `cfg.azure.endpoint` set to a real
  value, then hand-stripped from an otherwise-correct emitted YAML string (isolating
  `findMissingConfigKeys`'s own logic from `configToYaml`'s current, correct behavior) —
  confirms the fix didn't create a blind spot for genuine regressions.

### Re-run self-verify gates (mini-fix)
- `bunx tsc --noEmit` — exit 0, no output.
- `bun run build` — exit 0 (`tsc -p .` clean).
- `bun vitest run tests/config` — **10 files / 104 tests passed, 0 failed.**
- `bun run test` (full suite) — **198 files / 2330 tests passed, 6 skipped, 0 failed**
  (up from 2328 by exactly the 2 new tests added here).

### Confidence
High. Root cause was confirmed directly against the actual `src/cli/init.ts` code (not
inferred), the fix is a small, principled predicate rather than a special case, and both
directions are tested: the false positive is gone, and a genuine missing-defined-field
regression is still caught.

### Suggested next handoff
Re-review/re-validate to confirm this closes the validator's finding, then proceed per
`requires_validation: true` in the slice frontmatter. Parent loop drives dispatch.

---

## Fix round (2026-07-10, commit 7c89fe9, on top of 60f2b97/ac3081f)

Review (`20260710T121205Z-review-result-slice-420-feat-461-config-yaml.md`) returned
**needs_fix**: all five ACs, the suite, and typecheck were independently re-verified and
confirmed genuine (reviewer even diffed pre-fix vs post-fix output in a separate worktree
for AC-5, more rigorously than my own test), but flagged one HIGH finding.

**Finding 1 (HIGH, reproduced by reviewer, now fixed):** always-emitting
`security.redaction.customPatterns: []` (even for the default/empty case) breaks
`reinstall --rollback` to a pre-FEAT-461 binary — the old loader has no flow-sequence
array branch, so it reads the line back as the literal string `"[]"`, and
`src/redact/index.ts`'s `(opts.customPatterns ?? []).map(...)` throws on the first
redaction-enabled request (redaction defaults on). Fixed write-side (the old binary can't
be patched):
- `configToYaml()` now omits `customPatterns` entirely when the array is empty/default
  (`src/config/writer.ts`) — a default config.yaml round-trips through an old binary
  exactly as before this feature, no new key for it to misparse.
- Defensive `Array.isArray(opts.customPatterns) ? ... : []` guard at
  `src/redact/index.ts:168` (the reviewer's requirement 3, for future rollback scenarios).
- CHANGELOG `[Unreleased]` entry documents the residual caveat: rolling back past this
  release with a **non-empty** `customPatterns` configured still requires manually
  removing that line first — inherent, since the old binary's code can't be changed
  retroactively.
- Doc-comment caveat added to `Config['security']['redaction']['customPatterns']`
  (`src/config/config.ts`) per the reviewer's Finding 2 suggestion.

**Finding 2 (MEDIUM, pre-existing, explicitly out of scope — not fixed):** the hand-rolled
parser's comment-stripping regex truncates any string containing a whitespace-preceded `#`,
which now also affects `customPatterns` values. Per the reviewer's own recommendation this
is NOT fixed in this branch (scope discipline — it's a whole-parser limitation predating
this slice); mitigated with a CHANGELOG note + the config.ts doc-comment caveat above, and
left for a follow-up FEAT.

New tests added in the fix round (`tests/config/writer.test.ts`, new describe block
`'FEAT-461 review fix: customPatterns omitted-when-empty (rollback compatibility)'`, 5
tests; `tests/security/redact.test.ts`, 1 test):
- default-config emit contains no `customPatterns` line
- a non-empty value still emits and round-trips through `writeConfig` -> `loadConfigFromDisk`
- `findMissingConfigKeys` and the AC-3 warning both stay quiet about the empty-array
  omission (pinned down explicitly, not just implied by the AC-2 tests)
- `redact/index.ts` treats a stringified `"[]"` input (simulating an old-loader misparse)
  as no custom patterns rather than throwing

### Re-run self-verify gates (fix round)
- `bunx tsc --noEmit` — exit 0, no output.
- `bun run build` — exit 0 (`tsc -p .` clean).
- `bun vitest run tests/config tests/security/redact.test.ts` — **11 files / 163 tests
  passed, 0 failed.**
- `bun run test` (full suite) — **198 files / 2328 tests passed, 6 skipped, 0 failed**
  (up from 2322 in the prior round by exactly the 6 new tests added here).

### Confidence
High. The fix is narrowly scoped to the exact regression the reviewer reproduced
end-to-end, doesn't touch the emitter/loader contract for any other field, and every new
behavior (omit-when-empty, the redact guard, the quiet structural-diff/warning behavior)
has direct test coverage. Finding 2 was deliberately left alone per the reviewer's own
"not a merge blocker, don't fix in this branch" guidance.

### Suggested next handoff
Re-review (crew:reviewer) to confirm Finding 1 is closed, then validator per
`requires_validation: true` in the slice frontmatter. Parent loop drives both dispatches.

---

## Original implementation (2026-07-10, commits 60f2b97/ac3081f)

## Objective
`configToYaml()` in `src/config/writer.ts` silently dropped newer `Config`
fields on every `writeConfig()` call. Since `loadConfigFromDisk` (loader.ts)
deep-merges parsed YAML over `defaultConfig()`, any field the emitter failed
to write silently reverted to its code default on next load — a
user-invisible data-loss bug on common maintenance commands (`init`,
`reembed-dim`, `pair`, auto-capture disable).

## Owner
Builder (this run). Implementation only — review/validation are the parent
loop's gates, not dispatched from here.

## Scope
**In scope (done):**
- Added missing top-level blocks to `configToYaml`: `archival`,
  `ingestIdempotency`, `distill`, `memoryHealth`, `ingest`.
- Added missing nested fields inside already-emitted blocks:
  `consolidation.contradictionDetection` (mode/minSimilarity/minConfidence/
  maxPerRun), `crossEncoder.model`, `security.redaction.customPatterns`.
- **Also found and fixed** `search.governance.maxComponentWeight` — dropped
  the same way, but missed by the FEAT's own evidence section; only
  surfaced by the AC-1 exhaustive round-trip test actually being exhaustive.
- Added minimal YAML flow-sequence (`["a","b"]`) support to both the emitter
  (`arrayLine` in writer.ts) and the parser (`parseScalar` in loader.ts) —
  needed for `customPatterns: string[]`, the first array-typed `Config`
  field; nothing else in `Config` is an array.
- Added `findMissingConfigKeys(cfg, emittedYaml)` (exported from writer.ts):
  a structural key-diff (top-level + one level of nesting for object-valued
  fields), with `sync` as the one documented, intentional exclusion (owned
  by `sync.json`, merged separately at boot — unrelated to this bug).
  `configToYaml` runs this on its own output and logs
  `logger.warn({ missingKeys }, 'configToYaml: emitted config is missing
  known Config keys')` when non-empty (AC-3) — a future unwired field now
  surfaces at write time instead of silently at next load.
- Defensive `?? EMIT_DEFAULTS.x` fallbacks on every new/changed block so an
  in-memory `Config` missing an optional sub-block at emit time (e.g. loaded
  from older code) emits the documented default instead of throwing (AC-4).
- Updated a stale test comment in `tests/config/loader.test.ts` that claimed
  "configToYaml doesn't emit the distill section yet" — no longer true.

**Out of scope (not touched, by design):**
- `sync` stays excluded from the emitter — writer.ts:122-123's existing
  comment (owned by `sync.json`) is correct and unchanged.
- No schema-driven emitter rewrite — PM triage explicitly scoped this to the
  minimal-patch approach; the stretch-goal rewrite was declined.
- `src/config/config.ts` (the `Config` type itself) — untouched, no new
  fields introduced.

## Deliverable / changed files
- `src/config/writer.ts` — missing blocks, nested fields, `arrayLine`,
  `findMissingConfigKeys`, `EMIT_DEFAULTS` fallback, AC-3 warning call.
- `src/config/loader.ts` — `parseScalar` flow-sequence (`[...]`) support.
- `tests/config/writer.test.ts` — `buildFullyPopulatedConfig()` fixture +
  new `describe('FEAT-461: configToYaml emit completeness')` block (11 new
  tests covering AC-1 through AC-5).
- `tests/config/loader.test.ts` — one comment fix, no behavior change.

## Test evidence
- `bunx tsc --noEmit` — exit 0, no output.
- `bun run build` — exit 0 (`tsc -p .` clean).
- `bun run typecheck:tests` — pre-existing, unrelated errors in
  `tests/{distill,doctor,e2e,entity,integration,providers,search,server,
  vector}` (not touched by this slice — confirmed via `grep -i "tests/config"`
  returning zero matches, i.e. this slice's test files typecheck clean under
  the stricter test tsconfig too). Not a regression introduced here.
- `bun vitest run tests/config` — **10 files / 97 tests passed, 0 failed.**
- `bun run test` (full suite) — **198 files / 2322 tests passed, 6 skipped,
  0 failed.**

## AC verification
- AC-1 (exhaustive round-trip): PASS. `buildFullyPopulatedConfig()` is a
  field-by-field literal (not `defaultConfig()` with mutations) with a
  non-default value in every field, including the five previously-missing
  blocks and `consolidation.contradictionDetection`. Round-trips through
  `writeConfig` → `loadConfigFromDisk` deep-equal, with two pre-existing,
  documented, orthogonal exclusions noted in the test comment: `sync`
  (never written to config.yaml) and `search.eta` (FEAT-428 fusion
  governance forces any eta > 0 back to 0 without recorded eval evidence —
  unrelated to emit completeness).
- AC-2 (regression guard, not a fixed field list): PASS. `findMissingConfigKeys`
  is a genuine structural diff, verified three ways: (a) returns `[]` for the
  current writer against a fully-populated Config, (b) catches a
  synthetic future top-level field the emitter doesn't know about, (c)
  catches a synthetic future field nested one level inside an
  otherwise-emitted block (`consolidation.futureNested`) — this is the exact
  shape of gap a "check only the four named fields" test would have missed,
  and the same shape as the real `archival` / `search.governance` gaps found
  during this slice.
- AC-3 (observability): PASS. `configToYaml` logs a structured
  `logger.warn({ missingKeys }, '...')` when the key-diff is non-empty;
  verified both that it fires (synthetic missing field) and that it does
  NOT fire for a fully-populated, fully-wired config (no false positives).
- AC-4 (defaulted-undefined sub-block): PASS. A `Config` with `archival`,
  `ingestIdempotency`, `distill`, `memoryHealth`, `ingest`, and
  `consolidation.contradictionDetection` all forced to `undefined` does not
  throw and emits each block's documented default value.
- AC-5 (no behavior change for existing valid configs): PASS. Spot-checked
  every pre-FEAT-461-covered block's literal output for a default `Config`
  (one assertion — `host: '127.0.0.1'` — corrected from the AC's presumed
  unquoted form to match `yamlScalar`'s pre-existing leading-digit quoting
  rule, not a behavior change). Confirmed `sync:` never appears as a
  top-level YAML key even for a fully-populated config.

## Confidence
High. All five ACs have direct test coverage, full suite is green, and the
one out-of-scope-but-real gap found (`search.governance.maxComponentWeight`)
was caught by the AC-1 test doing its job rather than slipping through —
which is exactly the failure mode PM triage's pre-mortem #1 warned about
("round-trip property test written too narrowly... passes green while still
missing one of the four fields").

## Risks / open questions
- None blocking. Two pre-existing, unrelated `typecheck:tests` gaps exist in
  other test files (see Test evidence) — not introduced by this slice, not
  fixed by this slice (out of scope).
- CHANGELOG git-history audit (mentioned in the original FEAT body, cut by
  PM triage's "what to cut if halved") was not done — matches the scoped-down
  AC list, which does not require it.

## Suggested next handoff
Reviewer (crew:reviewer) for correctness/regression review, then validator
if the loop's gate requires it for a behavior-changing config-emit fix
(`requires_validation: true` per the slice frontmatter). Parent loop drives
both dispatches.
