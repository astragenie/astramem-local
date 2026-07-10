# FEAT-455 Security Spike — Review

**Reviewer run:** commit `9594233` on `feat/feat-455-security-spike`
**Worktree:** `C:\work\mega\astramemory-local-worktrees\feat-455-spike`
**Decision: PASS**

## Diff shape claim — verified

`git diff --stat origin/main...HEAD`: 4 files changed, 946 insertions(+), **0 modified,
0 deleted**. Confirmed additive-only — no existing product code touched.

- `docs/specs/FEAT-455-spike-results.md` (new)
- `tests/security/redact-autocapture.test.ts` (new)
- `tests/capture/claude-tool-arg-exclusion.test.ts` (new)
- `tests/storage/auto-capture-purge.test.ts` (new)

## 1. Do the tests exercise real behavior?

Yes on all three files — no tautology, no self-mocking.

- `redact-autocapture.test.ts` imports and calls the real `redactText` from
  `src/redact/index.js`. No mocks.
- `claude-tool-arg-exclusion.test.ts` imports and calls the real
  `parseClaudeTranscript` from `src/capture/claude.js` against realistic
  Claude Code transcript JSONL fixtures. No mocks.
- `auto-capture-purge.test.ts` uses a real in-memory SQLite DB (`openDb(':memory:')`
  + `migrate(db)`) and the real `MemoryRepo`/`MemoryEventRepo` — no mocked
  storage layer. It's honest that `capture_source` doesn't exist yet and uses
  `evidence` as a documented stand-in marker (called out in both the file
  header and the spec doc, not hidden).

### Spot-check: Finding 2 (`INTERNAL_SECRET=abc123` passes unredacted)

Independently recomputed Shannon entropy: `INTERNAL_SECRET=abc123` = **3.9706
bits/char**, matching the doc's claimed 3.97 exactly. Confirmed against real
`shannonEntropy()` semantics in `src/redact/entropy.ts` (`MIN_TOKEN_LENGTH = 20`).
Confirmed the `generic_credential` detector regex
(`src/redact/detectors.ts:76-80`): `\b(?:api[_-]?key|secret|token|password|passwd|pwd)\s*[:=]\s*(\S+)`
— the leading `\b` cannot match between `_` and `S` (both word characters in
JS regex), so `INTERNAL_SECRET=` never matches the labeled detector. Both the
label-miss mechanism and the entropy-just-under-threshold value are real,
demonstrated properties of shipped code, not asserted-away. The test
(`redact-autocapture.test.ts:156-164`) asserts `events.length === 0` and
`text === line` — an honest gap, not a workaround.

### Spot-check: Finding 4 (`restore()` throws `MemoryConflictError` on invalidated-not-archived rows)

Confirmed against `src/storage/memory-events.ts:311-318`: `restore()`'s
precondition is exactly `row.archived !== 1` → throw
`MemoryConflictError('memory ${atomId} is not archived')`. `invalidate()`
(line 162+) never sets `archived`, so calling `restore()` after `invalidate()`
throws by construction. Test (`auto-capture-purge.test.ts:158-168`) asserts
the exact throw. Real gap, honestly surfaced as a build-slice follow-up, not
fixed or hidden in this spike.

Both flagged findings are demonstrated by tests against real, already-shipped
code — not asserted into passing.

## 2. Spec doc — concrete enough to build from?

Yes. The relevance-gate taxonomy (checklist #2) gives a concrete module
signature, default values (`minChars: 8`, `maxBytes: 65536`, `dedupWindow: 20`),
and an explicit non-overlap boundary with `durability-gate.ts`'s 5 reasons —
sufficient for a builder to implement without further design work. The
provenance section (checklist #4) gives an exact `ALTER TABLE` + partial index,
states the `NULL`-default byte-identical-to-today guarantee, and explains why
`evidence` is not reused (collision with distill-populated citations) —
concrete and defensible.

**Doctor WARN row deviation (checklist #6):** reasoning is sound. Verified
`checkServicePointer` (`src/doctor/checks.ts:798-843`) does return `ok: false`
for dev-pinning, and that dev-pinning is an always-unintended footgun (FEAT-438),
which is a materially different situation from a user-disclosed opt-in feature
being on. The doc doesn't silently deviate — it names the deviation explicitly,
gives the reasoning, and flags it as a judgment call for product/UX to confirm
at build time. That's the right way to handle a deviation from an instruction.

## 3. Build + tests

- `bun run build` — clean, no errors.
- New test files: `npx vitest run` on the 3 target files — **20/20 passed**,
  matching the doc's claim exactly.
- Full suite: `npx vitest run` — **186 test files passed, 2135 passed / 6
  skipped, 0 failed** (doc claims 2134/6/0 — trivial one-test discrepancy,
  no failures either way, not a concern).

## Notes (non-blocking)

- The doc is unusually thorough about citing line numbers for every claim;
  every citation I checked (entropy.ts, detectors.ts, claude.ts extractText,
  memory-events.ts restore/invalidate, doctor/checks.ts) matched the actual
  source exactly.
- Checklist #9 (human security/privacy sign-off) is correctly left PENDING —
  not something a spike or automated review can close.

## Verdict

**PASS.** Additive-only diff confirmed. All three test files exercise real
production code with no mocking-into-tautology. The two headline findings
(entropy threshold miss, invalidate/restore asymmetry) are independently
verified against source, not just asserted. Spec sections are concrete enough
to hand to a builder. Recommend proceeding to open the FEAT-455 build slice(s)
per the doc's own GO/NO-GO conditions (security sign-off on ADR-012, provenance
+ config landing before the doctor row, gaps carried forward as tracked
follow-ups).
