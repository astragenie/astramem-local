---
type: validation
created: 2026-07-13T14:25:00Z
slice: SLICE-430
feature: FEAT-481
result: PASS
validator: lead (evidence from builder doctor demos + reviewer worktree runs)
---

# Validation — SLICE-430: entity-relations doctor canary, guard-drop counter, fixtures, docs

## Behavior evidence

- **Doctor canary, all 6 reachable states demonstrated** (throwaway datadirs; real
  store and port 7777 never touched):
  - no DB yet (informational) — via the real full CLI `node dist/cli/index.js doctor`
  - below activity threshold: "0 rows — not enough distill activity yet (3 memories
    in last 7d, below the 20 floor)"
  - WARN, model emits nothing: "relations extraction is wired but has never produced
    a row" (25 memories, 0 rows, 0 guard-drop events → the model is not emitting)
  - WARN, guard drops everything: same row, 6 guard-drop events → "the model IS
    emitting relations and the guard is dropping every one"
  - OK: "1 row(s) total (1 in last 7d, newest 0.0h old)"
  - conversational profile with the same activity → informational (relations[]
    guidance is engineering-prompt-only per SLICE-435)
  This is the "built, wired, never invoked" canary the class demands: it proves rows
  EXIST in a live store, not that code compiles.
- **Diagnostic-never-kills-pipeline (review MEDIUM, fixed + proven)**: both
  recordRelationGuardDrops call sites now have their own try/catch (the pipeline.ts
  call was also moved OUT of the stage-5 try block so it can never be reinterpreted
  as an extract failure). Two regression tests make the write genuinely throw by
  DROPPING the table (not a stub): distill still completes, atoms + valid relations
  still persist, swallowed warning captured.
- **Migration 029 + SCHEMA_VERSION 28→29**: reviewer verified the persistent table is
  necessary (doctor runs in a separate process from the daemon — an in-memory counter
  would be invisible to it), mirrors redaction_log (migration 005) field-for-field,
  and that the version bump is mechanically enforced by migrate.test.ts's drift guard,
  not a discretionary choice. Fresh-DB and upgrade-from-28-with-real-data paths both
  exercised (upgrade-path.test.ts runs the real v12 fixture → asserts v29). All 8
  mechanical 28→29 test edits confirmed genuine schema assertions, hunk by hunk.
- **Docs**: README 20-tool MCP surface + "29 migrations" verified against the manifest
  and migrations/ on disk; CLAUDE.md entity-relations section added.
- Suites: worktree tsc clean; full run 248 files / 3015 pass / 6 pre-existing skips
  (reviewer independently reproduced the pre-fix 3013 figure).

## Reviews

- review-430: NEEDS_FIX → 1 MEDIUM (diagnostic write could fail a distill job);
  migration/schema-bump scrutiny cleared. Fix applied and proven; all other findings PASS.
  Artifact: .claude/artifacts/crew/reviews/20260713T141500Z-review-slice430-canary.md

## Known pre-existing issues (not introduced here)

- openProductionDbReadonly / getOrCreateKey(defaultConfigDir()) reads the real OS
  credential store even under ASTRA_MEMORY_ISOLATED=1 — limits full-CLI doctor demos
  of encrypted-DB paths. Follow-up candidate (relates to the keystore-scoping FEAT).
