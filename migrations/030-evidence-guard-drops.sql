-- 030: evidence-requirement guard-drop counters (FEAT-485).
--
-- Counts + reasons only -- never the raw atom text -- same discipline as
-- relation_guard_drops (029-relation-guard-drops.sql), which this table
-- mirrors field-for-field (reason/count/session_id/created_at), one level up:
-- a whole ATOM dropped, not a relation triple within one.
--
-- Written from one guard point: src/distill/stages/05-extract.ts's
-- requireEvidenceForRichTypes -- a `lesson`/`decision` atom with no non-empty
-- `evidence` string never reaches stage 8 at all (dropped, not failed --
-- same idiom as filterAtomRelations).
--
-- Exists so the doctor "Evidence provenance" canary (src/doctor/checks.ts)
-- can tell apart two failure modes that look identical from `memories` alone
-- (low/zero evidence population on lesson/decision rows either way):
--   - the model never emits evidence for lesson/decision atoms at all (rows
--     from BEFORE this FEAT still land with evidence=NULL, since the
--     requirement is enforced only from this migration forward -- 0 drops
--     recorded, because there was nothing to drop yet)
--   - the model emits lesson/decision atoms but omits evidence, and the new
--     guard is actively dropping them (drops > 0) -- a visible, measurable
--     quality signal that didn't exist before this FEAT
CREATE TABLE evidence_guard_drops (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reason TEXT NOT NULL,
  count INTEGER NOT NULL,
  session_id TEXT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_evidence_guard_drops_created ON evidence_guard_drops(created_at DESC);
CREATE INDEX idx_evidence_guard_drops_reason ON evidence_guard_drops(reason, created_at DESC);
