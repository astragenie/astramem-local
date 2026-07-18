# Session handoff — 2026-07-17/18: stabilize → model sweep → eval infra loop → phi-clerk program

owner: lead (orchestrator session, Claude Opus 4.8)
branch: chore/bench-onnx-embed (PR #435 open to main; all session commits on it)
confidence: high (every claim below is measured or committed; negative results recorded deliberately)

## Objective (as it evolved)
Stabilize repo + tests → ship v0.19.0 → find the best extraction config (models × compaction × chunking) → build the eval infrastructure to make such decisions repeatable → encode the findings as a triaged, wave-planned backlog.

## Shipped (merged to main)
- **v0.19.0 published to npm as latest** (PRs #430 soak→nightly CI de-flake, #410, #431 sync batch 50→25, #432 release; tag verified serving).
- **#433** extraction-bench uses ONNX embed matching prod (daemon boots ok in ~1.7s vs 90s degraded timeout).
- **#435 (open, auto-merge)**: eval levers (--compaction-mode, --max-chunk-chars, --atom-triage, LoCoMo --passb-*/--answerer), eval-sandbox ONNX cache, extraction maxTokens 2500→4000→6000, FEAT-542/543/544 deliverables, conv-liberal prompt, session artifacts.

## Loop completed (3/3, full ceremony each)
| FEAT | Deliverable | Commit |
|---|---|---|
| 543 | tests/eval/consolidation-eval.test.ts — 15 gold-operation fixtures, real runConsolidation both modes, weighted errors (false-merge=5), runtime-asserted cosines | 3de7fdd6 |
| 542 | 12 hard fixtures (negation/uncertainty/status/cross-chunk, 55 total), forbidden_items mechanical scoring, Evidence-acc column + additive digest-wire evidence field (src/server/queries/provenance.ts) | 3f08cf18 |
| 544 | gates.json quality tiers + noise-floor verdicts + calibration provenance stamp (provisional, 55-fixture) | 216f4932 |
All reviewed (1 approved, 2 approved_with_notes, zero CRITICAL/HIGH), validations recorded (skipped-with-reason vocab: pass|fail|skipped), graded (~0.85-0.89) with lessons.

## Measured results (the session's real product)
**LoCoMo (conv-1, k=15, conversational, no-compaction):**
- codex solo 0.5945 → **conv-liberal codex 0.6002 = STANDING CHAMPION** (`ASTRA_EXTRACT_PROMPT=conv-liberal`; +5% atoms, all clean — adversarial IMPROVED to 0.8723)
- NEGATIVE (recorded so they're not re-proposed): codex+phi passB −5.8 (junk crowding, adversarial −14.9) · phi self-triage recall 100→69 · phi answerer −11.9 (abstention collapse −40; but 199 QAs/53s local) · k=20 flat (k=15 stands)
**Extraction bench (5-fixture judged, no-compaction):** phi4-mini 88/83/85 junk14 typeAcc31 21s (best local balanced) · qwen2.5:7b 94/76/84 tA48 33s · qwen3.5:9b 100/64/78 tA88 60s (typing king) · NuExtract3 74 tA54 (needs native template) · gemma4:e4b 104s+timeout (DQ) · qwen3.5:4b 56 (dead regardless of chunk) · phi@2500 chars: recall→100, tA→48 (chunk-size lever real for phi)
**Laws derived:** (1) recall gains pay ONLY when they arrive clean — retrieval@k punishes junk harder than any judge; (2) local models are CLERKS not authors; (3) typing is capacity-bound; transcript compaction destroys typing cues (+13..29 tA without it).

## Backlog state (all PM deep-triaged, GWT ACs + Options-considered materialized)
- **551 evidence-gated sweeper P1 (build FIRST, composite 0.715)** — passB recall through FEAT-542's quote gate; est +2-4 LoCoMo; adversarial ≥0.87 guard
- **547 triage-v2 P1** (junk+type-repair+evidence in one batched call; phi-vs-qwen3.5:4b A/B — 4b typeAcc 67 favorite; upstream of 545/546)
- 548 gatekeeper P2 · 549 dup-judge P2 (scoreboard=543 eval) · 550 query-rewrite P2 (build last) · 546 anomaly detection P2 · 545 suggestions P2 **autonomous_safe=false** (operator needed; 5-slice decomposition in pm-review)
- Cloud: astragenie/memory#886 (10 memory product surfaces)

## NEXT SESSION DIRECTIVE (operator-approved)
Execute `.claude/artifacts/loop/plans/20260718T030000Z-plan-phi-clerk-waves-551-547-548-550-549.md`:
Wave 1 ∥×3 (551-distill / 550-search / 549-consolidate) → merge 551→550→549 → Wave 2 ∥×2 (547 rebased on 551's stage-8 / 548) → serial GPU measurement lane (549-eval is CPU, runs anytime). Merge gate = review PASS (all default-off); measurements = enablement evidence. ~5h wall.

## Open threads / risks
- **Rebaseline running** (task b6bs9dcey, --runs 3 × 2 qwens × 55 fixtures): definitizes 544's provisional gate floors + first mean±stdev on the expanded corpus. Check scratchpad/xbench-rebaseline/ on completion (~3-4h from 02:40Z).
- **Prod requeue misfire disclosed**: `queue requeue --poison` with a bogus --data-dir flag silently hit the PROD datadir (moved 2 old poisons→pending; harmless retries). CLI needs unknown-flag rejection — file as a small FEAT. Targeting is via ASTRA_MEMORY_DATADIR env only.
- **ASTRA_SKIP_CONSOLIDATE=1 lurks in shells** — false-fails all consolidate suites (memory: astra-skip-consolidate-breaks-local-tests). Unset in every builder/reviewer shell.
- Open PRs: #397 (boot-race — recommend close + minimal re-derive; review comment posted), #282 draft, #156 dependabot. Branch fix/extraction-decision-type (V3 typing prompt) parked unproven — 9b/capacity results reduced its priority.
- Review follow-ups carried in grades: 543 thresholds-as-literals (MEDIUM), 544 min+max short-circuit (MEDIUM) + ceiling-branch coverage (LOW), 542 evidence-optional-vs-nullable wording.
- extraction-bench README line 8 still claims qwen3.5:4b is production default — STALE (actual: codex; Ollama sub-default qwen2.5:7b); flagged, not yet fixed.
- ModernBERT-Large: rejected for extraction (encoder-only); strong v3 candidate for the type-repair seat IF 547 proves value (fine-tune needed, ~200× faster than phi; could ride the in-process ONNX stack). Cheaper cousin: per-type centroid classifier over existing embeddings.
- Model roster discipline: phi + qwen3.5:4b cover all clerk A/Bs; llama3.2:3b is the only justified next pull.

## Key memory entries written/updated this session
astra-skip-consolidate-breaks-local-tests · extraction-good-content-bad-type · extraction-model-ab-typing (the full sweep + LoCoMo series + laws)
