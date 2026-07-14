-- 047: pipeline handler run-log (FEAT-495 item 4a).
--
-- One append-only row per job-handler invocation (distill / distill-events /
-- consolidate / cleanup / reembed — src/pipeline/worker.ts's tick loop,
-- HandlerRegistry.registeredKinds()), recorded by
-- src/storage/handler-run-log.ts and written by worker.ts at each terminal
-- outcome of a handler.handle() call: success, thrown error (with the same
-- deterministic/transient classification classifyError() already produces),
-- or budget-paused.
--
-- Exists to make two failure shapes doctor-visible that are otherwise
-- invisible until an operator notices missing memories: "built, wired, never
-- invoked" (a registered handler kind with zero rows ever, or none in a long
-- time — e.g. reembed only runs when explicitly triggered) and "silently
-- failing every run" (a handler whose last N rows are all `failed`, which
-- currently only shows up as a growing poison-job count with no per-handler
-- breakdown). Same append-only, one-row-per-event shape as
-- consolidation_judge_runs (030) / extraction_yield (042).
CREATE TABLE handler_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  handler TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('success', 'failed', 'paused')),
  duration_ms INTEGER NOT NULL,
  error_type TEXT,
  error_message TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_handler_runs_handler_created ON handler_runs(handler, created_at DESC);
