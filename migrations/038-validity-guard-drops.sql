-- 038: validity_guard_drops — counts extracted valid_at/invalid_at bounds that
-- the write-path guard REFUSED to persist.
--
-- Why this table exists (issue #205 follow-up, 2026-07-13):
--
-- PR #216 wired the model's extracted `invalid_at` straight into the
-- bitemporal `memories.valid_to` column with NO validation whatsoever:
--
--     invalid_at: z.string().optional()          -- not a date. any string.
--     valid_to:   parseIsoToMs(mem.invalid_at)   -- Date.parse. accepts "9999".
--
-- A `valid_to` in the past makes the atom invisible to every default recall.
-- So a single hallucinated date — one bad token from a 7B model — permanently
-- and SILENTLY deletes a real memory from search. The row is still on disk, the
-- write reported success, no error fired, and no canary went red. That is the
-- exact success-and-silent-failure-look-identical class ADR-015 exists to kill,
-- shipped inside the fix for a bitemporal-correctness bug.
--
-- The guard (src/distill/stages/08-embed-index.ts) now REJECTS an implausible
-- bound and keeps the atom unbounded instead. That choice is deliberate and the
-- asymmetry drives it:
--
--   * a false ACCEPT leaves one atom with a slightly wrong validity window;
--   * a false REJECT — or an unbounded bad date — makes a REAL FACT
--     PERMANENTLY UNRETRIEVABLE with no error.
--
-- So when in doubt: keep the atom, drop the BOUND. Never the atom.
--
-- But a guard that silently discards is just a quieter version of the same bug.
-- Per ADR-015, a canary must measure the RATE of a failure, not the EXISTENCE
-- of a success — so every rejected bound is counted HERE, by reason, and the
-- doctor "Atom validity extraction" check reads it. That is what tells apart
-- "the model states no end dates" (a real zero) from "the model states end
-- dates and every one of them is garbage" (a broken zero).
--
-- Same reason/count/session_id/created_at shape as relation_guard_drops (029)
-- and entity_name_drops (034) — deliberately, so the three guard-drop canaries
-- stay readable as one family.

CREATE TABLE IF NOT EXISTS validity_guard_drops (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  reason     TEXT    NOT NULL,
  count      INTEGER NOT NULL,
  session_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_validity_guard_drops_created_at
  ON validity_guard_drops (created_at DESC);
