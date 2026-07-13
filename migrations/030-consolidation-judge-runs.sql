-- 030: contradiction-judge run telemetry (FEAT-482).
--
-- The judge's cost cannot be metered in dollars -- both shipped LLM
-- providers (Ollama, codex-subscription) hardcode `usage.usd: 0` (Ollama is
-- free; codex-subscription is ChatGPT-subscription metered, not per-token --
-- see doctor's "Budget cap vs codex-subscription" check, which already flags
-- this exact blind spot for distill/extraction). A dollar cap compared
-- against an always-0 estimate can never trip, so `runConsolidation`
-- (src/consolidate/consolidate.ts) instead bounds the judge sweep by CALL
-- COUNT (`maxPerRun`) and WALL-CLOCK TIME (`maxWallClockMs`) -- see that
-- file's FEAT-482 comments for the incident this exists to prevent.
--
-- This table makes the actual cost VISIBLE instead of capped in a currency
-- that can't see it: one append-only row per `runConsolidation()` call where
-- contradiction detection was active (mode != 'off'), written by
-- `recordConsolidationJudgeRun` (src/storage/consolidation-judge-log.ts).
-- `doctor` (src/doctor/checks.ts) reads the most recent row so an operator
-- who later points extraction at a genuinely metered provider has a number
-- to look at, not a silent gate.
CREATE TABLE consolidation_judge_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mode TEXT NOT NULL,
  judge_calls INTEGER NOT NULL,
  elapsed_ms INTEGER NOT NULL,
  cap_reached INTEGER NOT NULL,
  wall_clock_cap_reached INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_consolidation_judge_runs_created ON consolidation_judge_runs(created_at DESC);
