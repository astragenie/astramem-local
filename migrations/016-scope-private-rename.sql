-- 016: scope-private-rename (U7-local astramem-local#110, DEC-048) — rename
-- the ADR-009 scope enum value 'personal' -> 'private'. Canonical local scope
-- taxonomy is now private/team/org; team/org are UNCHANGED. Data-preserving:
-- migrations/006-atom-v3.sql never added a CHECK constraint on
-- memories.scope, so this is a plain data UPDATE, not schema/DDL surgery.
--
-- ADR-009 invariant (the shipper never ships personal/private atoms) needs no
-- change here — src/sync/shipper.ts's listUnsynced()/countUnsynced() filter
-- is an INCLUSION list (`scope IN ('team','org')`), not an exclusion of the
-- old name, so the "never ships outside team/org" guarantee holds for the
-- renamed value automatically. See tests/sync/shipper.test.ts.
--
-- memory_events.payload_json carries a duplicated top-level `scope` key in
-- `create` event payloads (src/storage/memories.ts insertWithCreateEvent)
-- and `erase_request` tombstones (src/storage/memory-events.ts erase()) —
-- both get the literal string swapped via json_set so a replayed/synced
-- event never re-introduces 'personal' downstream. `promote_scope` events'
-- payload keys are `from`/`to`, not `scope` — intentionally left as
-- historical record of the transition as it was recorded at the time (AC-1
-- only asks for `$.scope` occurrences).
--
-- One-release alias: the daemon still ACCEPTS inbound 'personal' on
-- POST /memory/:id/promote from older clients/plugins and normalizes it to
-- 'private' before it reaches storage (src/contracts/memory.ts
-- normalizeScopeAlias(), wired at src/server/routes/lifecycle.ts's
-- PromoteBodySchema). TODO(remove-personal-alias): drop the alias, this
-- migration's role as a one-time catch-up, and the wire schemas' additive
-- 'personal' enum value in the release AFTER this one — tracked in
-- astramem-local#115.

UPDATE memories SET scope = 'private' WHERE scope = 'personal';

UPDATE memory_events
SET payload_json = json_set(payload_json, '$.scope', 'private')
WHERE payload_json IS NOT NULL
  AND json_extract(payload_json, '$.scope') = 'personal';
