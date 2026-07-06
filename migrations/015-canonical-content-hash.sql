-- 015: canonical-content-hash -- recompute 32-char truncated content hashes
-- to the full 64-char sha256 hex digest (astramem-local#84).
--
-- src/server/routes/search.ts (POST /remember), src/mcp/server.ts (the
-- `remember` MCP tool), and src/memory-tool/adapter.ts (create/insert +
-- str_replace) used to truncate the sha256 hex digest to the first 32
-- characters before storing it as memories.hash / memory_events.content_hash.
-- The daemon's own sync-envelope.v1 schema requires content_hash to match
-- ^[a-f0-9]{64}$ -- a full, untruncated digest (see
-- contracts/schemas/sync-envelope.v1.schema.json) -- so the daemon was
-- shipping wire payloads that violated its own contract, which forced a
-- temporary cloud-side constraint relax (astragenie/memory#619, #620,
-- traced in astragenie/astramem-local#84). Every OTHER hash producer (the
-- distill pipeline's stage 6 reduce.ts / stage 7 memory-normalize.ts
-- computeHash) already emitted the full 64-char digest, so only rows
-- inserted through the three legacy call sites need repair -- identified
-- unambiguously by `length(hash) = 32` (a full 64-char digest cannot
-- collide down to exactly 32 hex characters by chance, and no other
-- producer in this codebase has ever emitted a 32-char memories.hash).
--
-- The recompute uses sha256_hex(text) -- a custom SQL function registered
-- by src/storage/migrate.ts (crypto.createHash('sha256').update(text,
-- 'utf8').digest('hex')) -- over the SAME memories.text value the original
-- (buggy) call sites hashed. That means the leading 32 hex characters
-- produced here are IDENTICAL to what is already stored; this migration
-- only EXTENDS the digest to 64 characters, it never changes what a row's
-- hash prefix already was. The dedup key (the UNIQUE index on
-- memories.hash) therefore keeps matching exactly the same set of "same
-- content" rows it did before -- no new collisions are introduced, and any
-- prior 32-char-prefix collision between two DIFFERENT texts (theoretically
-- possible at 128 bits of entropy, never observed) is not reconstructible
-- after the fact either way -- that risk was baked in before this migration
-- ever runs, not created by it.
--
-- memory_events.content_hash is then re-synced from the (now 64-char)
-- memories.hash for the corresponding atom_id, mirroring the same
-- mirroring rule migration 007's initial backfill established (content_hash
-- always equals the owning memory's own hash column at write time). An
-- 'erase_request' tombstone event for an atom hard-deleted BEFORE this
-- migration runs has no surviving memories row to re-derive a hash from, so
-- a 32-char content_hash on such an orphaned tombstone is left as-is --
-- there is no text left to recompute a full hash over. This is not a
-- functional regression: stage 8 embed-index's isErasedHash() replay filter
-- only ever queries with hashes produced by the distill pipeline's own
-- computeHash() (always 64-char, hashed over NORMALIZED text -- a different
-- hash domain entirely from the /remember-family call sites), so those
-- orphaned tombstones were never reachable through that lookup either
-- before or after this migration.

UPDATE memories SET hash = sha256_hex(text) WHERE length(hash) = 32;

UPDATE memory_events
SET content_hash = (SELECT m.hash FROM memories m WHERE m.id = memory_events.atom_id)
WHERE length(content_hash) = 32
  AND atom_id IN (SELECT id FROM memories);
