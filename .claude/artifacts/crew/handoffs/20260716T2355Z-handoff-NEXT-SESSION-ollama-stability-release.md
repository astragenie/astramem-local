# NEXT-SESSION handoff 2026-07-16 ~23:55Z — Ollama/stability findings + morning priorities

Supersedes/augments 20260716T2340Z-handoff-OVERNIGHT-*. Read that too for the
full incident chain; this adds the Ollama findings + a clean priority list.

## LIVE STATE (as of handoff)

- **Prod**: standalone daemon (release bcb3080d = main + #397), :7777, healthy,
  codex extraction/compaction, ONNX embed, ASTRA_SKIP_CONSOLIDATE=1, scheduled
  tasks DISABLED (NO auto-restart). Recovery if it crashed:
  `cd C:/work/mega/astramemory-local-worktrees/wt-396 && ASTRA_ALLOW_PROD_DATADIR=1 ASTRA_SKIP_CONSOLIDATE=1 node dist/cli/index.js serve --port 7777`
- **LoCoMo**: overnight full-suite, qwen3:8b, run-dir
  `.eval-data/locomo/runs/overnight-qwen38b`, PID 221068, own daemon :64215,
  log %TEMP%/locomo-overnight.log. Resume if dead: re-run same cmd with the
  same --run-dir (FEAT-462). ~65 atoms / 3 sessions at handoff (early). Verdict
  vs 0.5549 codex baseline → decides the parked local-extraction flip.
- **GPU**: 5573/8151 MiB, qwen3:8b 100% GPU no spill, 83°C. Healthy after the
  orphan kill (below).

## OLLAMA FINDING (issue #399) — orphaned llama-server VRAM leak

A stale `llama-server` (pid 31436) from 08:09, parent Ollama (6384) DEAD, held
~2GB VRAM all day. qwen (5.7GB) + orphan (2GB) = 7.8/8.1GB ceiling → WDDM PCIe
paging → qwen SLOW. Killed it → 7818→5573 MiB, qwen full-GPU. The daemon churn
(#396/#397) caused the Ollama restarts that orphaned it.
- **Morning check**: `nvidia-smi` + `Get-Process llama-server`; any whose parent
  Ollama is dead = orphan, kill it. Filed #399 for a doctor check + reaper.

## STABILIZATION — the REAL open bug (bigger than #396/#397)

Deploying #397 did NOT let the managed service run clean: re-enabling both
scheduled tasks still produced TWO daemons (health none). #397's 30s grace only
helps when the 2nd launch SEES the 1st's lock; near-simultaneous launches
(keepalive PT5M + watchdog PT3M + reinstall's own start) both acquire before
either writes a healthy lock → 2 daemons → EADDRINUSE churn. instance-lock needs
a REAL exclusive acquire (O_EXCL/atomic lock at acquisition), not health-probe-
based zombie detection. This is why prod is on standalone. NEXT P0 — likely
folds into #398 (bind-port-early) OR a dedicated instance-lock-serialization fix.

## MORNING PRIORITIES (ordered)

1. **Read LoCoMo verdict** — judge the overnight run (`bun scripts/eval/locomo/judge.mts --hyp <run-dir>/hypotheses.jsonl --ref <run-dir>` once distill+answer done). vs 0.5549. Decides local-extraction flip.
2. **Orphan Ollama check** (#399) — nvidia-smi, reap any orphan llama-server.
3. **Fix cross-repo-roundtrip on main** — FAILS ON MAIN, blocks the whole merge queue incl #397. Root-cause (likely @astragenie scope/plugin-install flake or real contract drift). THIS unblocks the release.
4. **instance-lock serialization fix** (the 2-daemon bug above) — makes the managed service safe-unattended. Then re-enable tasks, verify no churn.
5. **Merge #397** (once #3 clears CI) + deploy properly via reinstall.
6. **#398** (bind-port-early + readiness gate) — durable boot fix.
7. **Backlog reconciliation** — close stale-done: FEAT-492, #284-profile, #235, #220 already shipped/closed; verify none else.
8. **v0.19.0 release** — after 3-5 land + a short tasks-on soak: bump + tag + publish + fresh-install smoke.
9. Parked/queued: FEAT-535 (Ingestions page, scoped), local-extraction flip (after distill-slowness: FEAT-534 hybrid + parallel pass B).

## TEMP states to unwind
shim clean (reinstall reset it); tasks DISABLED (re-enable after #4); ASTRA_SKIP_CONSOLIDATE=1 (env removed earlier + passed per-process — remove after stable); compaction+extraction on codex (flip local after distill-slowness track); pointer manually on bcb3080d (reinstall normalizes).

## Filed today: #396,#397,#398(boot),#399(ollama orphan),#389(port-free),#535(ingestions page). Merged: waves 1-3 + #392,#393,#394. Parked: local-extraction flip.
