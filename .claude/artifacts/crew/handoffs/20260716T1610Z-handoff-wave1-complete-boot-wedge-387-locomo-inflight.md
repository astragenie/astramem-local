# Handoff — wave 1 complete; prod on temp manual daemon (#387); LoCoMo in flight

- **objective**: continue the approved 3-wave plan (`.claude/artifacts/loop/plans/20260716-wave-plan-local-llm-quality-and-reliability.md`) + resolve #387 + act on tonight's measurements
- **owner**: next session lead
- **confidence**: high on facts below (all verified live this session)

## Prod state (IMPORTANT — temporary!)

- Daemon = **manually spawned foreground process** (`serve --port 7777`, spawned from wt-deploy with `ASTRA_SKIP_CONSOLIDATE=1`), healthy, serving **latest main** (schema 51, wave-1 code). NOT the managed service.
- **#387**: any boot WITHOUT `ASTRA_SKIP_CONSOLIDATE=1` wedges on boot-time consolidation (post-interrupted-knn DB state). The schtasks keepalive/watchdog will spawn wedging daemons via the shim (no env var). The wave-1 watchdog re-arm (merged, NOT yet deployed via a successful reinstall — the gate rolled back) makes this worse once deployed: watchdog will kill+respawn wedged boots in a loop. **Fix #387 before the next reinstall.**
- Config: compaction TEMP on codex (comment in config.yaml says why + flip-back condition), extraction codex, judge dry-run ollama/qwen3:8b, candidateSelection full, contradiction dry-run. `ASTRA_SKIP_CONSOLIDATE` was REMOVED from user env this morning (re-add deliberately only if needed — see #387 mitigation note).

## Wave plan status

- Wave 1: ALL MERGED — #376+#381 (FEAT-534 hybrid extraction), #377+#380+#383 (#372 ops), #378+#382 (#352B theta+marker+index), #379+#384 (#370 watchdog re-arm, operator-approved).
- **Wave-1 exit gate INCOMPLETE**: reinstall health-gate rolled back (#387). Gate = suite green (done via CI) + reinstall + doctor green — blocked on #387.
- Wave 2 (FEAT-533 triage dry-run, #341 local half) — NOT dispatched, waits on gate.
- Wave 3 (FEAT-492, #284, bench validation batch) — behind wave 2 + GPU.
- E3/E4 (#385/#386, filed by the sibling session) — coordinate ownership; same distill files as FEAT-533.
- Process rules learned: repo auto-merge is OPT-OUT (`hold` label or draft — memory: automerge-optout-hold-label); reviews must complete BEFORE auto-merge arms.

## In flight

- **LoCoMo run 3**: wt-jsonschema, `runs/2026-07-16T15-21-49-492Z`, 6h distill budget, extraction=ollama/qwen3:8b conversational dual-pass, k=10, seed 42. Verdict vs 0.5549 codex baseline decides extraction→local flip. Log: `$TEMP/locomo-qwen38b-r3.log`. Judge cmd printed at end of log when done (`judge.mts --hyp ... --ref ...`).
- Judge dry-run verdicts: accumulate per consolidation run — BUT consolidation is skipped on the temp daemon; resume after #387.

## Decision queue for the operator

1. #387 fix approach (root-cause vs cursor-clear stopgap).
2. LoCoMo verdict → extraction→local + extractionPasses→2 + compaction back to local (one coherent flip, measured).
3. Judge dry-run review → mode enabled.
4. FEAT-533 dry-run agreement → triage enabled.

## Key artifacts

- Plan: `.claude/artifacts/loop/plans/20260716-wave-plan-...md` (has merge-policy + gate rules)
- Bench: `wt-jsonschema/scripts/eval/extraction-bench/results/qwen3x-schema-20260716/` + `codex-gpt54mini-20260716/`
- Issues filed today: #370(fixed) #371 #372(shipped) #374/#385/#386(E-track) #387(OPEN blocker)
- Memories written: onnx-offline-load, qwen35-dup-key-collapse-schema-fix, automerge-optout-hold-label
