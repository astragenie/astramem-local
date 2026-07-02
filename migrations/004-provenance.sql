-- AM-1: persist stage-5 extraction evidence (provenance receipts).
-- Nullable: rows created before v0.4.0 have no evidence — why_memory
-- degrades gracefully. See design doc 2026-07-02 §2/§3.
ALTER TABLE memories ADD COLUMN evidence TEXT;
