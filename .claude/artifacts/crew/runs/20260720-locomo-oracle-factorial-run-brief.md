# Run Brief: LoCoMo oracle-factorial harness

- Created: 2026-07-20
- Owner: lead (orchestrator) + 1 trunk builder + 3 parallel worktree builders
- Branch: `feat/locomo-oracle-factorial` (local commits only; never main, never push)
- Commit policy: dev.stable=true → builders auto-commit after self-verify; review gate before merge.

## Objective
Build the oracle-factorial diagnostic: answer every LoCoMo cat1–4 question from 4 evidence
sources × 2 answerers = 8 cells, judge each cell identically, aggregate into a per-stage
attribution table. Settles WHERE the LoCoMo gap lives (extraction / retrieval / sufficiency /
answering / scoring) before any Phase-2 build. Spec: `docs/research/20260720-locomo-improvement-v2-post-crossreview.md` §Phase 1.

## The seam (verified)
`answerConversations` (scripts/eval/locomo/answer.mts) varies exactly one thing per cell:
what produces `hits` before `buildAnswerPrompt(question, hits)`, and which answerer consumes them.
Two contracts capture the whole factorial:
- `EvidenceSource.hitsFor(qa, sampleId, ctx) => SearchHit[]`  (4 impls)
- `Answerer.answer(question, hits, ctx) => string`           (2 impls)

## Decomposition (no two agents share a file)
- **T0 trunk (serial, blocking):** `oracle/harness.mts` + `oracle/oracle-factorial.mts` — freezes
  both contracts, glob-discovers `sources/*.mts` + `answerers/*.mts` (NO central registry to edit),
  8-cell driver, judge wiring (reuse scoreRun + runLlmJudge), aggregator → factorial table,
  artifact + LEDGER row. Mounts a store daemon (reuse shared/spawn-daemon.ts) when any source needs one.
- **W-A (parallel):** `sources/gold-turns.mts` + `answerers/canonical.mts`  — Tier A go/no-go gate.
- **W-B (parallel):** `sources/gold-atoms.mts`  — scoped distill over gold turns.
- **W-C (parallel):** `sources/retrieved-atoms.mts` + `sources/retrieved-spans.mts`.

## Reuse (do not rebuild)
- Store already on disk: `.eval-data/locomo/runs/20260720-baseline-v2/datadir/` — respawn a daemon
  on it (spawn-daemon.ts resume path), do NOT re-ingest.
- current-answerer = `azureChatComplete` (answer.mts). Judge = judge/metrics.mts. Azure = resolveAzureConfig.
- Dataset gold turns: qa.evidence[] (e.g. `["D1:3"]`) → conversation[`session_N`][].dia_id → text.

## Gates
- review each slice (crew:reviewer) before merge; validate T0 (harness runs a --cells smoke) before wave.
- merge order: T0 first; W-A/W-B/W-C disjoint files → clean merge any order.
- Phase 3: run full 8-cell factorial → factorial table artifact + one LEDGER row (archive-run pattern).
