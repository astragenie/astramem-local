-- 052: LLM atom-triage guard-drop log + per-job triage run log (FEAT-533).
--
-- Two tables in one migration, serving two distinct observability needs:
--
--   triage_guard_drops -- one row per non-'keep' verdict the LLM atom-triage
--   tier (src/distill/atom-triage.ts) returns for a candidate atom, at the
--   embedAndIndex insertion point (src/distill/stages/08-embed-index.ts) --
--   the same choke point durability_gate's regex taxonomy runs at, one tier
--   further in. Mirrors evidence_guard_drops (migration 030) in spirit --
--   reason + session_id + created_at -- but ALSO carries memory_id/model/
--   confidence per row (unlike the count-only guard-drop tables) because
--   this FEAT's acceptance criteria require recovering which atom got which
--   verdict from which model at what confidence, for the manually reviewed
--   dry-run agreement sample this FEAT's own eval gate depends on before
--   'enabled' mode is ever shipped as a default. memory_id is NULL when the
--   atom was actually dropped (mode 'enabled' -- the row was never
--   inserted, so there is no id to record) and set when the atom persisted
--   anyway (mode 'dry-run' -- the whole point of dry-run is "verdict
--   recorded, atom kept").
--
--   triage_run_log -- one row per embedAndIndex call where triage actually
--   ran (mode != 'off'), recording atoms_triaged/atoms_dropped counts.
--   Mirrors extraction_yield (migration 042) field-for-field: without a
--   TOTAL-triaged denominator, triage_guard_drops alone can never answer
--   "what fraction of atoms were flagged" (canary-must-measure-rate-not-
--   existence) -- 5 drops out of 10 triaged and 5 drops out of 5000 triaged
--   are wildly different signals that look identical as a raw drop count.
--   The doctor "Atom triage" canary reads THIS table for its rate, not
--   triage_guard_drops -- and it alarms on BOTH extremes (near-zero rate in
--   'enabled' mode == built-wired-never-invoked, and a >50% rate == judge
--   gone rogue / model-swap regression), per FEAT-533's acceptance criteria.
CREATE TABLE triage_guard_drops (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reason TEXT NOT NULL,
  memory_id TEXT NULL,
  model TEXT NOT NULL,
  confidence REAL NOT NULL,
  mode TEXT NOT NULL,
  session_id TEXT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_triage_guard_drops_created ON triage_guard_drops(created_at DESC);
CREATE INDEX idx_triage_guard_drops_reason ON triage_guard_drops(reason, created_at DESC);

CREATE TABLE triage_run_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NULL,
  atoms_triaged INTEGER NOT NULL,
  atoms_dropped INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_triage_run_log_created ON triage_run_log(created_at DESC);
