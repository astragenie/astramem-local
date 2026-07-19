-- 053: evidence-gated sweeper guard-drop log + per-job run log (FEAT-551).
--
-- Two tables, mirroring migration 052 (triage_guard_drops/triage_run_log)
-- field-for-field for the same reason:
--
--   evidence_gate_drops -- one row per non-zero drop reason
--   ('no-evidence-field' | 'evidence-not-found') the stage-8 admission gate
--   (src/distill/stages/08-embed-index.ts, src/distill/evidence-gate.ts)
--   recorded for a completed embedAndIndex call. Reason + count only, same
--   discipline as evidence_guard_drops (migration 030) and its siblings --
--   never the raw atom text.
--
--   evidence_gate_run_log -- one row per embedAndIndex call where the gate
--   actually evaluated at least one passB atom, recording
--   atoms_attempted/atoms_dropped. Without this denominator,
--   evidence_gate_drops alone can never answer "what fraction of passB
--   atoms were rejected" (canary-must-measure-rate-not-existence) -- 2
--   drops out of 2 attempted and 2 drops out of 2000 attempted are wildly
--   different signals that look identical as a raw drop count. FEAT-551's
--   own AC-5 LoCoMo A/B measurement lane reads this table for its
--   gate-drop-rate; a future doctor canary can reuse it the same way
--   triage_run_log's is reused for the "Atom triage" canary.
CREATE TABLE evidence_gate_drops (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reason TEXT NOT NULL,
  count INTEGER NOT NULL,
  session_id TEXT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_evidence_gate_drops_created ON evidence_gate_drops(created_at DESC);
CREATE INDEX idx_evidence_gate_drops_reason ON evidence_gate_drops(reason, created_at DESC);

CREATE TABLE evidence_gate_run_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NULL,
  atoms_attempted INTEGER NOT NULL,
  atoms_dropped INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_evidence_gate_run_log_created ON evidence_gate_run_log(created_at DESC);
