---
findings: "🔴:0,🟡:2,❓:1"
status: completed
decision: approved_with_notes
---
# Review Result: Review Result

- Created: 2026-07-09T10:36:15.981Z
- Reviewer: reviewer
- Decision: approved_with_notes
- Status: completed
- Summary: SLICE-419/FEAT-441 durability gate: AC-1/2/3/5/6/7/8 verified PASS with independent test runs; AC-4/9 partial (gatedOutCount reaches logs but not the SessionDigest artifact); one HIGH classifier false-positive risk found and empirically confirmed, fix is isolated to durability-gate.ts and non-blocking since default ships off.
- Evidence Checked:
  - Build: bun run build exit 0. Targeted run: bunx vitest run tests/distill/durability-gate.test.ts tests/distill/08-embed-index.test.ts tests/eval/durability-gate-eval.test.ts tests/server/search.test.ts -> 4 files / 74 tests passed. Also ran tests/eval/retrieval-eval.test.ts + tests/doctor/** -> 10 files / 79 tests passed
  - no regression. AC-2 default confirmed: src/config/config.ts defaultConfig() sets distill.durabilityGate:'off'; gateDurability() short-circuits before calling classifyDurability when mode==='off' (durability-gate.ts:122). AC-5 confirmed by reading src/server/routes/search.ts /remember handler (no import of durability-gate.ts) plus new search.test.ts integration test posting all 5 AC-1 patterns with strict mode configured
  - all persisting with {id
  - ok:true}. AC-6 confirmed via repo-wide grep: 'ephemeral_state|git_derivable|vacuous_negative|bare_todo|path_fragment|GatedReason' matches only src/distill/durability-gate.ts. AC-7 confirmed by reading 08-embed-index.ts:117-129 (redactIfEnabled applied before childLogger.warn) plus dedicated secret-redaction test. AC-8 confirmed: checkDurabilityGateMode (checks.ts) always returns ok:true across off/lenient/strict. AC-4 gap: grepped for gatedOutCount usage repo-wide - only appears in pipeline.ts (pipLog.info + PipelineResult return value) and the two console.log job-summary lines in distill.ts/distill-events.ts; the actual digest artifact in this codebase (buildSessionDigest() in src/server/queries/provenance.ts
  - served at GET /sessions/:id/digest and the MCP session_digest tool) was not touched and has no gated_out_count field
  - even though it already has a precedent additive field (poison_jobs) that gatedOutCount could have mirrored. No scopeNotes call-out for this deferral was found in the run brief or slice plan artifacts. HIGH false-positive finding empirically reproduced: ran classifyDurability() from the built dist output against 5 realistic long/rationale-bearing atoms (postmortem root-cause notes
  - an ADR-style decision
  - an operational runbook note) - all 5 were misclassified as ephemeral_state/git_derivable/vacuous_negative purely because EPHEMERAL_STATE_RE
  - GIT_SHA_WITH_KEYWORD_RE
  - GIT_ACTIVITY_RE
  - and VACUOUS_NEGATIVE_RE are unanchored substring regexes with no rationale-marker exemption or length/dominance guard
  - unlike bare_todo (has RATIONALE_MARKER_RE exemption + BARE_TODO_MAX_WORDS cap) and path_fragment (fully ^...$ anchored). Example: 'Root cause: the bug was introduced in commit a589551 which swapped embed models without updating dim validation - always add a preflight check for dim mismatches when swapping models.' classified as git_derivable despite being a durable
  - actionable postmortem lesson.
- Files Reviewed:
  - src/distill/durability-gate.ts (NEW)
  - src/distill/stages/08-embed-index.ts
  - src/config/config.ts
  - src/distill/pipeline.ts
  - src/pipeline/handlers/distill.ts
  - src/pipeline/handlers/distill-events.ts
  - src/doctor/checks.ts
  - src/cli/doctor.ts
  - tests/distill/durability-gate.test.ts (NEW)
  - tests/distill/08-embed-index.test.ts
  - tests/eval/durability-gate-eval.test.ts (NEW)
  - tests/server/search.test.ts
  - contracts/fixtures/eval/corpus-junk-pollution.json (NEW)
  - contracts/fixtures/eval/queries-junk-pollution.json (NEW)
- Test Adequacy: 74 slice-scoped tests (durability-gate.test.ts, 08-embed-index.test.ts, durability-gate-eval.test.ts, search.test.ts) pass; 79 additional ADR-005 eval + doctor tests pass with no regression; AC-1/2/3/5/6/7/8 each have direct, independently-verified test coverage; the new checks.ts::checkDurabilityGateMode has no dedicated doctor-check test file (breaks this repo's per-check test-file convention).
- Risks: HIGH: classifier false-positive risk on rationale-bearing durable atoms (ephemeral_state/git_derivable/vacuous_negative are unanchored substring matches) - inert today because AC-2's default 'off' ships byte-identical, but will silently and permanently gate legitimate atoms (no rollback - rejected candidates are log-line-only) the moment strict/lenient is ever recommended or defaulted-on, which the FEAT body explicitly anticipates ('re-triage may choose default-on'). MEDIUM: AC-4's 'digest/summary artifact' requirement is only half-met (structured/console logs yes, the actual SessionDigest/GET /sessions/:id/digest artifact no) with no scopeNotes call-out, so AC-9's 'all 5 capabilities, none silently deferred' is not fully met either. LOW: checkDurabilityGateMode has no dedicated unit test.
- Required Follow-up: Before promoting distill.durabilityGate beyond 'off' in any environment: add a RATIONALE_MARKER_RE exemption (and/or a length/dominance guard mirroring BARE_TODO_MAX_WORDS) to EPHEMERAL_STATE_RE, GIT_SHA_WITH_KEYWORD_RE/GIT_ACTIVITY_RE, and VACUOUS_NEGATIVE_RE in src/distill/durability-gate.ts so a rich, rationale-bearing atom containing an incidental trigger phrase is not gated. Separately (can be a fast follow, but should be tracked, not silently dropped): surface gatedOutCount in buildSessionDigest()/SessionDigest (src/server/queries/provenance.ts) mirroring the existing poison_jobs additive-field pattern, and add tests/doctor/durability-gate-check.test.ts for checkDurabilityGateMode.

