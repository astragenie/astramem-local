# OVERNIGHT handoff 2026-07-16 ~23:40Z — prod standalone (healthy), LoCoMo running, release blocked

## PROD — healthy but MANUAL (no auto-restart)

- Running: STANDALONE daemon, `serve --port 7777`, from wt-396's dist (release
  bcb3080d = latest main + #397 boot-race fix), `ASTRA_SKIP_CONSOLIDATE=1`.
  Healthy 5/5, atoms flowing (~156/30min earlier), codex extraction/compaction,
  ONNX embed, consolidation OFF.
- **Scheduled tasks DISABLED** (AstraMemoryD + AstraMemoryDWatchdog). So NO
  auto-restart. If the daemon crashes overnight it stays down until:
  RECOVERY: `cd C:/work/mega/astramemory-local-worktrees/wt-396 && ASTRA_ALLOW_PROD_DATADIR=1 ASTRA_SKIP_CONSOLIDATE=1 node dist/cli/index.js serve --port 7777` (or via nohup).
- Why standalone not managed: even WITH #397 deployed, re-enabling the tasks
  still produced TWO daemons racing (health none). #397 (StillBootingError 30s
  grace) does NOT fully prevent the duplicate — two near-simultaneous launches
  both acquire before either writes a healthy lock state. This is a DEEPER
  instance-lock issue than #397. Standalone (one launcher) is rock-solid.

## THE REAL OPEN BUG (bigger than #396/#397)

Two scheduled tasks (keepalive PT5M + watchdog PT3M) + reinstall's own start
can launch daemons close enough that instance-lock lets BOTH proceed →
2 daemons → EADDRINUSE churn / health-none. #397's grace only helps when the
2nd launch sees the 1st's lock; near-simultaneous launches slip through.
NEXT: #398 (bind-port-early + readiness gate) is the durable fix; ALSO the
instance-lock needs to serialize near-simultaneous acquisitions (a real
exclusive lock at acquire, not just health-probe-based zombie detection).
File this as a new P0 if not covered by #398.

## LoCoMo — running overnight

- Full suite: 10 conversations / 1986 QA, qwen3:8b extraction, conversational,
  dual-pass, k=10, seed 42, 8h distill timeout. PID 221068 (nohup detached).
  run-dir `.eval-data/locomo/runs/overnight-qwen38b`, own daemon :64215.
  Log: %TEMP%/locomo-overnight.log. Resumable: re-run same cmd with --run-dir
  if the orchestrator dies (FEAT-462). Verdict vs 0.5549 codex baseline decides
  the (still-parked) local-extraction flip. Ollama is free for it (prod=codex).

## RELEASE — blocked

- v0.19.0 blocked on: (1) #397 can't merge — `cross-repo-roundtrip` FAILS ON
  MAIN (CI-infra, not #397); blocks the whole merge queue. (2) the deeper
  instance-lock 2-daemon bug above. Fix cross-repo-roundtrip first (likely
  @astragenie scope/plugin-install flake or real contract drift), then #397
  merges, then the instance-lock fix, then soak, then tag.

## Merged today: waves 1-3 (#376/381,377/380/383,378/382,379/384,388,390/391,393,394,395), #392, +cleanup. #396/#397 built (397 stuck on CI). Filed: #396,#398,#535(Ingestions page),#389. Local-extraction flip PARKED (distill-slowness real; FEAT-534 hybrid is the interim).

## Config TEMP states to unwind: shim clean (reinstall reset it), tasks disabled (re-enable after instance-lock fix), ASTRA_SKIP_CONSOLIDATE=1 env+process (remove after), compaction/extraction on codex (flip local after distill-slowness track).
