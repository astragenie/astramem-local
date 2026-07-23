# Wave Program — Final Synthesis (2026-07-23)

**Objective:** run the operator-delegated multi-wave engineering program on `astramem-local` in the recommended order, deliver a summary, and cut a release.
**Owner:** team-lead (this session), with builder/reviewer subagents per track.
**Branch:** `feat/retrieval-overhaul` (PR #456 → main). **Release target:** `v0.21.0`.

## Strategic frame (the north star this program executed against)
Oracle-factorial proved **retrieval is capped** (retrieval −0.007; extraction −0.058; ~87% of the gap to Zep is the answerer/evidence-sufficiency layer). Five same-store retrieval A/Bs washed. So the program **stopped investing in retrieval ranking/fusion** and put the effort into extraction (Wave 5), the answerer/evidence layer (Wave 6), plus hygiene/reliability/measurement-trust scaffolding (Waves 3-4-7). Operator lifted the cheap-answerer-only constraint for milestone measurement (judge stays cheap unless separately approved).

## What shipped (all on feat, integration-green)

| Wave | Delivered | Merge |
|---|---|---|
| **1 Retrieval overhaul** | ONNX cross-encoder rerank (ships `enabled:false`), evidence-provenance + entity graph (additive schema), oracle-factorial harness, watchdog boot-grace | PR #456 base |
| **2 Quick-wins** | qw/* tracks (deps, misc) | merged pre-program |
| **3 Hygiene + reliability** | recall-perf indexes (migration 059, id-tiebreaker), memory_events rotation (new bug: grew on READ), 9 doctor checks tier-correct (+FULL-tier lock), codex-subscription retry, embed retryAfterMs, N+1 fixes (oversize scanner, entity-timeline), rerank-merge Map, CLI arg-parse, RunCapTracker (3 byte-identical sites), chunkedIn, governance-unify (17 fns, both loadConfig paths) | integrated + green |
| **4 Measurement trust** | `compare.mts` significance harness — paired-bootstrap CI (Koehn 2004), `--repeats≥3`, stronger-answerer presets opt-in | merged `0431d473` |
| **5 Extraction** | **conv-spkbal** prompt variant (dormant opt-in, per-speaker tally-and-rescan, hash-freeze green) + **oracle recompute** (fixed-answerer methodology fix). Date-grounding **DEFERRED** (see below). | conv-spkbal merged `f2382da9` |
| **6 Answerer + evidence** | **#6 multi-scope evidence bundling** — heuristic (zero LLM on hot path), same-session + same-entity pull via `chunkedIn`, bounded (`maxExtra`), bundled hits scored below all real hits, LOCAL-ONLY fields stripped from wire. **Dormant opt-in, flag-off byte-identical (proven).** | merged `a39080e0` |
| **7 Structural** | boot single-open regression guard (`serve-boot-single-open.test.ts`) — see null-result note | merged (boot guard) |

## Two honest null/deferred results (the measurement gates earning their keep)

1. **Date-grounding future-relative (Wave 5) — DEFERRED, not merged.** Code-reviewed PASS, 663 tests green, 0 fabrications on all 13 adversarial re-anchoring cases. But the **live** adversarial-determinism gate (real codex, temp already 0) came back RED: 3/5 genuinely-session-relative cases non-deterministic across identical runs, 2/5 collapsed week→day granularity. Load-bearing: the non-determinism hits a **past-tense** case too — so it's a **pre-existing property of the LLM-grounding architecture**, not the extension's bug. Near-zero LoCoMo upside (temporal already gains from extraction; future dates rare) → not worth shipping a non-deterministic widening. Branch `w5/extract-fix` @ `ce21b8a0` preserved as groundwork. Real fix = classify-with-LLM-but-compute-date-in-code redesign (new FEAT). Recorded in `docs/memory.md`.

2. **Boot double-DB-open (Wave 7) — NULL RESULT.** Full pre-bind trace found exactly ONE `openDb` (migrate takes an open handle; vec-worker/repos share it; FEAT-537/#420 already restructured boot to bind-before-migrate), and the boot-grace fix (`BOOT_HARD_CAP_SEC=1200s` + per-instance identity) is already LANDED. The "double-open crash-loop root" premise described a pre-#420 architecture. Corrected the `daemon-boot-crashloop` memory. Net deliverable: a regression-guard test locking the exactly-one-open invariant (`ebaa0a12`, reviewer proved it fails on an injected 2nd open).

## Deferred to a follow-up structural PR (convergence decision)
Wave-7 remainder: **yield-ledger** (1 recordStageOutcome vs 17+ guard-drop tables) + **config/provider-role registry**. Pure "compounding, not score" refactors — would bloat the release's review surface with regression risk and no user-facing value. Also cut earlier by the review campaign: performSearch unification (#1 wire-shape risk), big file-splits, EXTRACTION_STRICT activation.

## Score posture (important)
**This release changes NO default answer behavior** — every new score lever (conv-spkbal, #6 bundling, stronger answerer) ships **dormant/opt-in**. So the release needs **zero metered spend** and stays LEDGER-comparable at its default. Promoting any lever to default is a **separate operator-gated metered A/B** (batched, not piecemeal). No unmeasured "lever" was shipped as a default — the program's own "no single-run levers, Wave-4 significance required" rule held throughout.

## Release plan (v0.21.0)
1. feat full-suite green (validating now) → push → PR #456 CI re-runs.
2. Update PR #456 body (Wave-1 → full program).
3. **[operator-gated]** merge #456→main → bump 0.21.0 + CHANGELOG → tag `v0.21.0` → push. **The tag push auto-publishes to npm via CI — irreversible; needs explicit operator go.** FEAT-439 hook stays off through the main merge (main is a deploy branch).

## Post-release (operator-requested)
CoT-judge + stronger-answerer ceiling read on a stratified 10% sample. Viable as a ceiling snapshot (not lever-attribution — answerer+judge both change; ~400 gpt-5.4 calls/arm). Recommended: 2-arm (released-default vs bundling-ON), single-pass directional first, ≥3-repeat confirm on a promising arm.

## Operating discipline held throughout
FEAT-439 hook off through all merges · no prod touch · no process killed by image name · no git stash in worktrees · every retrieval/extraction touch gated by ADR-005 floors + CONTRACT-FREEZE + hash-freeze · durable write-backs (docs/memory.md corrections for date-grounding + boot crash-loop; wave-program status log).
