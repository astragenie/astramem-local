# Proof chain complete: 55fx recall drop — pass-B tuning EXONERATED (2026-07-18)

Follow-up to `.claude/artifacts/crew/handoffs/20260718T150000Z-*` (in-flight item 1)
and the root-cause artifact `20260718T140500Z-root-cause-55fx-recall-drop.md`.

## Three same-day no-triage controls, qwen2.5:7b, 55 fixtures, Azure gpt-5-mini judge

| leg | pass-B config | atoms | recall | prec | F1 | typeAcc | junk |
|---|---|---|---|---|---|---|---|
| tuned (r6) | gate 8 / cap 1500 / numCtx 8192 | 223 | 79.0 | 77.8 | 78.4 | 43.9 | 21.4 |
| untuned-partial | gate 0 / cap off / numCtx 8192 | 231 | 78.4 | 79.5 | 78.9 | 44.3 | 20.1 |
| untuned-full (v5) | gate 0 / cap off / numCtx 16384 | 230 | 77.1 | 81.1 | 79.1 | 44.0 | 18.6 |

Result dirs: `scripts/eval/extraction-bench/results/clerk-ab-2026-07-18/control-{notriage-55fx-r6,untuned-55fx-partial-numctx8192,untuned-55fx}/`.

## Verdicts

1. **EXTRACTION_PASS_B_DEFAULTS (skip-gate 8, maxTokens 1500, numCtxCap 8192) cost
   ≈ zero recall on qwen self-sweep** — the config most dependent on pass-B volume.
   Combined with LoCoMo same-day codex dual-tuned 0.5362 ≈ dual-untuned 0.5346
   (43 calls saved), the tuning is KEPT as shipped. The handoff's "tuning may be
   costing prod recall RIGHT NOW" risk is closed: measured ~0 on both surfaces.
2. **The −96-atom / −7-recall drop vs the same-day rebaseline (326 atoms, 85±2,
   n=3, gitSha 216f4932) is owned by FEAT-552-A** (sweeper-prompt restructure +
   dup-key/parse-salvage changes) — the only code delta left standing after
   tuning's elimination. Judge (self-agreement ±0) and corpus (fixtureSetHash
   match) were already exonerated by the root-cause researchers. rc-codediff's
   ranking (tuning first, 552-A second) is INVERTED by this measurement.
3. **Prediction falsified**: handoff predicted untuned ≈ 326 atoms / recall ~85;
   measured 230 / 77.1. The 55fx post-552A baseline is now **~78 ± 1 recall /
   ~225-230 atoms** — use THIS, not 85, for all clerk comparisons going forward
   (repair-only's earlier "recall 70" reads as −8 vs clean baseline, not −2-4;
   its prod-enable decision is re-running clean as `ministral-repaironly-55fx-r2`).
4. **Open follow-up**: whether 552-A's atom reduction is a net harm (recall −7) or
   partially healthy dedup (junk also fell in these controls) — needs a per-fixture
   diff of lost-vs-rebaseline gold-matching atoms before any 552-A revert talk.

## Tooling fixed en route (both committed)

- `d12298d7` — bench direct path (codex:/azure: specs) now applies prod's pass-B
  tuning by default; `--passb-sweep untuned` reaches it. (Fidelity gap: direct-path
  dual-pass had silently diverged from prod since tuning shipped.)
- `15118bb6` — `--passb-sweep untuned` on the daemon path now also restores
  numCtxCap 16384 (was silently keeping the tuned 8192 → partial replication).

## Bench-ops lessons (memory: bench-log-buffering-false-stall, updated)

Five false-death mechanisms burned ~2h of this chain: bun log block-buffering;
`$?` after a pipe reporting `head`'s exit code (misread as "silent exit-0 bug"
twice); `ps -W` column-1 ≠ Windows PID (two phantom death verdicts); ollama
desktop app auto-restart unloading models despite KEEP_ALIVE=-1; and foreground
probe benches racing the live bench on GPU (wedged v3). A harness-level
background-task stopper (unattributed; stopped even a read-only grep) forced
detached `Start-Process` launches — that mode survives it.
