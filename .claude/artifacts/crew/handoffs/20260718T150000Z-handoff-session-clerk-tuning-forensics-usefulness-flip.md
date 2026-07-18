# Handoff — 2026-07-18 session: ministral clerk, eval forensics, usefulness flip

owner: lead (this session) → next session
branch: `chore/bench-onnx-embed`, tip ~8e12dc94+ (all pushed). Worktrees clean; wave-552 worktrees pruned.

## Objective (what this session was doing)

Measure ministral-3:8b as a clerk, chase a LoCoMo/bench "performance degradation" to
root cause, and ship the deterministic-quality backlog. All three landed; two runs
still in flight at handoff time.

## IN FLIGHT — check these FIRST

1. **55fx proof chain (bash task, r6)**: tuned no-triage control → untuned
   (`--passb-sweep untuned`) control, qwen2.5:7b, results land in
   `scripts/eval/extraction-bench/results/clerk-ab-2026-07-18/control-notriage-55fx-r6/`
   and `.../control-untuned-55fx/`. Purpose: split the measured −105-atom recall drop
   between pass-B tuning (skip-gate 8 + cap 1500, commit 4ec1fabe) and the 552-A
   sweeper-prompt restructure. Prediction: untuned ≈ 326 atoms / recall ~85 → tuning
   owns it. **CAUTION: logs are block-buffered and look frozen — verify via the
   spawned daemon's /health (see memory: bench-log-buffering-false-stall). Do NOT
   kill on log silence** (this session killed 2 healthy runs that way).
   After results: decision (operator) on EXTRACTION_PASS_B_DEFAULTS — raise
   threshold/cap, scope tuning to clerk configs only, or keep (LoCoMo showed same
   score with 43 fewer calls; the engineering bench prices the recall cost).
2. **Morning codex re-probe** (~5 min, cloud): rerun the 3-probe yield check
   (pattern in scratchpad/codex-probe-evening-20260718.json; session_1 chunk at
   scratchpad/probe-chunk.txt; evening baseline mean 10 atoms/call, champion-era ~13).
   Yield recovered → quota shaping (0.60 recoverable in morning windows); still ~10 →
   backend drift (0.6002 = frozen high-water mark forever). Update
   memory extraction-model-ab-typing + docs/eval-runs/LEDGER.md.

## Shipped today (all committed + pushed, reviews where required)

- **FEAT-552 wave merged** (A parse-salvage/dup-key/sweeper-prompt · B type-hints
  default-ON + backfill-types CLI · C command merge-guard + fuzzy evidence tier),
  1359 tests, FEAT → done. Corrected prod dry-run census: 50,091 scanned, 419
  would-change. **`backfill-types --apply` on prod = still awaiting operator.**
- **atomTriage 'repair-only' mode** (corrected_type without discard authority) —
  built, tested, `--atom-triage repair-only` bench lever. 55fx: typeAcc 55 (vs
  baseline 43), recall 70 vs same-day triaged 68 — discard verdict costs only ~2-4
  pts (earlier −17 claim was tuning-confounded). Enable decision after proof chain.
- **Pass-B clerk tuning, centrally configured** (EXTRACTION_PASS_B_DEFAULTS +
  resolveExtractionPassBTuning in config.ts — change numbers in ONE place):
  sweepOnlyBelowAtoms 8, maxTokens 1500, numCtxCap 8192. Measured on ministral,
  **recall cost on qwen self-sweep being priced by the proof chain** — may need
  revision after.
- **Implicit-positive usefulness ENABLED** (issue #190): evidence entry in
  RECORDED_EVAL_EVIDENCE, gate stays armed, reviewed (needs_fix → fixed → approved,
  artifact 20260718T144202Z). Prod effect starts at next reinstall's first cleanup
  tick.
- **Eval traceability**: LoCoMo run-manifest now records passes/compaction/passB/
  prompt-env/tuning/gitState; sandbox-config.yaml persisted per shard; `--passb-sweep
  untuned` replication flag (LoCoMo + extraction-bench); `docs/eval-runs/` registry +
  LEDGER + archive-run.mts — **archive every future LoCoMo run + commit** (operator
  directive).
- **Sabotage response**: uncommitted working-tree flip (extractionPasses 2→1 +
  3 test files rewritten to lock it) found, reverted, drift-canary restored with
  incident note; `materializeRelease` now warns on dirty src/. Author unknown —
  suspect sibling-session agent. Prod release verified clean.
- **Root-cause artifact**: 20260718T140500Z-root-cause-55fx-recall-drop.md (3
  researchers: atom forensics / code diff / judge check — judge+corpus exonerated by
  fixtureSetHash + lockstep atom counts).

## Measured verdicts (today, provenance-backed)

- LoCoMo same-day board (conv-1, k15): single codex 0.5502 · dual tuned 0.5362 ·
  dual untuned (champion recipe) 0.5346/448 atoms · +ministral gated sweeper 0.5143.
  **Champion 0.6002 NOT reproducible same-recipe → codex service day-variance
  proven.** Same-day controls now law.
- Ministral seats: sweeper NO-ENABLE (best sweeper tried, still net-neg) · keep/junk
  NO-ENABLE (softened: −47 junk-skewed atoms) · **repair-only = the live candidate**.
- Champion "codex solo" runs were secretly dual-pass codex+codex (default 2 since
  07-15; harness never pinned it) — memory + ledger corrected.

## Next queue (beyond the two in-flight)

1. Proof-chain results → tuning decision + possibly repair-only prod enable
   (config: atomTriage {mode: repair-only, provider: ollama, model: ministral-3:8b};
   numCtxCap already defaults 8192 for clerk instances).
2. Prod `backfill-types --apply` (operator sign-off) — 419 atoms.
3. PR `chore/bench-onnx-embed` → main (large, load-bearing; auto-merge arms on PR —
   hold label if gating wanted). Version bump consideration.
4. 549 dup-judge real-LLM eval with ministral as judge candidate (552-C command
   guard now protects the failure mode) · 550 --diagnose A/B.
5. FEAT-545/546 (ranking/confidence design → build).
6. Known env issues: system TEMP degraded (enumeration times out — consider cleanup);
   foreign long-running `bun test` from sibling session (don't kill, not ours).

## Risks / open questions

- Pass-B tuning may be costing prod recall RIGHT NOW if any local dual-pass configs
  run (prod default extraction = codex dual-pass; tuning applies to its self-sweep
  too — same mechanism as the bench. Codex sweep output is terse so cap 1500 likely
  harmless there, but skip-gate 8 does skip; unmeasured on codex. The proof chain +
  a codex-leg check would settle).
- Saboteur identity unknown; the guard only WARNS. If it recurs, escalate to a
  hard-fail flag or pre-commit hook.
- gates.json floors still provisional for the 55fx corpus (rc-judge's valid point) —
  definitize after the proof-chain rebaseline lands.

Confidence: high on everything committed (tests + review gates); medium on tuning
defaults pending the proof chain.
