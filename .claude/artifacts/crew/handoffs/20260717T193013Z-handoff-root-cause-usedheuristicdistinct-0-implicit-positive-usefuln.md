# Task Handoff: Root cause: usedHeuristicDistinct=0 (implicit-positive usefulness pass)

- Created: 2026-07-17T19:30:13.299Z
- From: researcher
- To: dispatcher
- Objective: runImplicitPositivePass is correctly wired into the cleanup cadence but ships disabled-by-default, and a second eval-evidence governance gate would force it back off even if an operator flipped the config, so ADR-010's heuristic usefulness signal has structurally never fired.
- Allowed Scope:
  - Read-only investigation of src/storage/usefulness.ts (runImplicitPositivePass
  - usefulnessScores)
  - src/pipeline/handlers/cleanup.ts (caller)
  - src/config/config.ts (defaultConfig + applyFusionGovernance)
  - src/eval/eval-evidence.ts (RECORDED_EVAL_EVIDENCE table). No files edited.
- Forbidden Scope: -
- Deliverable: Findings doc below (inline in headline reply to dispatcher) classifying root cause as disabled-by-default-config with a compounding eval-evidence gate; minimal fix proposal; over-grant risk note; verification steps.
- Changed Files:
  - src/storage/usefulness.ts:199-285
  - src/pipeline/handlers/cleanup.ts:123-138
  - src/config/config.ts:239-263
  - 1196-1200
  - 1410-1470
  - src/eval/eval-evidence.ts:43-88
- Confidence: high
- Risks: Have not measured whether enabling implicitPositive would actually change ranking-visible usefulness in a way that improves LoCoMo/recall — that requires the ADR-005 harness run itself, which is the exact gap the governance gate exists to force. Also have not verified recall_served events in prod actually carry query_hash diversity >=2 per atom (policy.ts writer not fully traced) — worth a quick prod DB spot-check before assuming the threshold is reachable at scale.
- Suggested Next Handoff: If the team decides to unblock this signal: (1) run tests/eval/retrieval-eval.test.ts with search.usefulness.implicitPositive.enabled=true vs baseline, record a passing entry in src/eval/eval-evidence.ts's RECORDED_EVAL_EVIDENCE for component:'implicitPositive' if it clears RECALL_FLOOR/NDCG_FLOOR, then flip defaultConfig()'s enabled to true (or document it as an explicit config.yaml opt-in). Do NOT skip the eval-evidence step by hardcoding checkEvalEvidence or hand-editing the table without a real harness run — that reintroduces exactly the unvalidated-ranking-change risk ADR-005/FEAT-428 exists to prevent.

