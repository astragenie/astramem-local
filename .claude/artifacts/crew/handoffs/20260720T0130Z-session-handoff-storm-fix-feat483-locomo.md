# Session handoff — 2026-07-19/20 (daemon storm fix, FEAT-483 wave, LoCoMo cross-review + overnight)

Long multi-thread session. This is the durable state for the next session.

## TL;DR — what shipped and what's pending
- **Merged to main:** adm-zip CVE + github-script v7 pin (#436), setup-node v7 (#439), named-speaker turn boundaries (#282), zombie-daemon grace-period (#397), proxy exchange-unit capture (#442), windowless daemon + reinstall-budget fix (#443), **embed-index cooperative-yield storm fix (#444)**.
- **Deferred to 0.21:** FTS revival (FEAT-480, PR #441 open, evidence in docs) — proven no clean fix.
- **Closed:** #440 (github-script→9, undid our pin), #156 (all-red stale).
- **PENDING on GitHub CI (was down/congested):** FEAT-483 7 slice PRs **#445-451** + LoCoMo v2 doc PR **#452**. All built + reviewed + self-verified; they auto-merge when GitHub's CI recovers. **First action next session: check if #445-452 merged; if stuck, re-run/merge.**

## Production daemon — STABILIZED (was in a restart storm)
- **Root cause found + fixed:** `embedAndIndex()` (`08-embed-index.ts`) processed a distill batch's atoms fully synchronously → event loop blocked 5–45s → `/health` timed out → watchdog false-killed a *working* daemon → restart storm. Fixed in **#444** (cooperative `setImmediate` yield every 25 atoms, mirroring `consolidate.ts` ADR-019; + `wal_checkpoint(PASSIVE)`).
- **Deployed:** daemon runs release **`0.19.0+d599c9a`** (later main `93c74f4`) via the windowless schtasks task, watchdog re-enabled. Event-loop max dropped 3600ms→~337ms. Healthy (uptime ~3h at handoff).
- **Windowless:** `AstraMemoryD` now launches via `wscript //nologo //B astramemd-hidden.vbs` (hidden). Confirmed no visible console. Applied via `reinstall` (its version-verify budget raised 30s→90s, env-configurable — was false-failing on this box's slow cold-start).
- **If it storms again:** the fix is deployed; if a NEW block appears, profile the event loop (the pattern: log-timestamp gaps → the op before each gap). Do NOT re-run image-name kills.

## Branches (local)
- `main` — synced to origin.
- `docs/locomo-v2-crossreview` — **PR #452**; carries the v2 plan, impl runbook, Zep-audit update, gitignore change, **C1 (`--multihop` harness override) + C2 (answerer `ASTRA_LOCOMO_ANSWER_EFFORT`/`_MAX_TOKENS` env knobs)**, and all overnight eval results.
- `feat/480-fts-or-join` — 0.21 FTS work (PR #441).
- `feat/483-s1..s7-*` — the 7 FEAT-483 slice branches (PRs #445-451).

## LoCoMo — corrected state + the re-scoped plan
- **Real numbers (were stale all session):** champion 0.6002 / service-day 0.5430 (conv-1, n=199); fresh overnight baseline **0.5112** (−6pt = day-variance live). Full-suite best 0.484 (n=1986). Per-category current: adversarial 0.81, temporal 0.68 (SOLVED, #262/#277), single-hop 0.49, multi-hop 0.36. **Run tracker: `docs/eval-runs/` (README + LEDGER, both scales).**
- **5-way cross-review (codex + 2 architect-reviewers + critical-thinking + perf-eng) → RE-SCOPE.** v1's single-hop "answerer/format" bet FALSIFIED. v2 doc: `docs/research/20260720-locomo-improvement-v2-post-crossreview.md`.
- **Overnight precision analysis (free) settled it:** single-hop is **51% recall-miss, 4% verbose** → RECALL/extraction problem, not answerer. multiHop A/B (0.5511) was CONFOUNDED (variance, not decompose). **Lever = extraction completeness + metric-match.**
- **Zep audit** (`docs/research/20260719-zep-locomo-947-audit.md`, updated 07-20): Zep 94.7% = LLM-judge cat 1-4 vs our token-F1 all-5 → metric mismatch, not a tool gap. Path = `--llm-judge` + multi-scope retrieval (on existing `entity_relations` + source turns) + extraction completeness. **No stack swap.**
- **Next LoCoMo steps (evidence-ranked):** P0 `--llm-judge` cat 1-4 (metric-match, biggest comparable jump; harness has it) · P0 oracle factorial · P1 extraction completeness (repair-only atom triage, disabled) · same-store multiHop + answerer A/Bs (C1/C2 wired) with ≥3 runs. Runbook: `docs/research/20260720-locomo-implementation-plan-and-overnight-runbook.md`.

## Repo conventions reinforced this session
- Eval run OUTPUTS now git-tracked (`.eval-data/**` minus `locomo10.json`, `sample.json`, `datadir/`) so numbers stop drifting stale. Raw CC-BY-NC dataset stays ignored.
- Every eval run → `archive-run.mts` → `docs/eval-runs/` + LEDGER row (see CLAUDE.md "LoCoMo / eval runs").
- Never trust single-run category deltas (±6pt day-variance); same-day controls + ≥3 runs mandatory.

## Open / watch
- GitHub CI recovery → merge #445-452.
- 0.20 release ceremony not yet cut (bump/tag/publish) — pending, needs explicit approval.
- Eval sandbox fires contradiction-judge 200 failing calls (FEAT-482 class) + a too-short 900s default distill timeout — worth disabling contradiction in the sandbox + raising the default.
