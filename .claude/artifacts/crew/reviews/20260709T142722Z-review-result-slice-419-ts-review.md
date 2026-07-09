---
findings: "🔴:0,🟡:2,❓:0"
status: completed
decision: approved_with_notes
---
# Review Result: Review Result

- Created: 2026-07-09T14:29:24.389Z
- Reviewer: typescript-reviewer
- Decision: approved_with_notes
- Status: completed
- Summary: Ingest-spool TypeScript stack is sound (Zod boundary discipline, atomic tmp+rename FS writes, per-file drain isolation, deepMerge-safe config addition); two non-blocking notes: deprecated zod .flatten() carried into new code, and writeToSpool/quarantineSpoolFile trust the key param for path construction with no defense-in-depth traversal guard.
- Evidence Checked:
  - MEDIUM src/ingest/spool-drain.ts:101 - CanonicalIngestSchema.safeParse(envelope).error.flatten() uses zod's deprecated (v4
  - package.json pins ^4.4.3) .flatten() API; mirrors the pre-existing pattern at src/server/routes/ingest.ts:455 so it is consistent with repo convention
  - not a regression
  - but both call sites should migrate to z.treeifyError()/.format() together in a follow-up rather than propagating the deprecated call into new code. || MEDIUM src/ingest/spool.ts:31
  - 79 - writeToSpool(dataDir
  - idempotencyKey
  - body) and quarantineSpoolFile build file paths via join(dir
  - `${key}.json`) with zero validation that key/file.key is a safe path segment (no '..'
  - no path separators). Current callers only ever pass a SHA-256 hex digest (claudeIdempotencyKey
  - codexIdempotencyKey) so there is no live exploit today
  - but the exported function itself has no defense-in-depth guard — a future caller passing attacker-influenced content could traverse out of ingest-spool/. Recommend a cheap /^[0-9a-f]{16
  - }$/ assertion (or basename()-strip) at the top of writeToSpool. || PASS: src/capture/claude.ts JSON.parse is per-line try/catch (malformed/partial lines skipped
  - never fatal per file header) with no 'any' escaping — parsed is validated as object/non-array before use
  - extractText narrows unknown content defensively. || PASS: src/ingest/spool.ts writes are tmp-file + renameSync in the SAME spoolDir (same volume
  - atomic) keyed by content hash
  - satisfying AC-2 idempotent overwrite semantics. || PASS: src/ingest/spool-drain.ts drainIngestSpool loop wraps every fallible step (readFileSync
  - JSON.parse
  - safeParse
  - ingestCanonicalTranscript) in its own try/catch per file — a single poison file cannot escape the tick or kill the worker loop; IdempotentReplayError/IdempotencyConflictError are proper Error subclasses checked via instanceof (not string-matched). || PASS: src/server/routes/ingest.ts ingestCanonicalTranscript extraction preserves the transactional claim/replay/conflict semantics 1:1 with the route's inline copy; wire_version regex is unchanged and correct. || PASS: src/cli/serve.ts spoolDrainTimer is cleared in shutdown() alongside the other interval timers and .unref()'d like its siblings; each tick calls drainIngestSpool synchronously to completion before returning so a slow tick cannot overlap the next. || PASS: src/config/config.ts ingest.spoolMaxBytes is typed
  - defaulted (32MB)
  - and survives src/config/loader.ts's generic deepMerge (only overrides keys actually present on disk
  - so an ingest-less config.yaml keeps the compiled-in default). || RESOLVED: drainIngestSpool import in src/cli/serve.ts:30 is used at line 328 (previously-flagged unused-import diagnostic no longer applies); tests/ingest/spool-drain.test.ts and tests/capture/codex.test.ts both use their imported mkdirSync — no dead imports found in the reviewed file set.
- Files Reviewed:
  - src/capture/claude.ts
  - src/ingest/spool.ts
  - src/ingest/spool-drain.ts
  - src/cli/capture.ts
  - src/cli/serve.ts
  - src/config/config.ts
  - src/config/loader.ts
  - src/server/routes/ingest.ts
  - tests/ingest/spool-drain.test.ts
- Test Adequacy: -
- Test Adequacy Skip Reason: TypeScript stack-quality review only (idiom/type-safety); test execution and coverage are crew:reviewer's/crew:validator's gate, not this fan-out reviewer's.
- Risks: -
- Required Follow-up: -

